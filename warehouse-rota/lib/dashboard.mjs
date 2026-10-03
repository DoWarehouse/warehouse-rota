const normalName = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB');
export function dashboardURL(value, allowLocal = false) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter the dashboard’s Render URL.'); }
  const local = allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!local && (url.protocol !== 'https:' || !/^[a-z0-9-]+\.onrender\.com$/i.test(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS onrender.com dashboard URL.');
  return url.origin;
}
export function createDashboardReader({ getURL, getKey, allowLocal = false, fetch: fetchImpl = globalThis.fetch }) {
  let cache = null, cachedFor = '', checkedAt = 0, pending;
  function reset() { cache = null; cachedFor = ''; checkedAt = 0; }
  async function read() {
    const configured = getURL();
    if (!configured) return { configured: false };
    const origin = dashboardURL(configured, allowLocal), key = getKey();
    const identity = origin + '\n' + key;
    if (cache && cachedFor === identity && Date.now() - checkedAt < 300000) return cache;
    if (pending) return pending;
    pending = (async () => {
      try {
        let response = await fetchImpl(origin + '/api/rota-leaderboard', { headers: { Accept: 'application/json', ...(key ? { 'X-Rota-Key': key } : {}) }, redirect: 'error', signal: AbortSignal.timeout(8000) });
        let limited = false;
        if (response.status === 404) {
          response = await fetchImpl(origin + '/api/dashboard', { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
          limited = true;
        }
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Check the dashboard integration key in both apps.' : 'The dashboard could not be reached. Try again shortly.');
        const raw = await response.text();
        if (Buffer.byteLength(raw) > 2000000) throw new Error('The dashboard response is too large.');
        const data = JSON.parse(raw);
        if (!Array.isArray(data.picking) || !Array.isArray(data.packing)) throw new Error('The dashboard did not return its leaderboards.');
        cache = { configured: true, date: data.date, updatedAt: data.updatedAt, fetchedAt: new Date().toISOString(), mode: data.mode, limited, stale: false, picking: data.picking, packing: data.packing };
        checkedAt = Date.now(); cachedFor = identity;
        return cache;
      } catch (error) {
        if (cache && cachedFor === identity) { checkedAt = Date.now(); cache = { ...cache, stale: true, error: error.message }; return cache; }
        throw error;
      } finally { pending = null; }
    })();
    return pending;
  }
  async function profile(person) {
    const data = await read();
    if (!data.configured) return data;
    const name = person.leaderboard_name || person.name;
    const result = { configured: true, matchedName: name, date: data.date, updatedAt: data.updatedAt, fetchedAt: data.fetchedAt, mode: data.mode, limited: data.limited, stale: data.stale, error: data.error };
    for (const kind of ['picking', 'packing']) {
      const matches = data[kind].map((row, index) => ({ row, rank: index + 1 })).filter(x => normalName(x.row.name) === normalName(name));
      result[kind] = matches.length === 1 ? { name: matches[0].row.name, total: matches[0].row.total ?? null, avgPerHour: matches[0].row.avgPerHour ?? null, peakTotal: matches[0].row.peakTotal ?? null, peakHour: matches[0].row.peakHour || null, rank: matches[0].rank } : null;
      if (matches.length > 1) result.ambiguous = true;
    }
    return result;
  }
  return { profile, reset, validateURL: value => dashboardURL(value, allowLocal) };
}
