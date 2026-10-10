import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDashboardReader } from '../lib/dashboard.mjs';
import { createRotaServer, today, monday, addDays } from '../server.mjs';

const person = { id: 'alex', name: 'Alex Reid' };
const shift = (date, extra = {}) => ({ person_id: person.id, date, kind: 'work', start_time: '08:00', end_time: '16:00', ...extra });
const row = (name, total, rate) => ({ name, total, avgPerHour: rate });
const response = data => new Response(JSON.stringify(data));
const peers = rate => ['Peer A', 'Peer B', 'Peer C'].map(name => row(name, 80, rate));
const makeReader = (fetch, now = '2026-10-03T20:00:00Z') => createDashboardReader({ getURL: () => 'https://history.onrender.com', getKey: () => 'private-test-integration-key', now: () => new Date(now), fetch });
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} differs from ${expected}`);

test('Weekly totals and averages use only the colleague’s scheduled dates, count split shifts once and retain genuine zeros', async () => {
  const calls = [];
  const reader = makeReader(async (url, options) => {
    const date = new URL(url).searchParams.get('date'); calls.push(date);
    assert.equal(options.headers['X-Rota-Key'], 'private-test-integration-key');
    const metrics = { '2026-09-28': [100, 20, 10], '2026-09-29': [300, 30, 20], '2026-10-02': [0, 0, 5] }[date];
    const picking = metrics ? [row(person.name, metrics[0], metrics[1]), ...peers(metrics[2]), row('Inactive', 0, 0), row('Duplicate', 1, 99), row(' Duplicate ', 2, 99)] : [];
    return response({ date, complete: true, picking, packing: date === '2026-10-01' ? [row(person.name, 200, 40), ...peers(20)] : [] });
  }, '2026-10-02T18:00:00Z');
  const shifts = [shift('2026-09-28', { end_time: '12:00' }), shift('2026-09-28', { start_time: '13:00' }), shift('2026-09-29', { kind: 'training' }), shift('2026-09-30', { kind: 'holiday' }), shift('2026-10-01'), shift('2026-10-02'), shift('2026-10-03'), shift('2026-10-04'), shift('2026-09-27'), shift('2026-09-30', { person_id: 'someone-else' })];
  const data = await reader.weeklyProfile(person, shifts, '2026-09-28');
  assert.deepEqual(calls.sort(), ['2026-09-28', '2026-09-29', '2026-10-01', '2026-10-02']);
  assert.equal(data.scheduledDays, 6); assert.equal(data.elapsedDays, 4); assert.equal(data.recordedDays, 4); assert.equal(data.upcomingDays, 2);
  assert.equal(data.days[0].shiftCount, 2); assert.equal(data.days[4].status, 'upcoming');
  assert.equal(data.summary.picking.total, 400); assert.equal(data.summary.picking.recordedDays, 3);
  closeTo(data.summary.picking.averagePerDay, 400 / 3); closeTo(data.summary.picking.averagePerHour, 50 / 3);
  closeTo(data.summary.picking.comparison.percentDifference, (50 / 35 - 1) * 100);
  assert.equal(data.summary.picking.comparison.minColleagues, 3);
  assert.equal(data.summary.packing.total, 200); assert.equal(data.summary.packing.averagePerHour, 40); assert.equal(data.summary.packing.comparison.percentDifference, 100);
  assert.ok(!JSON.stringify(data).includes('Peer A')); assert.ok(!JSON.stringify(data).includes('private-test-integration-key'));
});

test('Missing history, ambiguous names and a failed day are excluded; partial history cannot provide team benchmarks', async () => {
  const reader = makeReader(async url => {
    const date = new URL(url).searchParams.get('date');
    if (date === '2026-09-18') return new Response('', { status: 502 });
    if (date === '2026-09-15') return response({ date, complete: true, available: false, picking: [], packing: [] });
    return response({ date, complete: date !== '2026-09-16', picking: [row(person.name, date === '2026-09-16' ? 300 : 100, date === '2026-09-16' ? 30 : 10), ...peers(10), ...(date === '2026-09-17' ? [row(' Alex Reid ', 900, 90)] : [])], packing: [] });
  });
  const data = await reader.weeklyProfile(person, Array.from({ length: 5 }, (_, i) => shift(addDays('2026-09-14', i))), '2026-09-14');
  assert.deepEqual(data.days.map(day => day.status), ['recorded', 'missing', 'recorded', 'missing', 'error']);
  assert.equal(data.summary.picking.total, 400); assert.equal(data.summary.picking.averagePerDay, 200); assert.equal(data.summary.picking.averagePerHour, 20);
  assert.equal(data.summary.picking.comparison.days, 1); assert.equal(data.summary.packing.total, null);
  assert.equal(data.limited, true); assert.equal(data.ambiguous, true); assert.match(data.days[4].error, /could not be reached/);
});

test('An overnight shift is linked to its start date and a later shift today is not fetched before it starts', async () => {
  const calls = [];
  const reader = makeReader(async url => { const date = new URL(url).searchParams.get('date'); calls.push(date); return response({ date, complete: true, picking: [row(person.name, 50, 10)], packing: [] }); }, '2026-09-29T05:00:00Z');
  const data = await reader.weeklyProfile(person, [shift('2026-09-28', { start_time: '22:00', end_time: '06:30' }), shift('2026-09-29', { start_time: '20:00', end_time: '23:00' })], '2026-09-28');
  assert.deepEqual(calls, ['2026-09-28']); assert.equal(data.days[0].inProgress, true); assert.equal(data.days[1].status, 'upcoming');
  assert.equal(data.inProgress, true); assert.equal(data.summary.picking.total, 50);
});

test('Empty and future rota weeks issue no requests and show unavailable averages rather than zero', async () => {
  const reader = makeReader(async () => { throw new Error('Should not request data'); });
  const future = await reader.weeklyProfile(person, [shift('2026-10-05')], '2026-10-05');
  assert.equal(future.days[0].status, 'upcoming'); assert.equal(future.summary.picking.total, null); assert.equal(future.summary.picking.averagePerHour, null);
  const empty = await reader.weeklyProfile(person, [], '2026-09-28'); assert.equal(empty.days.length, 0);
  const disconnected = createDashboardReader({ getURL: () => '', getKey: () => '' });
  assert.equal((await disconnected.weeklyProfile(person, [shift('2026-09-28')], '2026-09-28')).configured, false);
});

test('Weekly hourly rates use recorded active hours, with the same date weights for the team comparison', async () => {
  const reader = makeReader(async url => {
    const date = new URL(url).searchParams.get('date'), first = date === '2026-09-28';
    return response({ date, complete: true, picking: [{ ...row(person.name, first ? 100 : 90, first ? 20 : 30), activeHours: first ? 5 : 1, completedHourlyTotal: first ? 100 : 30 }, ...peers(first ? 10 : 20)], packing: [] });
  });
  const data = await reader.weeklyProfile(person, [shift('2026-09-28'), shift('2026-09-29')], '2026-09-28');
  const summary = data.summary.picking;
  assert.equal(summary.total, 190); assert.equal(summary.averageMethod, 'active-hours'); assert.equal(summary.activeHours, 6);
  closeTo(summary.averagePerHour, 130 / 6); closeTo(summary.comparison.teamAveragePerHour, 70 / 6); closeTo(summary.comparison.percentDifference, (130 / 70 - 1) * 100);
});

test('Weekly profiles share date caches while benchmarks exclude self, missing rates, duplicate identities and inactive peers', async () => {
  let calls = 0;
  const reader = makeReader(async url => { calls++; const date = new URL(url).searchParams.get('date'); return response({ date, complete: true, picking: [row(person.name, 100, 20), row('Another colleague', 80, 10), row('Missing rate', 100, null), row('Empty rate', 100, ''), row('Inactive', 0, 0), row('Ambiguous peer', 100, 200)], packing: [], ambiguousNames: { picking: ['ambiguous peer'] } }); });
  const first = await reader.weeklyProfile(person, [shift('2026-09-28')], '2026-09-28');
  const other = { id: 'other', name: 'Another colleague' };
  const second = await reader.weeklyProfile(other, [shift('2026-09-28', { person_id: other.id })], '2026-09-28');
  assert.equal(calls, 1); assert.equal(first.summary.picking.comparison.teamAveragePerHour, 10); assert.equal(second.summary.picking.comparison.teamAveragePerHour, 20);
  assert.equal(first.summary.picking.comparison.minColleagues, 1); assert.ok(!JSON.stringify(first).includes(other.name));
});

test('The weekly API enforces manager access, the displayed week and location, and excludes holiday and unrelated shifts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-weekly-')), calls = [];
  const app = createRotaServer({ dataDir: dir, password: 'weekly-test-password', dashboardFetch: async url => { const date = new URL(url).searchParams.get('date'); calls.push(date); return response({ date, complete: true, picking: [row(person.name, 100, 20), ...peers(10)], packing: [] }); } });
  app.db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('dashboard_url', 'https://history.onrender.com');
  app.db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('dashboard_api_key', 'private-test-integration-key');
  const colleague = app.db.prepare('SELECT * FROM people LIMIT 1').get(), loc = app.db.prepare('SELECT * FROM locations LIMIT 1').get();
  app.db.prepare('UPDATE people SET leaderboard_name=? WHERE id=?').run(person.name, colleague.id);
  app.db.prepare('INSERT INTO locations (id,name,share_token,active) VALUES (?,?,?,?)').run('other-location', 'Another site', 'other-share-token', 1);
  const week = monday(addDays(today(), -14));
  const insert = app.db.prepare('INSERT INTO shifts (id,person_id,location_id,date,start_time,end_time,kind,label,colour,note) VALUES (?,?,?,?,?,?,?,?,?,?)');
  insert.run('one', colleague.id, loc.id, week, '08:00', '16:00', 'work', 'Shift', 'blue', 'Private manager note');
  insert.run('holiday', colleague.id, loc.id, addDays(week, 1), null, null, 'holiday', 'Holiday', 'blue', '');
  insert.run('other-site', colleague.id, 'other-location', addDays(week, 2), '08:00', '16:00', 'work', 'Shift', 'blue', '');
  insert.run('other-week', colleague.id, loc.id, addDays(week, -7), '08:00', '16:00', 'work', 'Shift', 'blue', '');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port, endpoint = '/api/people/' + colleague.id + '/performance';
  try {
    assert.equal((await fetch(base + endpoint + '?week=' + week)).status, 401);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rota-Request': '1' }, body: JSON.stringify({ password: 'weekly-test-password' }) });
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const get = route => fetch(base + endpoint + route, { headers });
    const valid = await get('?week=' + week + '&locationId=' + loc.id); assert.equal(valid.status, 200);
    const data = await valid.json(); assert.equal(data.days.length, 1); assert.equal(data.week, week); assert.equal(data.summary.picking.total, 100); assert.deepEqual(calls, [week]);
    assert.ok(!JSON.stringify(data).includes('Private manager note')); assert.ok(!JSON.stringify(data).includes('Peer A'));
    const other = await (await get('?week=' + week + '&locationId=other-location')).json(); assert.equal(other.days[0].date, addDays(week, 2));
    assert.equal((await get('?week=2026-02-30')).status, 400); assert.equal((await get('?week=' + week + '&date=' + week)).status, 400);
    assert.equal((await get('?week=' + week + '&locationId=missing')).status, 404);
    const future = await (await get('?week=' + monday(addDays(today(), 14)))).json(); assert.equal(future.days.length, 0); assert.equal(calls.length, 2);
    const publicData = await (await fetch(base + '/api/public/' + loc.share_token)).json(); assert.equal(publicData.summary, undefined); assert.equal(publicData.dashboard, undefined);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
