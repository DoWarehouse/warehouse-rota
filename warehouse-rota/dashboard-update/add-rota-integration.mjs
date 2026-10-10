// Upload beside the EXISTING dashboard server.mjs; run during its Render build.
// Keeps its views, history, targets, credentials and cycle-time jobs in place.
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.argv[2] || 'server.mjs');
let source = fs.readFileSync(file, 'utf8');
const original = source;
const serverMarker = 'const server = http.createServer(async (req, res) => {';
const routeMarker = "    if (req.method === 'GET' && url.pathname === '/api/dashboard') {";
const rememberMarker = '  const leaderboard = parseLeaderboard(leaderboardRaw);';
const snapshotMarker = '  const snapshot = {\n    ...data,';
const publicHistoryMarker = '        selected,\n        comparison: previous ? { date: previousDate, snapshot: previous } : null,';
const cryptoImport = "import { timingSafeEqual as rotaKeyEqual } from 'node:crypto';\n";

if (source.includes('// Rota employee history export v2.') && source.includes("url.pathname === '/api/rota-leaderboard'")) {
  console.log('Rota employee history integration is already installed.');
  process.exit(0);
}
// Upgrade only the exact previous supplied integration, never an unknown route.
if (source.includes("url.pathname === '/api/rota-leaderboard'")) {
  const start = source.indexOf('// Rota profile export: all colleagues, one leaderboard request per five minutes.');
  const end = source.indexOf(serverMarker, start);
  const oldStart = source.indexOf("    if (req.method === 'GET' && url.pathname === '/api/rota-leaderboard') {");
  const oldEnd = source.indexOf(routeMarker, oldStart);
  if (start < 0 || end < start || oldStart < end || oldEnd < oldStart ||
      !source.slice(oldStart, oldEnd).includes('await rotaProfileExport()') ||
      !source.slice(oldStart, oldEnd).includes('rotaKeyEqual(Buffer.from(expected), Buffer.from(supplied))')) {
    throw new Error('The existing integration differs. No file was updated; provide the current dashboard server for an updated patch.');
  }
  source = source.slice(0, oldStart) + source.slice(oldEnd);
  source = source.slice(0, start) + source.slice(end);
  source = source.replace(cryptoImport, '');
}
for (const marker of [serverMarker, routeMarker, rememberMarker, snapshotMarker, publicHistoryMarker, 'function userName(', 'function userRole(', 'function pickCount(', 'function packCount(', 'function userHourlyStats(', 'async function readSnapshots(', 'function dailyPersonBest(', 'function hutchDatePayload(', 'function londonDateParts(', 'async function hutchPost(', 'function demoData(']) {
  if (!source.includes(marker) || source.indexOf(marker) !== source.lastIndexOf(marker)) {
    throw new Error('The dashboard structure differs. No file was updated; provide the current dashboard server for an updated patch.');
  }
}

