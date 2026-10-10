import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRotaServer, today, monday, addDays, scheduledMinutes } from '../server.mjs';
import { managerDaySummary, arrivalDetails } from '../public/manager-tools.js';
import { hasAvailabilityOnDate } from '../public/availability.js';
import { holidayBalance } from '../lib/holiday.mjs';

const weekly = entries => ({ days: Array.from({ length: 7 }, (_, index) => entries[index] || { mode: 'unavailable' }) });
async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'rota-manager-tools-'));
  const options = { dataDir: directory, password: 'manager-tools-test-password', seedExamples: false };
  let app = createRotaServer(options), base, cookie = '', revision;
  const listen = async () => { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; };
  await listen();
  const request = async (endpoint, body, method = body ? 'POST' : 'GET', authenticated = true, match = revision) => {
    const response = await fetch(base + endpoint, { method, headers: { ...(authenticated ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Rota-Request': '1', 'If-Match': String(match) } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const data = await response.json(); if (response.ok && data.revision !== undefined) revision = data.revision;
    return { status: response.status, data, response };
  };
  cookie = (await request('/api/login', { password: options.password })).response.headers.get('set-cookie').split(';')[0];
  await request('/api/state');
  const loc = app.db.prepare('SELECT * FROM locations').get();
  const person = async (name, extra = {}) => {
    const body = { name, location_id: loc.id, default_department: 'Picking', contract_hours: 40, ...extra };
    const result = await request('/api/people', body); assert.equal(result.status, 200);
    return { id: result.data.id, body };
  };
  const shift = async (personId, date, extra = {}) => {
    const result = await request('/api/shifts', { person_id: personId, location_id: loc.id, date, kind: 'work', start_time: '08:00', end_time: '16:30', break_minutes: 30, break_start: '12:00', department: 'Picking', warehouse: 'Warehouse 1', ...extra });
    assert.equal(result.status, 200, result.data.error); return result.data.id;
  };
  return { request, person, shift, loc, get app() { return app; }, get revision() { return revision; }, directory,
    restart: async () => { await app.close(); app = createRotaServer(options); await listen(); },
    close: async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); }
  };
}

test('Day copying previews conflicts, preserves assignment fields and keeps daily records private', async t => {
  const f = await fixture(), source = monday(addDays(today(), -7)), target = addDays(source, 1);
  try {
    const a = await f.person('Avery Split'), b = await f.person('Blake Available', { availability: weekly({ 0: { mode: 'all_day' } }) }), c = await f.person('Casey Holiday'), d = await f.person('Drew Archive'), e = await f.person('Ellis Overnight');
    await f.shift(a.id, source, { end_time: '12:00', break_minutes: 15, break_start: '10:00', department: 'Engraving', warehouse: 'Warehouse 2', label: 'B2B', note: 'Private copying note' });
    await f.shift(a.id, source, { start_time: '12:00', break_start: '14:00', department: 'Packing', kind: 'training' });
    await f.shift(b.id, source); await f.shift(c.id, source); await f.shift(d.id, source);
    await f.shift(e.id, source, { start_time: '22:00', end_time: '06:00', break_start: '02:00' });
    await f.shift(e.id, addDays(target, 1), { start_time: '05:00', end_time: '10:00', break_start: '08:00' });
    await f.shift(c.id, target, { kind: 'holiday' });
    await f.request(`/api/people/${d.id}`, { ...d.body, active: false }, 'PUT');
    await f.request('/api/attendance', { person_id: a.id, location_id: f.loc.id, date: source, status: 'no_show' });
    await f.request('/api/day-plans', { location_id: f.loc.id, date: target, requirement_hours: 100 });
    await f.request('/api/publish', { location_id: f.loc.id, week: source });
    const published = (await f.request(`/api/public/${f.loc.share_token}?week=${source}`, undefined, 'GET', false)).data;
    const params = new URLSearchParams({ locationId: f.loc.id, sourceDate: source, targetDate: target });
    const body = { location_id: f.loc.id, source_date: source, target_date: target };
    await t.test('Preview is read-only and reports overlap, archive and availability reasons', async () => {
      const before = f.revision, count = f.app.db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n;
      const plan = await f.request(`/api/days/copy-plan?${params}`);
      assert.equal(plan.status, 200); assert.equal(plan.data.revision, before); assert.equal(plan.data.source_count, 6); assert.equal(plan.data.shifts.length, 2); assert.equal(plan.data.skipped.length, 4);
      assert.ok(plan.data.skipped.some(s => /availability/.test(s.reason))); assert.ok(plan.data.skipped.some(s => /archived/.test(s.reason))); assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n, count);
      assert.equal((await f.request(`/api/days/copy-plan?${params}`, undefined, 'GET', false)).status, 401);
    });
    await t.test('Copy keeps both split assignments, labels, timed breaks and notes but not attendance or targets', async () => {
      const result = await f.request('/api/days/copy', body); assert.equal(result.data.copied, 2);
      const shifts = f.app.db.prepare('SELECT * FROM shifts WHERE person_id=? AND date=? ORDER BY start_time').all(a.id, target);
      assert.equal(shifts[0].label, 'B2B'); assert.equal(shifts[0].department, 'Engraving'); assert.equal(shifts[0].warehouse, 'Warehouse 2'); assert.equal(shifts[0].break_start, '10:00'); assert.equal(shifts[0].note, 'Private copying note'); assert.equal(shifts[1].kind, 'training');
      assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE date=?').get(target).n, 0); assert.equal(f.app.db.prepare('SELECT requirement_minutes FROM day_plans WHERE date=?').get(target).requirement_minutes, 6000);
      assert.deepEqual((await f.request(`/api/public/${f.loc.share_token}?week=${source}`, undefined, 'GET', false)).data, published);
      assert.equal((await f.request('/api/days/copy', body)).data.copied, 0);
    });
    await t.test('Explicit availability override can copy unavailable shifts, but never overwrites conflicts', async () => {
      const result = await f.request('/api/days/copy', { ...body, override_availability: true }); assert.equal(result.data.copied, 1); assert.equal(result.data.warnings.length, 1);
      assert.equal((await f.request('/api/days/copy', { ...body, target_date: source })).status, 400);
      assert.equal((await f.request('/api/days/copy', { ...body, target_date: '2026-02-30' })).status, 400);
      assert.equal((await f.request('/api/days/copy', body, 'POST', true, f.revision - 1)).status, 409);
    });
  } finally { await f.close(); }
});

