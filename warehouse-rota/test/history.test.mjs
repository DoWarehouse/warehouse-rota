import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDashboardReader } from '../lib/dashboard.mjs';
import { createRotaServer, today, addDays } from '../server.mjs';
const reply = data => new Response(JSON.stringify(data), { status: 200 });
const person = { name: '  Alex  Reid ' };
const record = (date, total) => ({ date, complete: true, picking: [{ name: 'Alex Reid', total, avgPerHour: 10, peakTotal: 20, peakHour: '11:00' }, { name: 'Someone Else', total: 999 }], packing: [] });

test('Historical dates have separate shared caches and expose only the chosen colleague', async () => {
  const calls = [];
  const reader = createDashboardReader({ getURL: () => 'https://history.onrender.com', getKey: () => 'private-history-key', fetch: async (url, options) => {
    const date = new URL(url).searchParams.get('date'); calls.push(date);
    assert.equal(options.headers['X-Rota-Key'], 'private-history-key');
    return reply(record(date, date.endsWith('01') ? 101 : 202));
  } });
  const [a, b, c] = await Promise.all([reader.profile(person, '2026-09-01'), reader.profile(person, '2026-09-02'), reader.profile(person, '2026-09-01')]);
  assert.equal(a.picking.total, 101); assert.equal(b.picking.total, 202); assert.equal(c.date, '2026-09-01');
  assert.equal(a.historical, true); assert.equal(JSON.stringify(a).includes('Someone Else'), false);
  await reader.profile(person, '2026-09-02'); assert.equal(calls.length, 2);
});
test('Old dashboard history fallback never uses today for a previous date', async () => {
  const calls = [];
  const reader = createDashboardReader({ getURL: () => 'https://history.onrender.com', getKey: () => 'private-history-key', fetch: async (url, options) => {
    calls.push(url);
    if (url.includes('/api/rota-leaderboard')) return new Response('', { status: 404 });
    assert.equal(options.headers['X-Rota-Key'], undefined);
    return reply({ date: '2026-09-01', selected: { date: '2026-09-01', capturedAt: '2026-09-01T16:00:00Z', picking: record('2026-09-01', 123).picking, packing: [] } });
  } });
  const data = await reader.profile(person, '2026-09-01');
  assert.equal(data.picking.total, 123); assert.equal(data.picking.rank, null); assert.equal(data.limited, true);
  assert.match(calls[1], /\/api\/history\?date=2026-09-01&time=23:59$/);
  assert.ok(calls.every(url => !url.includes('/api/dashboard')));
});
test('Missing, mismatched and ambiguous historical records are not assigned as valid totals', async () => {
  const make = data => createDashboardReader({ getURL: () => 'https://history.onrender.com', getKey: () => '', fetch: async () => reply(data) });
  await assert.rejects(make(record('2026-09-02', 999)).profile(person, '2026-09-01'), /different date/);
  const missing = await make({ date: '2026-09-01', available: false, picking: [], packing: [] }).profile(person, '2026-09-01');
  assert.equal(missing.available, false); assert.equal(missing.picking, null);
  const duplicate = await make({ ...record('2026-09-01', 123), limited: true, ambiguousNames: { picking: ['alex reid'] } }).profile(person, '2026-09-01');
  assert.equal(duplicate.picking, null); assert.equal(duplicate.ambiguous, true);
  await assert.rejects(make(record('2026-09-01', 123)).profile(person, '2026-02-30'), /valid performance date/);
});
test('An in-flight read from the old connection cannot contaminate a newly saved connection', async () => {
  let key = 'old-private-key', release;
  const reader = createDashboardReader({ getURL: () => 'https://history.onrender.com', getKey: () => key, fetch: async (_, options) => {
    if (options.headers['X-Rota-Key'] === 'old-private-key') await new Promise(resolve => { release = resolve; });
    return reply(record('2026-09-01', options.headers['X-Rota-Key'] === 'old-private-key' ? 1 : 2));
  } });
  const before = reader.profile(person, '2026-09-01'); await new Promise(resolve => setImmediate(resolve));
  key = 'new-private-key'; reader.reset();
  assert.equal((await reader.profile(person, '2026-09-01')).picking.total, 2);
  release(); await before;
  assert.equal((await reader.profile(person, '2026-09-01')).picking.total, 2);
});
test('Performance date requests require manager authentication and reject future dates', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-history-'));
  const app = createRotaServer({ dataDir: dir, password: 'history-test-password', dashboardFetch: async url => reply(record(new URL(url).searchParams.get('date'), 123)) });
  app.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('dashboard_url', 'https://history.onrender.com');
  app.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('dashboard_api_key', 'private-history-key');
  const colleague = app.db.prepare('SELECT * FROM people LIMIT 1').get();
  app.db.prepare('UPDATE people SET leaderboard_name=? WHERE id=?').run('Alex Reid', colleague.id);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const endpoint = '/api/people/' + colleague.id + '/performance';
    assert.equal((await fetch(base + endpoint + '?date=2026-09-01')).status, 401);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rota-Request': '1' }, body: JSON.stringify({ password: 'history-test-password' }) });
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const response = await fetch(base + endpoint + '?date=2026-09-01', { headers });
    assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.date, '2026-09-01'); assert.equal(data.picking.total, 123);
    assert.equal((await fetch(base + endpoint + '?date=' + addDays(today(), 1), { headers })).status, 400);
    assert.equal((await fetch(base + endpoint + '?date=2026-02-30', { headers })).status, 400);
    const loc = app.db.prepare('SELECT * FROM locations').get();
    const publicData = await (await fetch(base + '/api/public/' + loc.share_token)).json();
    assert.equal(publicData.dashboard, undefined); assert.ok(!JSON.stringify(publicData).includes('private-history-key'));
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