const code = String.raw`
// Rota employee history export v2.
// Reuses the dashboard's existing reads; full future snapshots stay server-side.
let rotaExportCache = null, rotaExportAt = 0, rotaExportPending = null;
function rotaPublicSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  const { rotaPerformance, ...visible } = snapshot;
  return visible;
}
const rotaPersonName = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB');
function rotaRememberLeaderboard(raw, date) {
  const users = Array.isArray(raw?.users) ? raw.users : Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
  const picking = [], packing = [];
  for (const user of users) {
    const name = userName(user), role = userRole(user), picks = pickCount(user), packs = packCount(user);
    if (role === 'Picking' || picks > 0) picking.push({ name, total: picks, ...userHourlyStats(user, 'Picking') });
    if (role === 'Packing' || packs > 0) packing.push({ name, total: packs, ...userHourlyStats(user, 'Packing') });
  }
  picking.sort((a, b) => b.total - a.total); packing.sort((a, b) => b.total - a.total);
  rotaExportCache = { version: 2, date, updatedAt: new Date().toISOString(), mode: 'live', complete: true, picking, packing };
  rotaExportAt = Date.now();
  return rotaExportCache;
}
function rotaHistoryDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T12:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= '2020-01-01' && value <= londonDateParts().iso;
}
async function rotaHistoricalPerformance(date) {
  const snapshots = (await readSnapshots(date)).filter(s => (s.date || s.localDate) === date);
  const full = snapshots.filter(s => s.rotaPerformance?.date === date && s.rotaPerformance.complete === true && Array.isArray(s.rotaPerformance.picking) && Array.isArray(s.rotaPerformance.packing));
  const latest = full.at(-1);
  if (latest) return { ...latest.rotaPerformance, historical: true, available: true, source: 'saved-full-snapshot', snapshotTime: latest.capturedAt, updatedAt: latest.capturedAt || latest.rotaPerformance.updatedAt };
  const ambiguousNames = {};
  for (const kind of ['picking', 'packing']) {
    const duplicates = new Set();
    for (const snap of snapshots) {
      const seen = new Set();
      for (const row of Array.isArray(snap[kind]) ? snap[kind] : []) {
        const name = rotaPersonName(row.name);
        if (seen.has(name)) duplicates.add(name);
        seen.add(name);
      }
    }
    ambiguousNames[kind] = [...duplicates];
  }
  return { version: 2, date, historical: true, available: snapshots.length > 0, complete: false, limited: true, source: snapshots.length ? 'saved-limited-snapshots' : 'no-snapshots', updatedAt: snapshots.at(-1)?.capturedAt || null, snapshotTime: snapshots.at(-1)?.capturedAt || null, ambiguousNames, picking: dailyPersonBest(snapshots, 'picking'), packing: dailyPersonBest(snapshots, 'packing') };
}
async function rotaProfileExport(date) {
  if (date < londonDateParts().iso) return rotaHistoricalPerformance(date);
  if (rotaExportCache?.date === date && Date.now() - rotaExportAt < 300000) return { ...rotaExportCache, historical: false, available: true };
  if (rotaExportPending) return rotaExportPending;
  rotaExportPending = (async () => {
    if (DEMO_MODE) {
      const demo = demoData(DEFAULT_TARGET);
      return { version: 2, date, updatedAt: demo.updatedAt, mode: 'demo', historical: false, available: true, complete: false, picking: demo.picking, packing: demo.packing };
    }
    const payloadDate = hutchDatePayload();
    const raw = await hutchPost('/admin/Leaderboard', { date: payloadDate });
    return { ...rotaRememberLeaderboard(raw, payloadDate.slice(0, 10)), historical: false, available: true };
  })();
  try { return await rotaExportPending; } finally { rotaExportPending = null; }
}
`;
const route = String.raw`    if (req.method === 'GET' && url.pathname === '/api/rota-leaderboard') {
      const expected = process.env.ROTA_API_KEY || '', supplied = String(req.headers['x-rota-key'] || '');
      if (expected.length < 16 || Buffer.byteLength(expected) !== Buffer.byteLength(supplied) || !rotaKeyEqual(Buffer.from(expected), Buffer.from(supplied))) return json(res, 401, { error: 'Rota integration key required' });
      const date = url.searchParams.get('date') || londonDateParts().iso;
      if (!rotaHistoryDate(date)) return json(res, 400, { error: 'Choose a valid date up to today.' });
      try { return json(res, 200, await rotaProfileExport(date)); }
      catch { return json(res, 502, { error: 'Dashboard employee performance unavailable' }); }
    }
`;
source = cryptoImport + source.replace(serverMarker, code + '\n' + serverMarker);
source = source.replace(routeMarker, route + routeMarker);
source = source.replace(rememberMarker, rememberMarker + '\n  rotaRememberLeaderboard(leaderboardRaw, date);');
source = source.replace(snapshotMarker, snapshotMarker + '\n    rotaPerformance: rotaExportCache?.date === data.date ? rotaExportCache : undefined,');
source = source.replace(publicHistoryMarker, '        selected: rotaPublicSnapshot(selected),\n        comparison: previous ? { date: previousDate, snapshot: rotaPublicSnapshot(previous) } : null,');
const backup = file + '.before-rota-history.bak';
if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
fs.writeFileSync(file, source);
console.log('Added employee history integration. Future snapshots include all supplied colleagues; older partial snapshots are labelled. Set ROTA_API_KEY to a private key of at least 16 characters.');