test('Arrival recording distinguishes actual lateness from the manager marking time', async t => {
  const f = await fixture(), date = addDays(today(), -2);
  try {
    const p = await f.person('Arrival Colleague'); await f.shift(p.id, date);
    const attendance = (status, extra = {}) => f.request('/api/attendance', { person_id: p.id, location_id: f.loc.id, date, status, ...extra });
    await t.test('Check in without an arrival time does not infer lateness; manual late remains checked in', async () => {
      assert.equal((await attendance('checked_in')).data.is_late, 0);
      const late = (await attendance('late')).data; assert.equal(late.status, 'checked_in'); assert.equal(late.is_late, 1); assert.equal(late.late_minutes, null);
      const s = (await f.request(`/api/state?week=${monday(date)}`)).data;
      assert.equal(s.attendance[0].status, 'checked_in'); assert.equal(scheduledMinutes(s.shifts[0]), 480);
    });
    await t.test('Actual arrival calculates minutes late; early and on-time arrivals clear late', async () => {
      assert.equal((await attendance('checked_in', { arrival_time: '08:17' })).data.late_minutes, 17);
      assert.equal((await attendance('late', { arrival_time: '08:00' })).data.is_late, 0);
      assert.equal((await attendance('checked_in', { arrival_time: '07:50' })).data.is_late, 0);
      assert.equal((await attendance('checked_in', { arrival_time: '17:00' })).status, 400);
      assert.equal((await attendance('checked_in', { arrival_time: 'bad' })).status, 400);
      assert.equal((await attendance('checked_in', { arrival_time: '08:10', arrival_date: addDays(date, -1) })).status, 400);
    });
    await t.test('No show and clearing remove arrival details; future marking is rejected', async () => {
      const a = (await attendance('no_show')).data; assert.equal(a.is_late, 0); assert.equal(a.arrival_time, null); assert.equal(a.late_minutes, null);
      await attendance('unmarked'); assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM attendance').get().n, 0);
      await f.shift(p.id, addDays(today(), 1));
      assert.equal((await f.request('/api/attendance', { person_id: p.id, location_id: f.loc.id, date: addDays(today(), 1), status: 'late' })).status, 400);
    });
    await t.test('Overnight arrivals use the correct next day and survive restart', async () => {
      const overnight = await f.person('Overnight Colleague'); await f.shift(overnight.id, date, { start_time: '22:00', end_time: '06:00', break_start: '02:00' });
      const a = (await f.request('/api/attendance', { person_id: overnight.id, location_id: f.loc.id, date, status: 'checked_in', arrival_time: '01:00', arrival_date: addDays(date, 1) })).data;
      assert.equal(a.late_minutes, 180); await f.restart(); const saved = f.app.db.prepare('SELECT * FROM attendance').get(); assert.equal(saved.is_late, 1); assert.equal(saved.arrival_date, addDays(date, 1));
    });
  } finally { await f.close(); }
});

