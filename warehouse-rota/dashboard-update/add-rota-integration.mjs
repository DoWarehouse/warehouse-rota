// Run this in the EXISTING dashboard folder: node add-rota-integration.mjs
// It adds one protected export and retains all other dashboard code and data.
import fs from 'node:fs';
import path from 'node:path';
const file = path.resolve(process.argv[2] || 'server.mjs');
let source = fs.readFileSync(file, 'utf8');
if (source.includes("url.pathname === '/api/rota-leaderboard'")) {
  console.log('Rota integration is already installed.');
  process.exit(0);
}
for (const marker of ['function userName(', 'function userRole(', 'function pickCount(', 'function packCount(', 'function userHourlyStats(', 'function parseLeaderboard(', 'async function hutchPost(', 'function demoData(', 'function londonDateParts(', 'const server = http.createServer(async (req, res) => {']) {
  if (!source.includes(marker)) throw new Error('The dashboard structure has changed. Integration was not applied; ask for an updated patch.');
}
const code = `
// Rota profile export: all colleagues, one leaderboard request per five minutes.
let rotaExportCache = null, rotaExportAt = 0, rotaExportPending = null;
async function rotaProfileExport() {
  if (rotaExportCache && Date.now() - rotaExportAt < 300000) return rotaExportCache;
  if (rotaExportPending) return rotaExportPending;
  rotaExportPending = (async () => {
    const date = londonDateParts().iso;
    if (DEMO_MODE) {
      const demo = demoData(DEFAULT_TARGET);
      rotaExportCache = { date, updatedAt: demo.updatedAt, mode: 'demo', picking: demo.picking, packing: demo.packing };
    } else {
      const raw = await hutchPost('/admin/Leaderboard', { date: hutchDatePayload() });
      const users = Array.isArray(raw?.users) ? raw.users : Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
      const picking = [], packing = [];
      for (const user of users) {
        const name = userName(user), role = userRole(user), picks = pickCount(user), packs = packCount(user);
        if (role === 'Picking' || picks > 0) picking.push({ name, total: picks, ...userHourlyStats(user, 'Picking') });
        if (role === 'Packing' || packs > 0) packing.push({ name, total: packs, ...userHourlyStats(user, 'Packing') });
      }
      picking.sort((a, b) => b.total - a.total); packing.sort((a, b) => b.total - a.total);
      rotaExportCache = { date, updatedAt: new Date().toISOString(), mode: 'live', picking, packing };
    }
    rotaExportAt = Date.now(); return rotaExportCache;
  })();
  try { return await rotaExportPending; } finally { rotaExportPending = null; }
}
`;
const serverMarker = 'const server = http.createServer(async (req, res) => {';
source = "import { timingSafeEqual as rotaKeyEqual } from 'node:crypto';\n" + source.replace(serverMarker, code + '\n' + serverMarker);
const routeMarker = "    if (req.method === 'GET' && url.pathname === '/api/dashboard') {";
if (!source.includes(routeMarker)) throw new Error('The dashboard route has changed. No file was updated.');
const route = `    if (req.method === 'GET' && url.pathname === '/api/rota-leaderboard') {
      const expected = process.env.ROTA_API_KEY || '', supplied = String(req.headers['x-rota-key'] || '');
      if (expected.length < 16 || Buffer.byteLength(expected) !== Buffer.byteLength(supplied) || !rotaKeyEqual(Buffer.from(expected), Buffer.from(supplied))) return json(res, 401, { error: 'Rota integration key required' });
      try { return json(res, 200, await rotaProfileExport()); }
      catch { return json(res, 502, { error: 'Dashboard leaderboard unavailable' }); }
    }
`;
source = source.replace(routeMarker, route + routeMarker);
const backup = file + '.before-rota.bak';
if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
fs.writeFileSync(file, source);
console.log('Added the protected rota export. Existing dashboard views, history and settings are retained. Set ROTA_API_KEY to a private key of at least 16 characters.');
