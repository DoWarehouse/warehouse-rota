import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRotaServer } from '../server.mjs';

test('Manager deletion removes only the selected colleague and draft shifts while preserving published copies', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-delete-'));
  let app = createRotaServer({ dataDir: dir, password: 'deletion-test-password', seedExamples: false });
  const listen = async () => { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${app.server.address().port}`; };
  let base = await listen(), cookie = '', revision = 0;
  const request = async (endpoint, method = 'GET', body, options = {}) => {
    const headers = { ...(options.public ? {} : { Cookie: cookie }), 'Content-Type': 'application/json', 'X-Rota-Request': '1', 'If-Match': String(options.revision ?? revision) };
    const response = await fetch(base + endpoint, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const data = await response.json();
    if (response.ok && data.revision !== undefined) revision = data.revision;
    return { status: response.status, data, response };
  };
  try {
    const login = await request('/api/login', 'POST', { password: 'deletion-test-password' });
    cookie = login.response.headers.get('set-cookie').split(';')[0];
    const state = (await request('/api/state?week=2026-10-05')).data;
    const loc = state.locations[0];
    const colleague = (await request('/api/people', 'POST', { name: 'Delete this colleague', location_id: loc.id, default_department: 'Picking' })).data.id;
    const retained = (await request('/api/people', 'POST', { name: 'Keep this colleague', location_id: loc.id, default_department: 'Packing' })).data.id;
    const shift = { location_id: loc.id, start_time: '08:00', end_time: '16:30', break_minutes: 30, break_start: '12:00', warehouse: 'Warehouse 1' };
    for (const date of ['2026-09-28', '2026-10-05', '2026-10-12']) assert.equal((await request('/api/shifts', 'POST', { ...shift, person_id: colleague, date })).status, 200);
    await request('/api/shifts', 'POST', { ...shift, person_id: retained, date: '2026-10-05' });
    await request('/api/publish', 'POST', { location_id: loc.id, week: '2026-10-05' });
    const originalPublication = app.db.prepare('SELECT snapshot FROM publications').get().snapshot;
    const originalRevision = revision;
    assert.equal((await request('/api/people/' + colleague, 'DELETE', { confirm: true }, { public: true })).status, 401);
    assert.equal((await request('/api/people/' + colleague, 'DELETE')).status, 400);
    assert.equal((await request('/api/people/' + colleague, 'DELETE', { confirm: true }, { revision: revision - 1 })).status, 409);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE person_id = ?').get(colleague).n, 3);
    const deleted = await request('/api/people/' + colleague, 'DELETE', { confirm: true });
    assert.equal(deleted.status, 200); assert.equal(deleted.data.removed_shifts, 3); assert.equal(revision, originalRevision + 1);
    assert.equal(app.db.prepare('SELECT * FROM people WHERE id = ?').get(colleague), undefined);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE person_id = ?').get(colleague).n, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE person_id = ?').get(retained).n, 1);
    assert.equal(app.db.prepare('SELECT snapshot FROM publications').get().snapshot, originalPublication);
    assert.equal(app.db.prepare('SELECT share_token FROM locations').get().share_token, loc.share_token);
    const draft = (await request('/api/state?week=2026-10-05')).data;
    assert.equal(draft.people.length, 1); assert.equal(draft.people[0].id, retained); assert.equal(draft.publications[0].dirty, true);
    const published = (await request(`/api/public/${loc.share_token}?week=2026-10-05`, 'GET', undefined, { public: true })).data;
    assert.equal(published.people.length, 2); assert.ok(published.people.some(p => p.id === colleague));
    assert.equal((await request('/api/people/' + colleague, 'DELETE', { confirm: true })).status, 404);
    assert.equal((await request('/api/shifts', 'POST', { ...shift, person_id: colleague, date: '2026-10-06' })).status, 404);
    await request('/api/publish', 'POST', { location_id: loc.id, week: '2026-10-05' });
    const updated = (await request(`/api/public/${loc.share_token}?week=2026-10-05`, 'GET', undefined, { public: true })).data;
    assert.equal(updated.people.length, 1); assert.equal(updated.shifts.length, 1); assert.equal(updated.people[0].id, retained);
    await app.close(); app = createRotaServer({ dataDir: dir, password: 'deletion-test-password' }); base = await listen();
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM people').get().n, 1);
    assert.equal(app.db.prepare('SELECT id FROM people').get().id, retained);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