test('Daily dashboard counts colleagues once and treats overnight availability correctly', () => {
  const date = '2026-10-06', people = [
    { id: 'a', active: 1, location_id: 'site', availability: null },
    { id: 'b', active: 1, location_id: 'site', availability: weekly({ 0: { mode: 'times', start: '22:00', end: '06:00' } }) },
    { id: 'c', active: 1, location_id: 'site', availability: weekly({}) },
    { id: 'd', active: 1, location_id: 'site', availability: weekly({}) }
  ];
  const shifts = ['Engraving', 'Packing'].map(department => ({ person_id: 'a', date, location_id: 'site', kind: 'work', department }));
  shifts.push({ person_id: 'd', date, location_id: 'site', kind: 'holiday' });
  const summary = managerDaySummary(people, shifts, [{ person_id: 'a', location_id: 'site', date, status: 'checked_in', is_late: 1 }], date, 'site');
  assert.deepEqual(summary.scheduled, ['a']); assert.deepEqual(summary.checked_in, ['a']); assert.deepEqual(summary.late, ['a']); assert.deepEqual(summary.unavailable, ['c']); assert.deepEqual(summary.holiday, ['d']); assert.deepEqual(summary.unmarked, []);
  assert.equal(hasAvailabilityOnDate(null, date), true);
  assert.equal(hasAvailabilityOnDate(weekly({ 0: { mode: 'times', start: '22:00', end: '00:00' } }), date), false);
  assert.equal(arrivalDetails({ date, start_time: '22:00', end_time: '06:00' }, addDays(date, 1), '01:15').late_minutes, 195);
});

