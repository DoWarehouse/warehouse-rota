import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { coverageForDay } from '../public/coverage.js';
import { createDashboardReader, dashboardURL } from '../lib/dashboard.mjs';
import { createRotaServer } from '../server.mjs';

const shift = (id, start = '12:00') => ({ id, person_id: id, date: '2026-10-05', kind: 'work', start_time: '08:00', end_time: '16:30', break_minutes: 30, break_start: start, department: 'Picking', warehouse: 'Warehouse 1' });
test('Coverage distinguishes staggered breaks, overlapping breaks and exact-minute gaps', () => {
  const options = { warehouse: 'Warehouse 1', department: 'Picking', start: 480, end: 990 };
  const staggered = coverageForDay([shift('a'), shift('b', '12:30')], '2026-10-05', options);
  assert.equal(staggered.gaps.length, 0);
  assert.equal(staggered.segments.find(s => s.start === 720).available, 1);
  const overlapping = coverageForDay([shift('a', '12:07'), shift('b', '12:07')], '2026-10-05', options);
  assert.deepEqual(overlapping.gaps.map(s => [s.start, s.end, s.available]), [[727, 757, 0]]);
  const unknown = coverageForDay([shift('a', null)], '2026-10-05', options);
  assert.ok(unknown.segments.every(s => s.status === 'unconfirmed'));
  assert.equal(unknown.unplaced.length, 1);
  const otherWarehouse = { ...shift('b'), warehouse: 'Warehouse 2' };
  assert.equal(coverageForDay([shift('a'), otherWarehouse], '2026-10-05', options).gaps.length, 1);
});
test('Overnight cover and next-day breaks are included; absences provide no cover', () => {
  const night = { ...shift('night', '03:00'), date: '2026-10-04', start_time: '22:00', end_time: '06:00' };
  const data = coverageForDay([night, { ...shift('holiday'), kind: 'holiday' }], '2026-10-05', { start: 0, end: 360 });
  assert.equal(data.segments[0].available, 1);
  assert.deepEqual(data.gaps.map(s => [s.start, s.end]), [[180, 210]]);
});
test('Dashboard matches exact names and shares one cached read across profiles', async () => {
  let reads = 0;
  const reader = createDashboardReader({ getURL: () => 'https://test-dashboard.onrender.com', getKey: () => 'test-integration-key', fetch: async (url, options) => {
    reads++; assert.match(url, /\/api\/rota-leaderboard$/); assert.equal(options.headers['X-Rota-Key'], 'test-integration-key');
    return new Response(JSON.stringify({ date: '2026-10-05', mode: 'live', picking: Array.from({ length: 12 }, (_, i) => ({ name: `Colleague ${i}`, total: 120 - i, avgPerHour: 20, peakTotal: 35, peakHour: '11:00' })), packing: [] }), { status: 200 });
  } });
  const profile = await reader.profile({ name: 'Person', leaderboard_name: '  COLLEAGUE   11 ' });
  assert.equal(profile.picking.total, 109); assert.equal(profile.picking.rank, 12); assert.equal(profile.packing, null);
  const missing = await reader.profile({ name: 'Colleague' }); assert.equal(missing.picking, null);
  assert.equal(reads, 1);
  assert.throws(() => dashboardURL('http://169.254.169.254'), /HTTPS/);
  assert.throws(() => dashboardURL('https://token@example.com'), /HTTPS/);
});
test('Ambiguous dashboard names are not assigned and the old endpoint is marked limited', async () => {
  let reads = 0;
  const reader = createDashboardReader({ getURL: () => 'https://test-dashboard.onrender.com', getKey: () => '', fetch: async () => {
    reads++; return reads === 1 ? new Response('', { status: 404 }) : new Response(JSON.stringify({ picking: [{ name: 'Alex', total: 1 }, { name: 'Alex', total: 2 }], packing: [] }), { status: 200 });
  } });
  const data = await reader.profile({ name: 'Alex' }); assert.equal(data.picking, null); assert.equal(data.ambiguous, true); assert.equal(data.limited, true);
});
test('A fresh app has only ten example colleagues and all rotas stay private until publishing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-starter-'));
  const app = createRotaServer({ dataDir: dir, password: 'planning-test-password' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM people').get().n, 10);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM people WHERE is_example = 1').get().n, 10);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM publications').get().n, 0);
    const loc = app.db.prepare('SELECT * FROM locations').get();
    const publicData = await (await fetch(base + '/api/public/' + loc.share_token)).json();
    assert.equal(publicData.people.length, 0); assert.equal(publicData.unpublished, true);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rota-Request': '1' }, body: JSON.stringify({ password: 'planning-test-password' }) });
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'X-Rota-Request': '1' };
    let state = await (await fetch(base + '/api/state?week=2026-10-05', { headers })).json();
    const create = async (body, endpoint = '/api/shifts') => {
      const response = await fetch(base + endpoint, { method: 'POST', headers: { ...headers, 'If-Match': String(state.revision) }, body: JSON.stringify(body) });
      const data = await response.json(); if (response.ok) state.revision = data.revision;
      return { response, data };
    };
    const body = { ...shift(state.people[0].id, '16:15'), person_id: state.people[0].id, location_id: loc.id };
    assert.equal((await create(body)).response.status, 400);
    const working = await create({ ...body, break_start: '12:00' }); assert.equal(working.response.status, 200);
    assert.equal((await fetch(base + `/api/export.pdf?locationId=${loc.id}&week=2026-10-05`, { headers })).status, 404);
    await create({ location_id: loc.id, week: '2026-10-05' }, '/api/publish');
    for (const layout of ['warehouse', 'department', 'az', 'overview']) {
      const pdf = await fetch(base + `/api/export.pdf?locationId=${loc.id}&week=2026-10-05&layout=${layout}`, { headers });
      assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
      assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    }
    const published = await (await fetch(base + '/api/public/' + loc.share_token + '?week=2026-10-05')).json();
    assert.equal(published.shifts[0].break_start, '12:00'); assert.equal(published.people[0].leaderboard_name, undefined); assert.equal(published.dashboard, undefined);
    assert.equal((await fetch(base + `/api/public/${loc.share_token}/pdf?week=2026-10-05`)).status, 200);
    const hidden = await create({ ...body, date: '2026-10-06', break_start: '12:30' }); assert.equal(hidden.response.status, 200);
    assert.equal((await (await fetch(base + '/api/public/' + loc.share_token + '?week=2026-10-05')).json()).shifts.length, 1);
    const unpublish = await fetch(base + '/api/publish', { method: 'DELETE', headers: { ...headers, 'If-Match': String(state.revision) }, body: JSON.stringify({ location_id: loc.id, week: '2026-10-05' }) }); assert.equal(unpublish.status, 200);
    assert.equal((await fetch(base + `/api/public/${loc.share_token}/pdf?week=2026-10-05`)).status, 404);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
