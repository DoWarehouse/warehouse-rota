const normalName = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB');
const londonToday = () => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type).value).join('-');
};
export function dashboardURL(value, allowLocal = false) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter the dashboard’s Render URL.'); }
  const local = allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!local && (url.protocol !== 'https:' || !/^[a-z0-9-]+\.onrender\.com$/i.test(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS onrender.com dashboard URL.');
  return url.origin;
}
export function createDashboardReader({ getURL, getKey, allowLocal = false, fetch: fetchImpl = globalThis.fetch }) {
  const cache = new Map(), pending = new Map();
  let generation = 0;
  function reset() { generation++; cache.clear(); pending.clear(); }
  async function read(date = '') {
    const configured = getURL();
    if (!configured) return { configured: false };
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T12:00:00Z')) || new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) !== date)) throw new Error('Choose a valid performance date.');
    const origin = dashboardURL(configured, allowLocal), key = getKey();
    const identity = [origin, key, date].join('\n'), previous = cache.get(identity);
    if (previous && Date.now() - previous.checkedAt < 300000) return previous.data;
    if (pending.has(identity)) return pending.get(identity);
    const readingGeneration = generation;
    const task = Promise.resolve().then(async () => {
      try {
        const historical = Boolean(date && date < londonToday());
        const request = (route, protectedRoute = true) => fetchImpl(origin + route, { headers: { Accept: 'application/json', ...(protectedRoute && key ? { 'X-Rota-Key': key } : {}) }, redirect: 'error', signal: AbortSignal.timeout(8000) });
        let response = await request('/api/rota-leaderboard' + (date ? '?date=' + encodeURIComponent(date) : ''));
        let legacy = false;
        if (response.status === 404) {
          response = await request(historical ? '/api/history?date=' + encodeURIComponent(date) + '&time=23:59' : '/api/dashboard', false);
          legacy = true;
        }
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Check the dashboard integration key in both apps.' : 'The dashboard could not be reached. Try again shortly.');
        const raw = await response.text();
        if (Buffer.byteLength(raw) > 2000000) throw new Error('The dashboard response is too large.');
        let data = JSON.parse(raw);
        if (legacy && historical) {
          if (data.selected && (data.selected.date || data.selected.localDate) && (data.selected.date || data.selected.localDate) !== date) throw new Error('The dashboard returned a different date. Update its employee history connection.');
          data = { date: data.date, historical: true, available: Boolean(data.selected), complete: false, limited: true, updatedAt: data.selected?.capturedAt || null, snapshotTime: data.selected?.capturedAt || null, picking: data.selected?.picking || [], packing: data.selected?.packing || [] };
        }
        if (date && data.date !== date) throw new Error('The dashboard returned a different date. Update its employee history connection.');
        if (!Array.isArray(data.picking) || !Array.isArray(data.packing)) throw new Error('The dashboard did not return employee performance.');
        const result = { configured: true, date: data.date || date || londonToday(), available: data.available !== false, historical, updatedAt: data.updatedAt, snapshotTime: data.snapshotTime, fetchedAt: new Date().toISOString(), mode: data.mode, limited: legacy || data.limited === true || data.complete === false, stale: false, ambiguousNames: data.ambiguousNames, picking: data.picking, packing: data.packing };
        if (readingGeneration === generation) {
          cache.set(identity, { data: result, checkedAt: Date.now() });
          while (cache.size > 40) cache.delete(cache.keys().next().value);
        }
        return result;
      } catch (error) {
        if (previous && readingGeneration === generation) {
          const result = { ...previous.data, stale: true, error: error.message };
          cache.set(identity, { data: result, checkedAt: Date.now() });
          return result;
        }
        throw error;
      } finally { if (readingGeneration === generation) pending.delete(identity); }
    });
    pending.set(identity, task);
    return task;
  }
  async function profile(person, date = '') {
    const data = await read(date);
    if (!data.configured) return data;
    const name = person.leaderboard_name || person.name;
    const result = { configured: true, matchedName: name, date: data.date, available: data.available, historical: data.historical, updatedAt: data.updatedAt, snapshotTime: data.snapshotTime, fetchedAt: data.fetchedAt, mode: data.mode, limited: data.limited, stale: data.stale, error: data.error };
    for (const kind of ['picking', 'packing']) {
      const matches = data[kind].map((row, index) => ({ row, rank: index + 1 })).filter(x => normalName(x.row.name) === normalName(name));
      const ambiguous = matches.length > 1 || data.ambiguousNames?.[kind]?.includes(normalName(name));
      result[kind] = matches.length === 1 && !ambiguous ? { name: matches[0].row.name, total: matches[0].row.total ?? null, avgPerHour: matches[0].row.avgPerHour ?? null, peakTotal: matches[0].row.peakTotal ?? null, peakHour: matches[0].row.peakHour || null, rank: data.limited ? null : matches[0].rank } : null;
      if (ambiguous) result.ambiguous = true;
    }
    return result;
  }
  return { profile, reset, validateURL: value => dashboardURL(value, allowLocal) };
}