test('Holiday balances respect leave years, opening balances, approval and cancellations across all locations', async t => {
  const f = await fixture(), year = Number(today().slice(0, 4)), start = `${year}-01-01`, end = `${year}-12-31`, tracking = addDays(today(), -30);
  try {
    const p = await f.person('Holiday Colleague');
    const account = { year_start: start, year_end: end, tracking_start: tracking, day_hours: 8, allowance_hours: 200, carry_hours: 16, opening_taken_hours: 16 };
    const holiday = (date, extra = {}) => f.shift(p.id, date, { kind: 'holiday', ...extra });
    const before = await holiday(addDays(tracking, -1)), past = await holiday(addDays(today(), -3)), partial = await holiday(addDays(today(), -1), { holiday_hours: 4 });
    const future = await holiday(addDays(today(), 3)), pending = await holiday(addDays(today(), 4), { holiday_hours: 2, holiday_approved: false });
    await holiday(addDays(end, 1));
    const profile = () => f.request(`/api/people/${p.id}/holiday?date=${today()}`);
    await t.test('No allowance is assumed; configured balances count past and future holiday separately', async () => {
      assert.equal((await profile()).data.account, null);
      assert.equal((await f.request(`/api/people/${p.id}/holiday`, account, 'PUT')).status, 200);
      const h = (await profile()).data; assert.equal(h.total_minutes, 216 * 60); assert.equal(h.taken_minutes, 28 * 60); assert.equal(h.booked_minutes, 8 * 60); assert.equal(h.pending_minutes, 2 * 60); assert.equal(h.remaining_minutes, 180 * 60);
      assert.equal(h.bookings.find(s => s.id === before).included, false); assert.equal(h.bookings.find(s => s.id === partial).leave_minutes, 240); assert.equal(h.bookings.length, 5);
    });
    await t.test('Other sites are included, and approving, cancelling or reducing leave adjusts balances', async () => {
      const site = (await f.request('/api/locations', { name: 'Other site' })).data.id;
      const other = await holiday(addDays(today(), 5), { location_id: site, holiday_hours: 6 });
      assert.equal((await profile()).data.booked_minutes, 14 * 60);
      const entry = f.app.db.prepare('SELECT * FROM shifts WHERE id=?').get(pending);
      await f.request(`/api/shifts/${pending}`, { ...entry, holiday_approved: true }, 'PUT'); assert.equal((await profile()).data.booked_minutes, 16 * 60);
      await f.request(`/api/shifts/${future}`, {}, 'DELETE'); assert.equal((await profile()).data.booked_minutes, 8 * 60);
      const old = f.app.db.prepare('SELECT * FROM shifts WHERE id=?').get(partial);
      await f.request(`/api/shifts/${partial}`, { ...old, holiday_hours: 2 }, 'PUT'); assert.equal((await profile()).data.taken_minutes, 26 * 60);
      await f.request(`/api/shifts/${other}`, {}, 'DELETE'); assert.equal((await profile()).data.booked_minutes, 2 * 60);
      const current = f.app.db.prepare('SELECT * FROM shifts WHERE id=?').get(pending);
      await f.request(`/api/shifts/${pending}`, { ...current, kind: 'sick' }, 'PUT'); assert.equal((await profile()).data.booked_minutes, 0);
      assert.equal(f.app.db.prepare('SELECT holiday_minutes FROM shifts WHERE id=?').get(pending).holiday_minutes, null);
    });
    await t.test('Invalid and overlapping years are rejected, including invalid hours and stale revisions', async () => {
      assert.equal((await f.request(`/api/people/${p.id}/holiday`, { ...account, year_start: addDays(start, 1) }, 'PUT')).status, 400);
      assert.equal((await f.request(`/api/people/${p.id}/holiday`, { ...account, day_hours: 0 }, 'PUT')).status, 400);
      assert.equal((await f.request(`/api/people/${p.id}/holiday`, { ...account, tracking_start: addDays(end, 1) }, 'PUT')).status, 400);
      assert.equal((await f.request(`/api/people/${p.id}/holiday`, account, 'PUT', true, f.revision - 1)).status, 409);
      const result = await f.request('/api/shifts', { person_id: p.id, location_id: f.loc.id, date: addDays(today(), 10), kind: 'holiday', holiday_hours: -1 }); assert.equal(result.status, 400);
    });
    await t.test('A leave year can be corrected without creating a second allowance', async () => {
      const changedStart = addDays(start, 1);
      const changed = await f.request(`/api/people/${p.id}/holiday`, { ...account, original_year_start: start, year_start: changedStart }, 'PUT');
      assert.equal(changed.status, 200); assert.equal((await profile()).data.accounts.length, 1);
      assert.equal((await profile()).data.account.year_start, changedStart);
      assert.equal((await f.request(`/api/people/${p.id}/holiday?yearStart=${start}`)).status, 404);
      assert.equal((await f.request(`/api/people/${p.id}/holiday`, { ...account, original_year_start: changedStart }, 'PUT')).status, 200);
      assert.equal((await profile()).data.taken_minutes, 26 * 60);
    });
    await t.test('Published rota and unauthenticated requests never expose balances or holiday deductions', async () => {
      const week = monday(addDays(today(), -1)); await f.request('/api/publish', { location_id: f.loc.id, week });
      const shared = (await f.request(`/api/public/${f.loc.share_token}?week=${week}`, undefined, 'GET', false)).data;
      for (const s of shared.shifts) { assert.equal(s.holiday_minutes, undefined); assert.equal(s.holiday_approved, undefined); }
      assert.equal(shared.leave_accounts, undefined); assert.equal(shared.attendance, undefined);
      assert.equal((await f.request(`/api/people/${p.id}/holiday`, undefined, 'GET', false)).status, 401);
      const snap = f.app.db.prepare('SELECT snapshot FROM publications').get().snapshot;
      await f.request(`/api/people/${p.id}/holiday`, { ...account, allowance_hours: 240 }, 'PUT');
      assert.equal(f.app.db.prepare('SELECT snapshot FROM publications').get().snapshot, snap);
    });
    await t.test('Balances and historical years survive restart; deleting a colleague removes their account', async () => {
      await f.restart(); assert.equal((await profile()).data.taken_minutes, 26 * 60);
      const nextStart = addDays(end, 1), nextEnd = `${year + 1}-12-31`;
      await f.request(`/api/people/${p.id}/holiday`, { ...account, year_start: nextStart, year_end: nextEnd, tracking_start: nextStart, opening_taken_hours: 0 }, 'PUT');
      const next = (await f.request(`/api/people/${p.id}/holiday?yearStart=${nextStart}`)).data; assert.equal(next.accounts.length, 2); assert.equal(next.bookings.length, 1);
      await f.request(`/api/people/${p.id}`, { confirm: true }, 'DELETE'); assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM leave_accounts').get().n, 0);
    });
  } finally { await f.close(); }
});

