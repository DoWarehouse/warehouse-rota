import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRotaServer, scheduledMinutes } from '../server.mjs';
import { normalizeAvailability, isShiftAvailable } from '../public/availability.js';

const weekly = entries => ({ days: Array.from({ length: 7 }, (_, index) => entries[index] || { mode: 'unavailable' }) });
const times = (start, end) => ({ mode: 'times', start, end });
const work = (date, start_time, end_time) => ({ date, start_time, end_time, kind: 'work' });

test('Availability checks full shifts, boundaries, overnight carry-over and week rollover', () => {
  const available = weekly({ 0: times('08:00', '16:30'), 1: { mode: 'all_day' }, 6: times('22:00', '06:00') });
  assert.equal(isShiftAvailable(available, work('2026-10-05', '08:00', '16:30')), true);
  assert.equal(isShiftAvailable(available, work('2026-10-05', '07:59', '16:30')), false);
  assert.equal(isShiftAvailable(available, work('2026-10-05', '08:00', '16:31')), false);
  assert.equal(isShiftAvailable(available, work('2026-10-05', '02:00', '06:00')), true, 'Sunday night carries into Monday');
  assert.equal(isShiftAvailable(available, work('2026-10-05', '05:00', '09:00')), false, 'A gap cannot be treated as available');
  assert.equal(isShiftAvailable(available, work('2026-10-06', '22:00', '02:00')), false, 'Tuesday all day does not include unavailable Wednesday');
  assert.equal(isShiftAvailable(weekly({ 0: times('22:00', '06:00') }), work('2026-10-05', '23:00', '05:00')), true);
  assert.equal(isShiftAvailable(weekly({ 0: times('22:00', '06:00') }), work('2026-10-06', '03:00', '06:00')), true);
  assert.equal(isShiftAvailable(weekly({ 0: { mode: 'all_day' }, 1: times('00:00', '06:00') }), work('2026-10-05', '22:00', '06:00')), true);
  assert.equal(isShiftAvailable(weekly({}), { ...work('2026-10-05', '08:00', '16:30'), kind: 'holiday' }), true);
  assert.equal(isShiftAvailable(null, work('2026-10-05', '08:00', '16:30')), true, 'Unset availability leaves existing scheduling unchanged');
});

test('Availability input rejects incomplete weeks, invalid times and equal times', () => {
  assert.equal(normalizeAvailability(null), null);
  assert.throws(() => normalizeAvailability({ days: [] }), /seven days/);
  assert.throws(() => normalizeAvailability(weekly({ 0: times('25:00', '17:00') })), /Monday/);
  assert.throws(() => normalizeAvailability(weekly({ 0: times('08:00', '08:00') })), /different/);
  assert.throws(() => normalizeAvailability(weekly({ 0: { mode: 'unknown' } })), /Monday/);
});

