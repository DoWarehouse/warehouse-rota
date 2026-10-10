import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRotaServer } from '../server.mjs';

test('Original rota data migrates without changing times, published snapshots or QR tokens', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-migration-'));
  const original = new DatabaseSync(path.join(dir, 'rota.sqlite'));
  original.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '1'), ('revision', '7');
    CREATE TABLE locations (id TEXT PRIMARY KEY, name TEXT NOT NULL, share_token TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', contract_minutes INTEGER NOT NULL DEFAULT 0, location_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, row_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE shifts (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, location_id TEXT NOT NULL, date TEXT NOT NULL, start_time TEXT, end_time TEXT, break_minutes INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, label TEXT NOT NULL, colour TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
    CREATE TABLE publications (location_id TEXT NOT NULL, week TEXT NOT NULL, snapshot TEXT NOT NULL, published_at TEXT NOT NULL, PRIMARY KEY (location_id, week));
    INSERT INTO locations VALUES ('warehouse', 'Warehouse', 'existing-shared-token', 1);
    INSERT INTO people VALUES ('colleague', 'Original colleague', 'Picking', '', 2400, 'warehouse', 1, 0);
    INSERT INTO shifts VALUES ('shift', 'colleague', 'warehouse', '2026-10-05', '08:00', '16:30', 30, 'work', 'Day', 'blue', 'Private');
  `);
  const published = JSON.stringify({ location: { id: 'warehouse', name: 'Warehouse' }, week: '2026-10-05', people: [{ id: 'colleague', name: 'Original colleague', team: 'Picking' }], shifts: [] });
  original.prepare('INSERT INTO publications VALUES (?, ?, ?, ?)').run('warehouse', '2026-10-05', published, '2026-10-01T12:00:00Z');
  original.close();
  let app;
  try {
    app = createRotaServer({ dataDir: dir, password: 'migration-test-password' });
    assert.equal(app.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '6');
    assert.equal(app.db.prepare('SELECT default_department FROM people').get().default_department, 'Picking');
    const shift = app.db.prepare('SELECT * FROM shifts').get();
    assert.equal(shift.start_time, '08:00'); assert.equal(shift.department, 'Picking'); assert.equal(shift.warehouse, ''); assert.equal(shift.note, 'Private');
    assert.equal(app.db.prepare('SELECT share_token FROM locations').get().share_token, 'existing-shared-token');
    assert.equal(app.db.prepare('SELECT snapshot FROM publications').get().snapshot, published);
    assert.ok(existsSync(path.join(dir, 'backups', 'rota-before-schema-2.sqlite')));
    assert.ok(existsSync(path.join(dir, 'backups', 'rota-before-schema-4.sqlite')));
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rota-Request': '1' }, body: JSON.stringify({ password: 'migration-test-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const publish = await fetch(base + '/api/publish', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Rota-Request': '1', 'If-Match': '12' }, body: JSON.stringify({ location_id: 'warehouse', week: '2026-10-05' }) });
    assert.equal(publish.status, 400);
    assert.equal(app.db.prepare('SELECT snapshot FROM publications').get().snapshot, published);
    await app.close(); app = createRotaServer({ dataDir: dir, password: 'migration-test-password' });
    assert.equal(app.db.prepare('SELECT warehouse FROM shifts').get().warehouse, '');
  } finally { if (app) await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Warehouse scheduling, publication, access control and persistence', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-tests-'));
  let app = createRotaServer({ dataDir: dir, password: 'test-manager-password', seedExamples: false });
  const listen = async () => { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${app.server.address().port}`; };
  let base = await listen(), cookie = '', rev = 0;
  const week = '2026-10-05'; let locationId, colleagueIds, shareToken, templateId;
  async function request(endpoint, body, options = {}) {
    const method = options.method || (body ? 'POST' : 'GET');
    const headers = { ...(options.public ? {} : { Cookie: cookie }), ...options.headers };
    if (method !== 'GET') Object.assign(headers, { 'Content-Type': 'application/json', 'X-Rota-Request': '1', 'If-Match': String(options.revision ?? rev) });
    const response = await fetch(base + endpoint, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const data = await response.json();
    if (data.revision !== undefined && response.ok) rev = data.revision;
    return { status: response.status, data, response };
  }
  try {
    await t.test('Manager records require authentication', async () => {
      const r = await request('/api/state'); assert.equal(r.status, 401); assert.equal(r.data.people, undefined);
      const bad = await request('/api/login', { password: 'wrong' }); assert.equal(bad.status, 401);
      const login = await request('/api/login', { password: 'test-manager-password', seedExamples: false }); assert.equal(login.status, 200);
      cookie = login.response.headers.get('set-cookie').split(';')[0];
      assert.match(login.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
      const state = await request(`/api/state?week=${week}`); locationId = state.data.locations[0].id; shareToken = state.data.locations[0].share_token;
      assert.equal(state.data.people.length, 0); assert.equal(state.data.templates.length, 0);
    });
    await t.test('Cross-origin mutation is rejected', async () => {
      const r = await request('/api/people', { name: 'Injected', location_id: locationId }, { headers: { Origin: 'https://different-origin.example' } }); assert.equal(r.status, 403);
    });
    await t.test('Import 65 colleagues with Unicode names and duplicate protection', async () => {
      const people = Array.from({ length: 65 }, (_, i) => ({ name: i === 0 ? 'Zoë O’Neill' : `Example Colleague ${String(i + 1).padStart(2, '0')}`, team: i < 30 ? 'Picking' : 'Packing', role: 'Warehouse colleague', contract_hours: 40 }));
      const r = await request('/api/people/import', { location_id: locationId, people }); assert.equal(r.data.imported, 65);
      const duplicate = await request('/api/people/import', { location_id: locationId, people }); assert.equal(duplicate.data.imported, 0); assert.equal(duplicate.data.skipped, 65);
      const state = await request(`/api/state?week=${week}`); assert.equal(state.data.people.length, 65); assert.ok(state.data.people.some(p => p.name === 'Zoë O’Neill')); colleagueIds = state.data.people.map(p => p.id);
    });
    await t.test('Shift patterns are editable without rewriting existing shifts', async () => {
      const r = await request('/api/templates', { name: 'Day shift', kind: 'work', start_time: '08:00', end_time: '16:30', break_minutes: 30, colour: 'blue' }); assert.equal(r.status, 200); templateId = r.data.id;
      const invalid = await request('/api/templates', { name: 'Invalid', start_time: '08:00', end_time: '08:00', break_minutes: 0 }); assert.equal(invalid.status, 400);
    });
    await t.test('Departments and warehouses are validated and missing defaults roll back bulk work', async () => {
      const shift = { location_id: locationId, person_id: colleagueIds[64], date: week, start_time: '08:00', end_time: '16:00' };
      assert.equal((await request('/api/shifts', shift)).status, 400);
      assert.equal((await request('/api/shifts', { ...shift, department: 'Dispatch', warehouse: 'Warehouse 1' })).status, 400);
      assert.equal((await request('/api/shifts', { ...shift, department: 'Picking', warehouse: 'Warehouse 3' })).status, 400);
      const state = (await request(`/api/state?week=${week}`)).data;
      const colleague = state.people.find(p => p.id === colleagueIds[64]);
      await request('/api/people/' + colleague.id, { ...colleague, contract_hours: 40, default_department: '' }, { method: 'PUT' });
      const bulk = await request('/api/shifts/bulk', { ...shift, warehouse: 'Warehouse 1', person_ids: [colleagueIds[0], colleague.id], dates: [week] });
      assert.equal(bulk.status, 400);
      assert.equal((await request(`/api/state?week=${week}`)).data.shifts.length, 0);
      await request('/api/people/' + colleague.id, { ...colleague, contract_hours: 40 }, { method: 'PUT' });
    });
    await t.test('Assign 300 shifts in one request with correct weekly totals', async () => {
      const r = await request('/api/shifts/bulk', { location_id: locationId, warehouse: 'Warehouse 1', person_ids: colleagueIds.slice(0, 60), dates: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'], kind: 'work', label: 'Day shift', start_time: '08:00', end_time: '16:30', break_minutes: 30, note: 'Internal manager note', colour: 'blue' });
      assert.equal(r.status, 200); assert.equal(r.data.created, 300);
      const state = await request(`/api/state?week=${week}`); assert.equal(state.data.shifts.length, 300);
      const shifts = state.data.shifts.filter(s => s.person_id === colleagueIds[0]); assert.equal(shifts.length, 5);
      for (const shift of state.data.shifts) {
        assert.equal(shift.department, state.data.people.find(p => p.id === shift.person_id).default_department);
        assert.equal(shift.warehouse, 'Warehouse 1');
      }
    });
    await t.test('Manual shifts support different times and break lengths', async () => {
      const r = await request('/api/shifts', { location_id: locationId, warehouse: 'Warehouse 2', person_id: colleagueIds[60], date: '2026-10-09', kind: 'work', label: 'Manual cover', department: 'Engraving', break_start: '12:15', start_time: '10:15', end_time: '15:45', break_minutes: 15 }); assert.equal(r.status, 200);
      const fields = await request('/api/templates/' + templateId, { name: 'Day shift', kind: 'work', start_time: '09:00', end_time: '17:00', break_minutes: 30, colour: 'blue' }, { method: 'PUT' }); assert.equal(fields.status, 200);
      const state = await request(`/api/state?week=${week}`); assert.equal(state.data.shifts.find(s => s.person_id === colleagueIds[0]).start_time, '08:00');
      const manual = state.data.shifts.find(s => s.person_id === colleagueIds[60]);
      assert.equal(manual.break_start, '12:15'); assert.equal(manual.department, 'Engraving'); assert.equal(manual.warehouse, 'Warehouse 2');
      const colleague = state.data.people.find(p => p.id === colleagueIds[60]);
      assert.notEqual(colleague.default_department, 'Engraving');
      const changed = colleague.default_department === 'Picking' ? 'Packing' : 'Picking';
      await request('/api/people/' + colleague.id, { ...colleague, contract_hours: 40, default_department: changed }, { method: 'PUT' });
      const saved = (await request(`/api/state?week=${week}`)).data.shifts.find(s => s.id === manual.id);
      assert.equal(saved.department, 'Engraving'); assert.equal(saved.warehouse, 'Warehouse 2');
    });
    await t.test('Bulk overlap failure rolls back the entire assignment', async () => {
      const r = await request('/api/shifts/bulk', { location_id: locationId, warehouse: 'Warehouse 1', person_ids: [colleagueIds[64], colleagueIds[0]], dates: ['2026-10-05'], kind: 'work', start_time: '08:00', end_time: '16:00', break_minutes: 0 }); assert.equal(r.status, 422);
      const state = await request(`/api/state?week=${week}`); assert.equal(state.data.shifts.length, 301); assert.equal(state.data.shifts.some(s => s.person_id === colleagueIds[64]), false);
    });
    await t.test('Overnight shifts cannot overlap a following-day shift', async () => {
      const night = await request('/api/shifts', { location_id: locationId, warehouse: 'Warehouse 1', person_id: colleagueIds[61], date: '2026-10-09', start_time: '22:00', end_time: '06:00', break_minutes: 30 }); assert.equal(night.status, 200);
      const overlap = await request('/api/shifts', { location_id: locationId, warehouse: 'Warehouse 1', person_id: colleagueIds[61], date: '2026-10-10', start_time: '05:00', end_time: '12:00', break_minutes: 0 }); assert.equal(overlap.status, 422);
      const adjacent = await request('/api/shifts', { location_id: locationId, warehouse: 'Warehouse 1', person_id: colleagueIds[61], date: '2026-10-10', start_time: '06:00', end_time: '12:00', break_minutes: 0 }); assert.equal(adjacent.status, 200);
    });
    await t.test('Holidays block work and invalid dates or breaks are rejected', async () => {
      const leave = await request('/api/shifts', { location_id: locationId, warehouse: 'Warehouse 1', person_id: colleagueIds[62], date: '2026-10-05', kind: 'holiday', label: 'Holiday' }); assert.equal(leave.status, 200);
      const overlap = await request('/api/shifts', { location_id: locationId, warehouse: 'Warehouse 1', person_id: colleagueIds[62], date: '2026-10-05', start_time: '09:00', end_time: '17:00', break_minutes: 0 }); assert.equal(overlap.status, 422);
      const badDate = await request('/api/shifts', { location_id: locationId, warehouse: 'Warehouse 1', person_id: colleagueIds[64], date: '2026-02-30', start_time: '09:00', end_time: '17:00' }); assert.equal(badDate.status, 400);
      const badBreak = await request('/api/shifts', { location_id: locationId, warehouse: 'Warehouse 1', person_id: colleagueIds[64], date: '2026-10-05', start_time: '09:00', end_time: '10:00', break_minutes: 60 }); assert.equal(badBreak.status, 400);
    });
    let publishedCount;
    await t.test('Shared rota shows published data and hides manager-only fields', async () => {
      const before = await request(`/api/public/${shareToken}?week=${week}`, undefined, { public: true }); assert.equal(before.data.unpublished, true);
      const publish = await request('/api/publish', { location_id: locationId, week }); assert.equal(publish.status, 200);
      const shared = await request(`/api/public/${shareToken}?week=${week}`, undefined, { public: true }); assert.equal(shared.data.people.length, 65); publishedCount = shared.data.shifts.length;
      assert.deepEqual([...new Set(shared.data.shifts.filter(s => s.kind === 'work').map(s => s.warehouse))].sort(), ['Warehouse 1', 'Warehouse 2']);
      assert.equal(shared.data.shifts.find(s => s.person_id === colleagueIds[60]).department, 'Engraving');
      assert.equal(shared.data.people[0].contract_minutes, undefined); assert.equal(shared.data.shifts[0].note, undefined); assert.equal(shared.data.locations, undefined); assert.equal(shared.data.revision, undefined);
      assert.match(shared.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    });
    await t.test('Unpublished edits remain invisible until republishing', async () => {
      await request('/api/shifts', { location_id: locationId, warehouse: 'Warehouse 1', person_id: colleagueIds[64], date: '2026-10-05', start_time: '09:00', end_time: '17:00', break_minutes: 30 });
      const shared = await request(`/api/public/${shareToken}?week=${week}`, undefined, { public: true }); assert.equal(shared.data.shifts.length, publishedCount);
      const state = await request(`/api/state?week=${week}`); assert.equal(state.data.publications[0].dirty, true);
      await request('/api/publish', { location_id: locationId, week });
      const updated = await request(`/api/public/${shareToken}?week=${week}`, undefined, { public: true }); assert.equal(updated.data.shifts.length, publishedCount + 1);
    });
    await t.test('Read-only visitors cannot edit, publish, export or access backups', async () => {
      assert.equal((await request('/api/people/' + colleagueIds[0] + '/performance', undefined, { public: true })).status, 401);
      for (const endpoint of ['/api/people', '/api/shifts', '/api/publish', '/api/share/reset']) assert.equal((await request(endpoint, {}, { public: true })).status, 401);
      const backup = await fetch(base + '/api/backup'); assert.equal(backup.status, 401);
      const exportFile = await fetch(base + `/api/export.csv?locationId=${locationId}&week=${week}`); assert.equal(exportFile.status, 401);
    });
    await t.test('Optimistic concurrency rejects outdated manager changes', async () => {
      const r = await request('/api/people', { name: 'Stale change', location_id: locationId }, { revision: rev - 1 }); assert.equal(r.status, 409);
      assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM people WHERE name = 'Stale change'").get().n, 0);
    });
    await t.test('Copying a week retains existing assignments and skips conflicts', async () => {
      await request('/api/shifts', { location_id: locationId, warehouse: 'Warehouse 1', person_id: colleagueIds[0], date: '2026-10-12', start_time: '09:00', end_time: '15:00', break_minutes: 0 });
      const copy = await request('/api/weeks/copy', { location_id: locationId, week: '2026-10-12' }); assert.ok(copy.data.copied > 300); assert.equal(copy.data.skipped, 1);
      const copied = (await request('/api/state?week=2026-10-12')).data.shifts.find(s => s.person_id === colleagueIds[60]);
      assert.equal(copied.break_start, '12:15'); assert.equal(copied.department, 'Engraving'); assert.equal(copied.warehouse, 'Warehouse 2');
      const repeated = await request('/api/weeks/copy', { location_id: locationId, week: '2026-10-12' }); assert.equal(repeated.data.copied, 0);
    });
    await t.test('Real QR code, CSV export and consistent SQLite backup are available', async () => {
      const qr = await fetch(base + `/api/qr.svg?locationId=${locationId}`, { headers: { Cookie: cookie } }); assert.equal(qr.status, 200); assert.match(await qr.text(), /<svg/);
      const csv = await fetch(base + `/api/export.csv?locationId=${locationId}&week=${week}`, { headers: { Cookie: cookie } }); assert.equal(csv.status, 200); const csvText = await csv.text(); assert.match(csvText, /Unpaid break minutes/); assert.match(csvText, /"Department","Warehouse"/); assert.match(csvText, /Warehouse 2/);
      const backup = await fetch(base + '/api/backup', { headers: { Cookie: cookie } }); assert.equal(backup.status, 200);
      const bytes = Buffer.from(await backup.arrayBuffer()); assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');
    });
    await t.test('Resetting the shared link revokes the old QR and retains published weeks', async () => {
      const reset = await request('/api/share/reset', { location_id: locationId });
      assert.equal((await request(`/api/public/${shareToken}`, undefined, { public: true })).status, 404);
      shareToken = reset.data.share_token;
      assert.equal((await request(`/api/public/${shareToken}?week=${week}`, undefined, { public: true })).data.people.length, 65);
    });
    await t.test('Data and shared links survive an app restart', async () => {
      await app.close(); app = createRotaServer({ dataDir: dir, password: 'test-manager-password', seedExamples: false }); base = await listen();
      const state = await request(`/api/state?week=${week}`); assert.equal(state.status, 200); assert.equal(state.data.people.length, 65);
      assert.equal((await request(`/api/public/${shareToken}?week=${week}`, undefined, { public: true })).status, 200);
    });
    await t.test('Changing the manager password invalidates existing sessions', async () => {
      await app.close(); app = createRotaServer({ dataDir: dir, password: 'new-test-manager-password', seedExamples: false }); base = await listen();
      assert.equal((await request('/api/state')).status, 401);
    });
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