test('Holiday balance handles leap-year boundaries and displays negative remaining hours', () => {
  const a = { year_start: '2024-02-29', year_end: '2025-02-28', tracking_start: '2024-02-29', day_minutes: 450, allowance_minutes: 450, carry_minutes: 0, opening_taken_minutes: 0 };
  const shifts = ['2024-02-28', '2024-02-29', '2025-02-28', '2025-03-01'].map((date, i) => ({ id: String(i), date, kind: 'holiday', holiday_minutes: null, holiday_approved: 1 }));
  const h = holidayBalance(a, shifts, '2025-03-02'); assert.equal(h.taken_minutes, 900); assert.equal(h.remaining_minutes, -450); assert.equal(h.bookings.length, 2);
});

test('Schema 5 migration backs up and preserves colleagues, availability, shifts, attendance, QR and publications', async () => {
  const f = await fixture();
  try {
    const p = await f.person('Migration Person', { availability: weekly({ 0: { mode: 'all_day' } }) }), date = monday(addDays(today(), -7));
    await f.shift(p.id, date, { label: 'B2B', note: 'Private note' }); await f.request('/api/attendance', { person_id: p.id, location_id: f.loc.id, date, status: 'no_show' });
    await f.request('/api/publish', { location_id: f.loc.id, week: date });
    const publication = f.app.db.prepare('SELECT * FROM publications').get();
    f.app.db.exec("DROP TABLE leave_accounts; ALTER TABLE attendance DROP COLUMN arrival_time; ALTER TABLE attendance DROP COLUMN arrival_date; ALTER TABLE attendance DROP COLUMN is_late; ALTER TABLE attendance DROP COLUMN late_minutes; ALTER TABLE shifts DROP COLUMN holiday_minutes; ALTER TABLE shifts DROP COLUMN holiday_approved; UPDATE meta SET value='5' WHERE key='schema_version'");
    await f.restart(); assert.ok(existsSync(path.join(f.directory, 'backups', 'rota-before-schema-6.sqlite')));
    assert.equal(f.app.db.prepare('SELECT * FROM locations').get().share_token, f.loc.share_token); assert.deepEqual(f.app.db.prepare('SELECT * FROM publications').get(), publication);
    assert.equal(f.app.db.prepare('SELECT * FROM shifts').get().label, 'B2B'); assert.equal(f.app.db.prepare('SELECT * FROM attendance').get().status, 'no_show'); assert.equal(f.app.db.prepare('SELECT * FROM attendance').get().is_late, 0);
    assert.equal(JSON.parse(f.app.db.prepare('SELECT availability FROM people').get().availability).days[0].mode, 'all_day');
    const revision = f.app.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value; await f.restart(); assert.equal(f.app.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value, revision);
  } finally { await f.close(); }
});
