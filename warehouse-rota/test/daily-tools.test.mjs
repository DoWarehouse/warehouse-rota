import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRotaServer, monday, today, addDays, scheduledMinutes } from '../server.mjs';

test('Daily attendance, hours targets, sick leave and moving shifts', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-daily-tools-'));
  let app = createRotaServer({ dataDir: dir, password: 'daily-tools-password', seedExamples: false });
  let cookie = '', revision = 0, base;
  const week = monday(addDays(today(), -7)), next = addDays(week, 1);
  const start = async () => {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rota-Request': '1' }, body: JSON.stringify({ password: 'daily-tools-password' }) });
    cookie = login.headers.get('set-cookie').split(';')[0];
    revision = Number(app.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value);
  };
  async function request(url, body, method = 'POST', headers = {}) {
    const response = await fetch(base + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Rota-Request': '1', 'If-Match': String(revision), ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (response.ok && data.revision !== undefined) revision = data.revision;
    return { status: response.status, data };
  }
  const state = async () => (await request(`/api/state?week=${week}`, undefined, 'GET')).data;
  const mark = (p, status, date = week) => request('/api/attendance', { person_id: p, location_id: loc.id, date, status });
  let loc, first, second, shift, published;
  try {
    await start();
    loc = (await state()).locations[0];
    first = (await request('/api/people', { name: 'Person One', location_id: loc.id, default_department: 'Picking' })).data.id;
    second = (await request('/api/people', { name: 'Person Two', location_id: loc.id, default_department: 'Packing' })).data.id;
    shift = { person_id: first, location_id: loc.id, date: week, kind: 'work', label: 'Early', department: 'Picking', warehouse: 'Warehouse 2', start_time: '08:00', end_time: '16:30', break_minutes: 30, break_start: '12:00', note: 'Private manager note' };
    shift.id = (await request('/api/shifts', shift)).data.id;
    assert.ok(shift.id);
    await request('/api/publish', { location_id: loc.id, week });
    published = app.db.prepare('SELECT snapshot FROM publications').get().snapshot;

    await t.test('Attendance requires authentication, valid work and a reached date', async () => {
      assert.equal((await request('/api/attendance', { person_id: first, location_id: loc.id, date: week, status: 'checked_in' }, 'POST', { Cookie: '' })).status, 401);
      assert.equal((await mark(second, 'checked_in')).status, 400);
      assert.equal((await mark(first, 'present')).status, 400);
      const tomorrow = addDays(today(), 1);
      assert.equal((await request('/api/shifts', { ...shift, date: tomorrow })).status, 200);
      assert.equal((await mark(first, 'checked_in', tomorrow)).status, 400);
      assert.equal((await request('/api/attendance', { person_id: first, location_id: loc.id, date: '2026-02-30', status: 'checked_in' })).status, 400);
      assert.equal((await state()).attendance.length, 0);
    });
    await t.test('Check in, correct to no show, and clear without changing publications', async () => {
      assert.equal((await mark(first, 'checked_in')).status, 200);
      let record = (await state()).attendance[0];
      assert.equal(record.status, 'checked_in'); assert.ok(Number.isFinite(Date.parse(record.marked_at)));
      assert.equal((await mark(first, 'no_show')).status, 200);
      assert.equal((await state()).attendance[0].status, 'no_show');
      assert.equal((await state()).publications[0].dirty, false);
      assert.equal(app.db.prepare('SELECT snapshot FROM publications').get().snapshot, published);
      assert.equal((await mark(first, 'unmarked')).status, 200);
      assert.equal((await state()).attendance.length, 0);
      await mark(first, 'checked_in');
    });
    await t.test('Previous-day attendance accompanies overnight shifts in manager state only', async () => {
      const previousDate = addDays(week, -1);
      const overnight = await request('/api/shifts', { ...shift, date: previousDate, start_time: '22:00', end_time: '06:00', break_start: '02:00' });
      assert.equal(overnight.status, 200);
      assert.equal((await mark(first, 'no_show', previousDate)).status, 200);
      let draft = await state();
      assert.equal(draft.attendance.length, 1);
      assert.equal(draft.previousAttendance.length, 1);
      assert.equal(draft.previousAttendance[0].date, previousDate);
      assert.equal(draft.previousAttendance[0].status, 'no_show');
      assert.equal(draft.previousShifts.find(s => s.id === overnight.data.id).date, previousDate);
      const shared = await (await fetch(base + `/api/public/${loc.share_token}?week=${week}`)).json();
      assert.equal(shared.previousAttendance, undefined);
      assert.equal((await mark(first, 'checked_in', previousDate)).status, 200);
      assert.equal((await state()).previousAttendance[0].status, 'checked_in');
      assert.equal((await mark(first, 'unmarked', previousDate)).status, 200);
      assert.equal((await request('/api/shifts/' + overnight.data.id, undefined, 'DELETE')).status, 200);
      assert.equal((await state()).previousAttendance.length, 0);
    });
    await t.test('Daily targets preserve decimal hours and distinguish zero from unset', async () => {
      const save = values => request('/api/day-plans', { location_id: loc.id, date: week, ...values });
      assert.equal((await save({ requirement_hours: '12.5' })).status, 200);
      let plan = (await state()).dayPlans[0];
      assert.equal(plan.requirement_minutes, 750); assert.equal(plan.budget_minutes, undefined);
      for (const value of [-1, 10001, 'not hours', true, {}, '   ']) assert.equal((await save({ requirement_hours: value })).status, 400);
      assert.equal((await save({ requirement_hours: 0 })).status, 200);
      plan = (await state()).dayPlans[0]; assert.equal(plan.requirement_minutes, 0); assert.equal(plan.budget_minutes, undefined);
      assert.equal((await save({ requirement_hours: '' })).status, 200);
      assert.equal((await state()).dayPlans.length, 0);
      await save({ requirement_hours: 12.5 });
      assert.equal((await state()).publications[0].dirty, false);
    });
    await t.test('Moving a shift keeps assignment and break data; attendance stays with the original day', async () => {
      assert.equal((await request('/api/shifts/' + shift.id, { ...shift, person_id: second, date: next }, 'PUT')).status, 200);
      const moved = (await state()).shifts.find(s => s.id === shift.id);
      assert.equal(moved.person_id, second); assert.equal(moved.date, next);
      assert.equal(moved.department, 'Picking'); assert.equal(moved.warehouse, 'Warehouse 2');
      assert.equal(moved.break_start, '12:00'); assert.equal(moved.break_minutes, 30); assert.equal(moved.note, 'Private manager note');
      const record = (await state()).attendance[0]; assert.equal(record.person_id, first); assert.equal(record.date, week);
      assert.equal((await state()).publications[0].dirty, true);
      assert.equal(app.db.prepare('SELECT snapshot FROM publications').get().snapshot, published);
      assert.equal((await mark(first, 'unmarked')).status, 200);
      await request('/api/shifts/' + shift.id, shift, 'PUT');
      await mark(first, 'no_show');
    });
    await t.test('Moves reject ordinary and overnight overlaps atomically', async () => {
      const other = { ...shift, person_id: second, date: next, start_time: '14:00', end_time: '22:00', break_start: '18:00' };
      await request('/api/shifts', other);
      assert.equal((await request('/api/shifts/' + shift.id, { ...shift, person_id: second, date: next }, 'PUT')).status, 422);
      assert.equal((await state()).shifts.find(s => s.id === shift.id).person_id, first);
      const nightDate = addDays(week, 2);
      await request('/api/shifts', { ...shift, person_id: second, date: nightDate, start_time: '22:00', end_time: '06:00', break_start: '02:00' });
      assert.equal((await request('/api/shifts/' + shift.id, { ...shift, person_id: second, date: addDays(nightDate, 1), start_time: '04:00', end_time: '12:00', break_start: '08:00' }, 'PUT')).status, 422);
      assert.equal((await state()).shifts.find(s => s.id === shift.id).date, week);
      assert.equal((await request('/api/shifts/' + shift.id, { ...shift, date: next }, 'PUT', { 'If-Match': String(revision - 1) })).status, 409);
    });
    await t.test('Sick blocks conflicting work, contributes no hours and shares only Unavailable', async () => {
      const sickDate = addDays(week, 4);
      const sick = (await request('/api/shifts', { person_id: first, location_id: loc.id, date: sickDate, kind: 'sick', note: 'Private absence details' })).data.id;
      const row = (await state()).shifts.find(s => s.id === sick);
      assert.equal(row.kind, 'sick'); assert.equal(row.label, 'Sick'); assert.equal(row.start_time, null); assert.equal(scheduledMinutes(row), 0);
      assert.equal((await request('/api/shifts', { ...shift, date: sickDate })).status, 422);
      assert.equal((await mark(first, 'checked_in', sickDate)).status, 400);
      await request('/api/publish', { location_id: loc.id, week });
      const response = await fetch(base + `/api/public/${loc.share_token}?week=${week}`);
      const shared = await response.json();
      assert.equal(shared.shifts.find(s => s.id === sick).kind, 'unavailable');
      assert.equal(shared.shifts.find(s => s.id === sick).label, 'Unavailable');
      assert.equal(shared.attendance, undefined); assert.equal(shared.dayPlans, undefined);
      assert.ok(!JSON.stringify(shared).includes('Private')); assert.ok(!JSON.stringify(shared).includes('no_show'));
      const csv = await (await fetch(base + `/api/export.csv?locationId=${loc.id}&week=${week}`, { headers: { Cookie: cookie } })).text();
      assert.ok(csv.includes('"sick"')); assert.ok(!csv.includes('Private absence details'));
    });
    await t.test('Attendance and targets survive restart; deleting a colleague cleans their attendance', async () => {
      await app.close();
      app = createRotaServer({ dataDir: dir, password: 'daily-tools-password', seedExamples: false });
      await start();
      assert.equal((await state()).attendance[0].status, 'no_show');
      assert.equal((await state()).dayPlans[0].requirement_minutes, 750);
      assert.equal((await request('/api/people/' + first, { confirm: true }, 'DELETE')).status, 200);
      assert.equal((await state()).attendance.length, 0);
      assert.equal((await state()).dayPlans.length, 1);
    });
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Schema 3 upgrade keeps saved shifts, publications and share tokens and creates a backup', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-schema4-'));
  let app = createRotaServer({ dataDir: dir, password: 'schema-four-password' });
  try {
    const token = app.db.prepare('SELECT share_token FROM locations').get().share_token;
    const loc = app.db.prepare('SELECT id FROM locations').get().id;
    const originalPeople = app.db.prepare('SELECT * FROM people').all();
    app.db.prepare("INSERT INTO shifts (id,person_id,location_id,date,start_time,end_time,break_minutes,kind,label,colour,note,department,warehouse,break_start) VALUES ('saved-shift',?,?,'2026-10-05','08:00','16:30',30,'work','Early','blue','Saved note','Picking','Warehouse 1','12:00')").run(originalPeople[0].id, loc);
    const publication = JSON.stringify({ location: { id: loc, name: 'Warehouse' }, people: [], shifts: [] });
    app.db.prepare("INSERT INTO publications VALUES (?, '2026-10-05', ?, '2026-10-01T12:00:00Z')").run(loc, publication);
    app.db.prepare("INSERT INTO meta VALUES ('dashboard_api_key', 'saved-integration-key')").run();
    const originalShift = app.db.prepare('SELECT * FROM shifts').get();
    app.db.exec("DROP TABLE leave_accounts; ALTER TABLE shifts DROP COLUMN holiday_minutes; ALTER TABLE shifts DROP COLUMN holiday_approved; DROP TABLE attendance; DROP TABLE day_plans; ALTER TABLE people DROP COLUMN availability; ALTER TABLE people DROP COLUMN default_warehouse; ALTER TABLE people DROP COLUMN preferred_template_id; UPDATE meta SET value='3' WHERE key='schema_version';");
    await app.close();
    app = createRotaServer({ dataDir: dir, password: 'schema-four-password' });
    assert.equal(app.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '6');
    assert.deepEqual(app.db.prepare('SELECT * FROM people').all(), originalPeople);
    assert.equal(app.db.prepare('SELECT share_token FROM locations').get().share_token, token);
    assert.deepEqual(app.db.prepare('SELECT * FROM shifts').get(), originalShift);
    assert.equal(app.db.prepare('SELECT snapshot FROM publications').get().snapshot, publication);
    assert.equal(app.db.prepare("SELECT value FROM meta WHERE key='dashboard_api_key'").get().value, 'saved-integration-key');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM attendance').get().n, 0);
    assert.ok(existsSync(path.join(dir, 'backups', 'rota-before-schema-4.sqlite')));
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
