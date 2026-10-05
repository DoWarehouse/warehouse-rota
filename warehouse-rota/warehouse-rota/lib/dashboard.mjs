const normalName = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB');
const londonClock = date => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const value = type => parts.find(p => p.type === type).value;
  return { date: ['year', 'month', 'day'].map(value).join('-'), time: ['hour', 'minute'].map(value).join(':') };
};
const plusDays = (date, count) => { const day = new Date(date + 'T12:00:00Z'); day.setUTCDate(day.getUTCDate() + count); return day.toISOString().slice(0, 10); };
const metric = value => {
  if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const hasActiveHours = row => metric(row.activeHours) > 0 && metric(row.completedHourlyTotal) !== null;
function averageHourly(rows) {
  if (!rows.length) return { rate: null, method: 'daily-rates', hours: null };
  if (rows.every(hasActiveHours)) {
    const hours = rows.reduce((sum, row) => sum + metric(row.activeHours), 0);
    return { rate: rows.reduce((sum, row) => sum + metric(row.completedHourlyTotal), 0) / hours, method: 'active-hours', hours };
  }
  return { rate: average(rows.map(row => metric(row.avgPerHour))), method: 'daily-rates', hours: null };
}
function teamComparison(rows, matchedName, ambiguousNames = []) {
  const own = normalName(matchedName), counts = new Map();
  for (const row of rows) { const name = normalName(row.name); counts.set(name, (counts.get(name) || 0) + 1); }
  const rates = rows.filter(row => {
    const name = normalName(row.name);
    return name && name !== own && counts.get(name) === 1 && !ambiguousNames.includes(name) &&
      metric(row.avgPerHour) !== null && (metric(row.total) > 0 || metric(row.avgPerHour) > 0);
  }).map(row => metric(row.avgPerHour));
  const rate = average(rates);
  return rate > 0 ? { averagePerHour: rate, colleagues: rates.length } : null;
}
export function dashboardURL(value, allowLocal = false) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter the dashboard’s Render URL.'); }
  const local = allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!local && (url.protocol !== 'https:' || !/^[a-z0-9-]+\.onrender\.com$/i.test(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS onrender.com dashboard URL.');
  return url.origin;
}
export function createDashboardReader({ getURL, getKey, allowLocal = false, fetch: fetchImpl = globalThis.fetch, now = () => new Date() }) {
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
        const historical = Boolean(date && date < londonClock(now()).date);
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
        const result = { configured: true, date: data.date || date || londonClock(now()).date, available: data.available !== false, historical, updatedAt: data.updatedAt, snapshotTime: data.snapshotTime, fetchedAt: now().toISOString(), mode: data.mode, limited: legacy || data.limited === true || data.complete === false, stale: false, ambiguousNames: data.ambiguousNames, picking: data.picking, packing: data.packing };
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
      result[kind] = matches.length === 1 && !ambiguous ? { name: matches[0].row.name, total: matches[0].row.total ?? null, avgPerHour: matches[0].row.avgPerHour ?? null, activeHours: metric(matches[0].row.activeHours), completedHourlyTotal: metric(matches[0].row.completedHourlyTotal), peakTotal: matches[0].row.peakTotal ?? null, peakHour: matches[0].row.peakHour || null, rank: data.limited ? null : matches[0].rank,
        comparison: !data.limited && data.available && !data.stale && metric(matches[0].row.avgPerHour) !== null ? teamComparison(data[kind], name, data.ambiguousNames?.[kind]) : null } : null;
      if (ambiguous) result.ambiguous = true;
    }
    return result;
  }
  async function weeklyProfile(person, shifts, week) {
    const weekEnd = plusDays(week, 6), clock = londonClock(now()), at = clock.date + 'T' + clock.time;
    const groups = new Map();
    for (const shift of shifts) {
      if (shift.person_id !== person.id || !['work', 'training'].includes(shift.kind) || shift.date < week || shift.date > weekEnd) continue;
      if (!groups.has(shift.date)) groups.set(shift.date, []);
      groups.get(shift.date).push(shift);
    }
    const days = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([date, shifts]) => {
      const started = shifts.some(shift => date + 'T' + shift.start_time <= at);
      const finished = shifts.every(shift => (shift.end_time < shift.start_time ? plusDays(date, 1) : date) + 'T' + shift.end_time <= at);
      return { date, shiftCount: shifts.length, status: started ? 'pending' : 'upcoming', inProgress: started && !finished };
    });
    const result = { configured: Boolean(getURL()), week, weekEnd, matchedName: person.leaderboard_name || person.name, days, summary: {}, scheduledDays: days.length };
    if (!result.configured) return result;
    const eligible = days.filter(day => day.status === 'pending');
    // At most two history reads at a time. Shared date caches are reused by every profile.
    for (let offset = 0; offset < eligible.length; offset += 2) {
      const batch = eligible.slice(offset, offset + 2);
      const records = await Promise.allSettled(batch.map(day => profile(person, day.date)));
      records.forEach((record, index) => {
        const day = batch[index];
        if (record.status === 'rejected') { day.status = 'error'; day.error = record.reason.message; return; }
        day.performance = record.value;
        day.status = record.value.available !== false && ['picking', 'packing'].some(kind => record.value[kind] && (metric(record.value[kind].total) !== null || metric(record.value[kind].avgPerHour) !== null)) ? 'recorded' : 'missing';
      });
    }
    for (const kind of ['picking', 'packing']) {
      const rows = days.filter(day => day.status === 'recorded').map(day => day.performance[kind]).filter(Boolean);
      const totals = rows.map(row => metric(row.total)).filter(value => value !== null);
      const rateRows = rows.filter(row => metric(row.avgPerHour) !== null), hourly = averageHourly(rateRows);
      const compared = rateRows.filter(row => row.comparison), comparedHourly = averageHourly(compared);
      const teamRate = comparedHourly.method === 'active-hours' ? compared.reduce((sum, row) => sum + row.comparison.averagePerHour * metric(row.activeHours), 0) / comparedHourly.hours : average(compared.map(row => row.comparison.averagePerHour));
      result.summary[kind] = {
        total: totals.length ? totals.reduce((sum, value) => sum + value, 0) : null,
        averagePerDay: average(totals), averagePerHour: hourly.rate, averageMethod: hourly.method, activeHours: hourly.hours, recordedDays: totals.length, hourlyDays: rateRows.length,
        comparison: compared.length ? { days: compared.length, colleagueAveragePerHour: comparedHourly.rate, teamAveragePerHour: teamRate, averageMethod: comparedHourly.method, percentDifference: (comparedHourly.rate / teamRate - 1) * 100, minColleagues: Math.min(...compared.map(row => row.comparison.colleagues)), maxColleagues: Math.max(...compared.map(row => row.comparison.colleagues)) } : null
      };
    }
    result.recordedDays = days.filter(day => day.status === 'recorded').length;
    result.elapsedDays = eligible.length;
    result.upcomingDays = days.length - eligible.length;
    result.inProgress = days.some(day => day.inProgress || (day.status === 'recorded' && day.date === clock.date));
    result.limited = days.some(day => day.performance?.limited);
    result.stale = days.some(day => day.performance?.stale);
    result.ambiguous = days.some(day => day.performance?.ambiguous);
    return result;
  }
  return { profile, weeklyProfile, reset, validateURL: value => dashboardURL(value, allowLocal) };
}
