import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRotaServer, monday, today, addDays } from '../server.mjs';

test('Clear controls affect only the selected draft dates and location', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-week-controls-'));
  let app = createRotaServer({ dataDir: dir, password: 'week-controls-password', seedExamples: false });
  const week = monday(addDays(today(), -7));
  let base, cookie, revision;
  const start = async () => {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rota-Request': '1' }, body: JSON.stringify({ password: 'week-controls-password' }) });
    cookie = response.headers.get('set-cookie').split(';')[0];
    revision = Number(app.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value);
  };
  const request = async (endpoint, body, method = 'POST', extraHeaders = {}) => {
    const response = await fetch(base + endpoint, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Rota-Request': '1', 'If-Match': String(revision), ...extraHeaders }, body: method === 'GET' ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (response.ok && data.revision !== undefined) revision = data.revision;
    return { status: response.status, data };
  };
  const state = async () => (await request('/api/state?week=' + week, undefined, 'GET')).data;
  let loc, otherLoc, first, snapshot, peopleBefore, patternsBefore, otherLocationShift, previousShift, nextShift;
  const clear = (scope, extra = {}, headers = {}) => request('/api/shifts/clear', { location_id: loc.id, scope, ...(scope === 'day' ? { date: week } : { week }), confirm: true, ...extra }, 'POST', headers);
  try {
    await start();
    loc = (await state()).locations[0];
    otherLoc = (await request('/api/locations', { name: 'Other location' })).data.id;
    const ids = [];
    for (const name of ['Worker', 'Holiday', 'Sick', 'Unavailable', 'Trainee']) {
      const result = await request('/api/people', { name, location_id: loc.id, default_department: name === 'Trainee' ? 'Engraving' : 'Picking' });
      assert.equal(result.status, 200); ids.push(result.data.id);
    }
    first = ids[0];
    const fields = { location_id: loc.id, start_time: '08:00', end_time: '16:30', break_minutes: 30, break_start: '12:00', department: 'Picking', warehouse: 'Warehouse 1' };
    for (const [i, kind] of ['work', 'holiday', 'sick', 'unavailable', 'training'].entries()) {
      assert.equal((await request('/api/shifts', { ...fields, person_id: ids[i], date: week, kind, ...(i === 4 ? { department: 'Engraving', warehouse: 'Warehouse 2' } : {}) })).status, 200);
    }
    assert.equal((await request('/api/shifts', { ...fields, person_id: first, date: addDays(week, 1), warehouse: 'Warehouse 2' })).status, 200);
    assert.equal((await request('/api/shifts', { ...fields, person_id: first, date: addDays(week, 2), kind: 'training', department: 'Packing' })).status, 200);
    const atOther = (await request('/api/people', { name: 'Other location worker', location_id: otherLoc, default_department: 'Packing' })).data.id;
    otherLocationShift = (await request('/api/shifts', { ...fields, person_id: atOther, location_id: otherLoc, date: week })).data.id;
    previousShift = (await request('/api/shifts', { ...fields, person_id: first, date: addDays(week, -1), start_time: '22:00', end_time: '06:00', break_start: '02:00' })).data.id;
    nextShift = (await request('/api/shifts', { ...fields, person_id: first, date: addDays(week, 7) })).data.id;
    assert.ok(otherLocationShift && previousShift && nextShift);
    await request('/api/templates', { name: 'Keep this pattern', kind: 'work', start_time: '08:00', end_time: '16:00', break_minutes: 30, break_start: '12:00' });
    await request('/api/attendance', { person_id: first, location_id: loc.id, date: week, status: 'no_show' });
    await request('/api/day-plans', { location_id: loc.id, date: week, requirement_hours: 16.25 });
    await request('/api/publish', { location_id: loc.id, week });
    snapshot = app.db.prepare('SELECT snapshot FROM publications WHERE location_id=?').get(loc.id).snapshot;
    peopleBefore = app.db.prepare('SELECT * FROM people ORDER BY id').all();
    patternsBefore = app.db.prepare('SELECT * FROM templates ORDER BY id').all();

    await t.test('Authentication, same-origin, confirmation, dates and revisions protect bulk deletion', async () => {
      const before = app.db.prepare('SELECT * FROM shifts ORDER BY id').all();
      assert.equal((await clear('day', {}, { Cookie: '' })).status, 401);
      assert.equal((await clear('day', {}, { 'X-Rota-Request': '' })).status, 403);
      assert.equal((await clear('day', {}, { Origin: 'https://unrelated.example' })).status, 403);
      assert.equal((await clear('day', { confirm: false })).status, 400);
      assert.equal((await clear('day', { confirm: 'true' })).status, 400);
      assert.equal((await clear('all')).status, 400);
      assert.equal((await clear('day', { date: '2026-02-30' })).status, 400);
      assert.equal((await clear('week', { week: undefined })).status, 400);
      assert.equal((await clear('day', { location_id: 'missing' })).status, 404);
      assert.equal((await clear('day', {}, { 'If-Match': String(revision - 1) })).status, 409);
      assert.deepEqual(app.db.prepare('SELECT * FROM shifts ORDER BY id').all(), before);
    });
    await t.test('Clear day removes all shift types in both warehouses, leaving other dates and sites', async () => {
      const result = await clear('day');
      assert.equal(result.status, 200); assert.equal(result.data.removed_shifts, 5);
      assert.equal(result.data.start_date, week); assert.equal(result.data.end_date, week);
      const draft = await state();
      assert.equal(draft.shifts.filter(s => s.location_id === loc.id && s.date === week).length, 0);
      assert.equal(draft.shifts.filter(s => s.location_id === loc.id).length, 2);
      assert.equal(draft.attendance.find(a => a.person_id === first).status, 'no_show');
      assert.equal(draft.dayPlans.find(p => p.location_id === loc.id).requirement_minutes, 975);
      assert.equal(draft.publications.find(p => p.location_id === loc.id).dirty, true);
      assert.ok(app.db.prepare('SELECT id FROM shifts WHERE id=?').get(previousShift));
      assert.ok(app.db.prepare('SELECT id FROM shifts WHERE id=?').get(otherLocationShift));
      assert.ok(app.db.prepare('SELECT id FROM shifts WHERE id=?').get(nextShift));
    });
    await t.test('Published copies, colleague records, patterns and QR remain unchanged after clearing', async () => {
      assert.equal(app.db.prepare('SELECT snapshot FROM publications WHERE location_id=?').get(loc.id).snapshot, snapshot);
      const shared = (await request(`/api/public/${loc.share_token}?week=${week}`, undefined, 'GET', { Cookie: '' })).data;
      assert.equal(shared.shifts.length, 7); assert.equal(shared.attendance, undefined);
      assert.deepEqual(app.db.prepare('SELECT * FROM people ORDER BY id').all(), peopleBefore);
      assert.deepEqual(app.db.prepare('SELECT * FROM templates ORDER BY id').all(), patternsBefore);
      assert.equal(app.db.prepare('SELECT share_token FROM locations WHERE id=?').get(loc.id).share_token, loc.share_token);
    });
    await t.test('Clear week removes the remainder of this week while preserving its attendance and requirements', async () => {
      const result = await clear('week');
      assert.equal(result.status, 200); assert.equal(result.data.removed_shifts, 2);
      assert.equal(result.data.end_date, addDays(week, 6));
      const draft = await state();
      assert.equal(draft.shifts.filter(s => s.location_id === loc.id).length, 0);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n, 3);
      assert.equal(draft.attendance.length, 1); assert.equal(draft.dayPlans.length, 1);
      assert.equal(app.db.prepare('SELECT snapshot FROM publications WHERE location_id=?').get(loc.id).snapshot, snapshot);
      assert.equal((await clear('week')).data.removed_shifts, 0);
    });
    await t.test('An empty rota reaches colleagues only after publishing the cleared week', async () => {
      await request('/api/publish', { location_id: loc.id, week });
      const shared = (await request(`/api/public/${loc.share_token}?week=${week}`, undefined, 'GET', { Cookie: '' })).data;
      assert.equal(shared.shifts.length, 0); assert.equal(shared.people.length, 5);
      assert.equal(shared.unpublished, undefined); assert.equal(shared.attendance, undefined);
    });
    await t.test('Legacy budgets are hidden, existing required hours are retained and a new save uses only required hours', async () => {
      app.db.prepare('UPDATE day_plans SET budget_minutes=1200 WHERE location_id=? AND date=?').run(loc.id, week);
      app.db.prepare('INSERT INTO day_plans VALUES (?, ?, ?, NULL)').run(loc.id, addDays(week, 1), 900);
      await app.close();
      app = createRotaServer({ dataDir: dir, password: 'week-controls-password', seedExamples: false });
      await start();
      const draft = await state();
      assert.equal(draft.dayPlans.length, 1); assert.equal(draft.dayPlans[0].requirement_minutes, 975);
      assert.equal(draft.dayPlans[0].budget_minutes, undefined);
      assert.equal(draft.attendance[0].status, 'no_show');
      assert.equal((await request('/api/day-plans', { location_id: loc.id, date: week, requirement_hours: 10, budget_hours: 100 })).status, 200);
      assert.equal((await state()).dayPlans[0].requirement_minutes, 600);
      assert.equal(app.db.prepare('SELECT budget_minutes FROM day_plans WHERE location_id=? AND date=?').get(loc.id, week).budget_minutes, null);
      assert.equal((await request('/api/day-plans', { location_id: loc.id, date: week, requirement_hours: '' })).status, 200);
      assert.equal((await state()).dayPlans.length, 0);
    });
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