test('Profiles, warnings, automatic filling, publishing and persistence', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rota-availability-tests-'));
  let app = createRotaServer({ dataDir: directory, password: 'availability-test-password', seedExamples: false });
  let base, cookie = '', revision = 0;
  const listen = async () => { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; };
  await listen();
  const week = '2026-10-05', loc = app.db.prepare('SELECT * FROM locations').get();
  const request = async (endpoint, body, method = body ? 'POST' : 'GET', authenticated = true) => {
    const response = await fetch(base + endpoint, { method, headers: { ...(authenticated ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Rota-Request': '1', 'If-Match': String(revision) } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const data = await response.json(); if (response.ok && data.revision !== undefined) revision = data.revision;
    return { status: response.status, data, response };
  };
  let personId, patternId, outsideId;
  const personFields = { name: 'Avery Availability', location_id: loc.id, default_department: 'Picking', default_warehouse: 'Warehouse 1', contract_hours: 16 };
  const shiftFields = { location_id: loc.id, department: 'Picking', warehouse: 'Warehouse 1', start_time: '08:00', end_time: '16:30', break_minutes: 30, kind: 'work', label: 'B2B' };
  try {
    const login = await request('/api/login', { password: 'availability-test-password' }); cookie = login.response.headers.get('set-cookie').split(';')[0];
    await request(`/api/state?week=${week}`);
    await t.test('Profile settings save, survive unrelated edits and reject invalid input', async () => {
      patternId = (await request('/api/templates', { name: 'Standard day', start_time: '08:00', end_time: '16:30', break_minutes: 30, break_start: '12:00' })).data.id;
      personId = (await request('/api/people', { ...personFields, preferred_template_id: patternId, availability: weekly({ 0: times('08:00', '16:30'), 1: times('08:00', '16:30'), 2: times('10:00', '16:30'), 3: { mode: 'all_day' }, 4: times('08:00', '16:30') }) })).data.id;
      await request(`/api/people/${personId}`, { ...personFields, role: 'Updated role' }, 'PUT');
      const p = (await request(`/api/state?week=${week}`)).data.people[0];
      assert.equal(p.availability.days[0].start, '08:00'); assert.equal(p.preferred_template_id, patternId); assert.equal(p.default_warehouse, 'Warehouse 1');
      assert.equal((await request(`/api/people/${personId}`, { ...personFields, availability: weekly({ 0: times('bad', '17:00') }) }, 'PUT')).status, 400);
      assert.equal((await request(`/api/people/${personId}`, { ...personFields, preferred_template_id: 'missing' }, 'PUT')).status, 400);
    });
    await t.test('Manual and moved shifts require an availability override; cancellation keeps the original', async () => {
      const outside = await request('/api/shifts', { ...shiftFields, person_id: personId, date: week, start_time: '07:00' });
      assert.equal(outside.status, 422); assert.equal(outside.data.code, 'availability_warning'); assert.match(outside.data.warnings[0].message, /Avery.*07:00.*08:00/);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n, 0);
      outsideId = (await request('/api/shifts', { ...shiftFields, person_id: personId, date: week, start_time: '07:00', override_availability: true })).data.id;
      const moved = await request(`/api/shifts/${outsideId}`, { ...shiftFields, person_id: personId, date: '2026-10-10' }, 'PUT');
      assert.equal(moved.data.code, 'availability_warning'); assert.equal(app.db.prepare('SELECT date FROM shifts WHERE id = ?').get(outsideId).date, week);
      const overlap = await request('/api/shifts', { ...shiftFields, person_id: personId, date: week, override_availability: true });
      assert.equal(overlap.status, 422); assert.equal(overlap.data.code, undefined, 'Availability override does not bypass overlapping shifts');
      await request(`/api/shifts/${outsideId}`, {}, 'DELETE');
    });
    await t.test('Availability-only edits keep profile details and reject malformed data without saving', async () => {
      const before = (await request(`/api/state?week=${week}`)).data.people[0];
      assert.equal((await request(`/api/people/${personId}/availability`, { availability: before.availability }, 'PUT')).status, 200);
      const after = (await request(`/api/state?week=${week}`)).data.people[0];
      assert.deepEqual(after, before);
      const oldRevision = revision;
      assert.equal((await request(`/api/people/${personId}/availability`, { availability: { days: [] } }, 'PUT')).status, 400);
      assert.equal(revision, oldRevision);
    });
    await t.test('Bulk warnings roll back every shift and an explicit override saves them all', async () => {
      const bulk = { ...shiftFields, person_ids: [personId], dates: [week, '2026-10-07'] };
      const warned = await request('/api/shifts/bulk', bulk);
      assert.equal(warned.data.code, 'availability_warning'); assert.equal(warned.data.warnings.length, 1);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n, 0);
      assert.equal((await request('/api/shifts/bulk', { ...bulk, override_availability: true })).data.created, 2);
      await request('/api/shifts/clear', { location_id: loc.id, scope: 'week', week, confirm: true });
    });
    await t.test('Preview is read only and autofill respects availability, patterns, contracts and privacy', async () => {
      const body = { location_id: loc.id, week, person_ids: [personId], dates: [week, '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'] };
      const params = new URLSearchParams({ locationId: loc.id, week, people: personId, dates: body.dates.join(',') });
      const before = revision;
      const preview = await request(`/api/weeks/availability-plan?${params}`);
      assert.equal(preview.data.revision, before); assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n, 0);
      assert.deepEqual(preview.data.shifts.map(s => s.date), [week, '2026-10-06']); assert.equal(preview.data.total_minutes, 960);
      assert.ok(preview.data.skipped.some(s => s.reason === 'Shift pattern is outside availability'));
      assert.ok(preview.data.skipped.some(s => s.reason === 'Would exceed contracted weekly hours'));
      assert.ok(preview.data.skipped.some(s => s.reason === 'Unavailable'));
      const created = await request('/api/weeks/populate', body); assert.equal(created.data.created, 2);
      assert.equal((await request('/api/weeks/populate', body)).data.created, 0, 'Repeated fill does not duplicate shifts');
      assert.equal((await request(`/api/public/${loc.share_token}?week=${week}`, undefined, 'GET', false)).data.unpublished, true);
      await request('/api/publish', { location_id: loc.id, week });
      const shared = (await request(`/api/public/${loc.share_token}?week=${week}`, undefined, 'GET', false)).data;
      assert.equal(shared.shifts.length, 2); assert.equal(shared.people[0].availability, undefined); assert.equal(shared.people[0].preferred_template_id, undefined); assert.equal(shared.people[0].default_warehouse, undefined);
      assert.equal((await request(`/api/weeks/availability-plan?${params}`, undefined, 'GET', false)).status, 401);
      assert.equal((await request('/api/weeks/populate', body, 'POST', false)).status, 401);
    });
    await t.test('Available windows supply shift times and timed breaks; absences and overnight conflicts are preserved', async () => {
      await request(`/api/people/${personId}`, { ...personFields, contract_hours: 0, preferred_template_id: null, availability: weekly({ 0: times('09:00', '15:00'), 1: times('22:00', '06:00'), 2: times('05:00', '10:00'), 3: { mode: 'all_day' }, 4: times('09:00', '15:00') }) }, 'PUT');
      const next = '2026-10-12';
      await request('/api/shifts', { person_id: personId, location_id: loc.id, date: '2026-10-16', kind: 'holiday' });
      const filled = await request('/api/weeks/populate', { location_id: loc.id, week: next, person_ids: [personId], dates: [next, '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'], break_minutes: 30 });
      assert.equal(filled.data.created, 2); assert.ok(filled.data.skipped.some(s => s.reason.includes('Overlaps'))); assert.ok(filled.data.skipped.some(s => s.reason.includes('All-day'))); assert.ok(filled.data.skipped.some(s => s.reason.includes('Already')));
      const saved = app.db.prepare('SELECT * FROM shifts WHERE person_id = ? AND date = ?').get(personId, next);
      assert.equal(saved.start_time, '09:00'); assert.equal(saved.end_time, '15:00'); assert.equal(saved.break_start, '11:45'); assert.equal(scheduledMinutes(saved), 330);
      assert.equal(app.db.prepare("SELECT kind FROM shifts WHERE date = '2026-10-16'").get().kind, 'holiday');
      const publicWeek = (await request(`/api/public/${loc.share_token}?week=${week}`, undefined, 'GET', false)).data;
      assert.equal(publicWeek.shifts.length, 2, 'Published snapshots remain unchanged by profile edits');
      await request(`/api/people/${personId}`, { ...personFields, preferred_template_id: patternId }, 'PUT');
      await request(`/api/templates/${patternId}`, {}, 'DELETE');
      assert.equal((await request(`/api/state?week=${week}`)).data.people[0].preferred_template_id, null);
    });
    await t.test('Copy last week skips shifts that no longer fit saved availability', async () => {
      await request(`/api/people/${personId}`, { ...personFields, availability: weekly({ 0: times('10:00', '15:00') }) }, 'PUT');
      const copied = await request('/api/weeks/copy', { location_id: loc.id, week: '2026-10-19' });
      assert.equal(copied.data.copied, 1, 'Holiday still copies'); assert.equal(copied.data.availability_skipped, 2);
    });
    await t.test('Availability and assignments survive a restart', async () => {
      await app.close(); app = createRotaServer({ dataDir: directory, password: 'availability-test-password', seedExamples: false }); await listen();
      const saved = (await request(`/api/state?week=${week}`)).data;
      assert.equal(saved.people[0].availability.days[0].start, '10:00'); assert.equal(saved.people[0].default_warehouse, 'Warehouse 1'); assert.equal(saved.shifts.length, 2);
    });
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Schema 4 upgrade backs up data and preserves profiles, shifts, attendance, targets and published copies', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rota-availability-migration-'));
  let app = createRotaServer({ dataDir: directory, password: 'migration-test-password' });
  try {
    const p = app.db.prepare('SELECT * FROM people LIMIT 1').get(), loc = app.db.prepare('SELECT * FROM locations').get();
    app.db.prepare("INSERT INTO shifts (id,person_id,location_id,date,kind,label,colour,department,warehouse,start_time,end_time,break_minutes,note) VALUES ('saved',?,?,'2026-10-05','work','B2B','blue','Picking','Warehouse 2','08:00','16:30',30,'Private')").run(p.id, loc.id);
    app.db.prepare("INSERT INTO attendance (person_id,location_id,date,status,marked_at) VALUES (?,?,'2026-10-05','no_show','2026-10-05T08:00:00Z')").run(p.id, loc.id);
    app.db.prepare("INSERT INTO day_plans VALUES (?,'2026-10-05',NULL,480)").run(loc.id);
    const snapshot = JSON.stringify(app.snapshot(loc.id, '2026-10-05'));
    app.db.prepare("INSERT INTO publications VALUES (?,'2026-10-05',?,'2026-10-05T08:00:00Z')").run(loc.id, snapshot);
    app.db.exec("DROP TABLE leave_accounts; ALTER TABLE attendance DROP COLUMN arrival_time; ALTER TABLE attendance DROP COLUMN arrival_date; ALTER TABLE attendance DROP COLUMN is_late; ALTER TABLE attendance DROP COLUMN late_minutes; ALTER TABLE shifts DROP COLUMN holiday_minutes; ALTER TABLE shifts DROP COLUMN holiday_approved; ALTER TABLE people DROP COLUMN availability; ALTER TABLE people DROP COLUMN default_warehouse; ALTER TABLE people DROP COLUMN preferred_template_id; UPDATE meta SET value='4' WHERE key='schema_version'");
    await app.close(); app = createRotaServer({ dataDir: directory, password: 'migration-test-password' });
    assert.equal(app.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '6');
    assert.ok(existsSync(path.join(directory, 'backups', 'rota-before-schema-5.sqlite')));
    assert.equal(app.db.prepare('SELECT availability FROM people WHERE id = ?').get(p.id).availability, 'null');
    assert.equal(app.db.prepare('SELECT label FROM shifts').get().label, 'B2B'); assert.equal(app.db.prepare('SELECT status FROM attendance').get().status, 'no_show');
    assert.equal(app.db.prepare('SELECT requirement_minutes FROM day_plans').get().requirement_minutes, 480); assert.equal(app.db.prepare('SELECT snapshot FROM publications').get().snapshot, snapshot);
    const revision = app.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value;
    await app.close(); app = createRotaServer({ dataDir: directory, password: 'migration-test-password' });
    assert.equal(app.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value, revision, 'Migration runs once');
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
