import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const TARGETS_FILE = path.join(DATA_DIR, 'targets.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const CYCLE_DIR = path.join(DATA_DIR, 'cycle-times');
const CYCLE_FILE = path.join(CYCLE_DIR, 'orders.json');
const CYCLE_STATE_FILE = path.join(CYCLE_DIR, 'refresh-state.json');
const PORT = Number(process.env.PORT || 8787);
const HUTCH_API_BASE = process.env.HUTCH_API_BASE || 'https://api.tryhutch.co.uk';
let hutchAccessToken = process.env.HUTCH_BEARER_TOKEN || '';
const HUTCH_REFRESH_TOKEN = process.env.HUTCH_REFRESH_TOKEN || '';
const DEFAULT_TARGET = Number(process.env.DEFAULT_TARGET || 2000);
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Europe/London';
const SNAPSHOT_INTERVAL_MS = Math.max(60000, Number(process.env.SNAPSHOT_INTERVAL_MS || 300000));
const CURRENT_WAIT_REFRESH_MS = Math.max(60000, Number(process.env.CURRENT_WAIT_REFRESH_MS || 300000));
const CYCLE_REFRESH_INTERVAL_MS = Math.max(3600000, Number(process.env.CYCLE_REFRESH_INTERVAL_MS || 10800000));
const CYCLE_MAX_PAGES = Math.max(1, Math.min(100, Number(process.env.CYCLE_MAX_PAGES || 40)));
const CYCLE_MAX_NEW_TIMELINES = Math.max(10, Math.min(500, Number(process.env.CYCLE_MAX_NEW_TIMELINES || 150)));
const CYCLE_TIMELINE_DELAY_MS = Math.max(1000, Math.min(30000, Number(process.env.CYCLE_TIMELINE_DELAY_MS || 5000)));
const CYCLE_BACKFILL_MAX_PAGES = Math.max(1, Math.min(100, Number(process.env.CYCLE_BACKFILL_MAX_PAGES || 50)));
const CYCLE_BACKFILL_MAX_NEW_TIMELINES = Math.max(100, Math.min(5000, Number(process.env.CYCLE_BACKFILL_MAX_NEW_TIMELINES || 2500)));
// One-time v6 reconciliation: scan deeper than the normal 40-page refresh so
// older-created orders that shipped recently can be discovered and cached.
const CYCLE_RECONCILE_MAX_PAGES = Math.max(40, Math.min(120, Number(process.env.CYCLE_RECONCILE_MAX_PAGES || 100)));
const CYCLE_RECONCILE_MAX_NEW_TIMELINES = Math.max(100, Math.min(5000, Number(process.env.CYCLE_RECONCILE_MAX_NEW_TIMELINES || 5000)));
const CYCLE_RECONCILE_RETRY_MS = Math.max(300000, Number(process.env.CYCLE_RECONCILE_RETRY_MS || 1800000));
const CYCLE_BACKOFF_MS = [60000, 120000, 300000];

function parseScopes(value) {
  if (!value) return {};
  try { return JSON.parse(value); }
  catch { return {}; }
}
let hutchScopes = parseScopes(process.env.HUTCH_SCOPES || '{}');
let refreshPromise = null;
let lastRefreshAt = null;
const DEMO_MODE = process.env.DEMO_MODE === '1' || (!hutchAccessToken && !HUTCH_REFRESH_TOKEN);

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(HISTORY_DIR, { recursive: true });
await fs.mkdir(CYCLE_DIR, { recursive: true });
try { await fs.access(TARGETS_FILE); } catch { await fs.writeFile(TARGETS_FILE, '{}\n'); }

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function londonDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return { year: parts.year, month: parts.month, day: parts.day, iso: `${parts.year}-${parts.month}-${parts.day}` };
}

function londonOffset(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const mins = Math.round((asUTC - date.getTime()) / 60000);
  const sign = mins >= 0 ? '+' : '-';
  const abs = Math.abs(mins);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function hutchDatePayload() {
  const d = londonDateParts();
  return `${d.iso}T00:00:00${londonOffset()}`;
}

async function getTargets() {
  try { return JSON.parse(await fs.readFile(TARGETS_FILE, 'utf8')); }
  catch { return {}; }
}

async function saveTarget(date, target) {
  const targets = await getTargets();
  targets[date] = target;
  await fs.writeFile(TARGETS_FILE, JSON.stringify(targets, null, 2) + '\n');
}

async function hutchFetch(endpoint, payload, token = '') {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${HUTCH_API_BASE}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000)
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { response, data };
}

async function refreshHutchAccessToken() {
  if (!HUTCH_REFRESH_TOKEN) {
    const error = new Error('Hutch login required');
    error.status = 401;
    error.code = 'AUTH_REQUIRED';
    throw error;
  }
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const { response, data } = await hutchFetch('/auth/Refresh', {
      refresh_token: HUTCH_REFRESH_TOKEN,
      scopes: hutchScopes
    });

    if (!response.ok || !data?.access_token) {
      const error = new Error(`Unable to refresh Hutch login (${response.status})`);
      error.status = response.status || 401;
      error.code = 'AUTH_REQUIRED';
      error.details = data;
      throw error;
    }

    hutchAccessToken = data.access_token;
    if (data.scopes !== undefined && data.scopes !== null) hutchScopes = data.scopes;
    lastRefreshAt = new Date().toISOString();
    return hutchAccessToken;
  })();

  try { return await refreshPromise; }
  finally { refreshPromise = null; }
}

async function hutchPost(endpoint, payload, allowRetry = true) {
  if (!hutchAccessToken) await refreshHutchAccessToken();

  let { response, data } = await hutchFetch(endpoint, payload, hutchAccessToken);

  if (response.status === 401 && allowRetry && HUTCH_REFRESH_TOKEN) {
    await refreshHutchAccessToken();
    ({ response, data } = await hutchFetch(endpoint, payload, hutchAccessToken));
  }

  if (!response.ok) {
    const error = new Error(`Hutch API returned ${response.status}`);
    error.status = response.status;
    error.code = response.status === 401 ? 'AUTH_REQUIRED' : 'HUTCH_ERROR';
    error.details = data;
    throw error;
  }
  return data;
}

const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function userRole(user) {
  const role = String(user.role ?? user.task_role ?? user.type ?? user.activity ?? '').toLowerCase();
  if (role.includes('pack')) return 'Packing';
  if (role.includes('pick')) return 'Picking';
  const packs = num(user.packs_completed ?? user.packsCompleted);
  const picks = num(user.picks_completed ?? user.picksCompleted);
  const tasks = num(user.tasks_completed ?? user.tasksCompleted);
  if (picks > 0) return 'Picking';
  if (packs > 0 && (tasks === 0 || packs === tasks)) return 'Packing';
  if (tasks > 0 && packs === 0) return 'Picking';
  return 'Other';
}

function userName(user) {
  return [user.first_name ?? user.firstName, user.last_name ?? user.lastName].filter(Boolean).join(' ').trim()
    || user.name || user.display_name || 'Unknown';
}

function packCount(user) {
  return num(user.packs_completed ?? user.packsCompleted ?? (userRole(user) === 'Packing' ? user.tasks_completed : 0));
}

function pickCount(user) {
  return num(user.picks_completed ?? user.picksCompleted ?? (userRole(user) === 'Picking' ? user.tasks_completed : 0));
}

function hourLabel(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return String(timestamp || '');
  return new Intl.DateTimeFormat('en-GB', { timeZone: APP_TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

function londonHourKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, hourCycle: 'h23'
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
}

function hourlyCountForRole(hour, role) {
  if (role === 'Packing') return num(hour.packs ?? hour.pack ?? hour.tasks);
  if (role === 'Picking') return num(hour.picks ?? hour.pick ?? hour.tasks);
  return 0;
}

function userHourlyStats(user, role) {
  const hours = Array.isArray(user.hours) ? user.hours : [];
  const currentHour = londonHourKey();
  let completedTotal = 0;
  let completedHours = 0;
  let peakTotal = 0;
  let peakHour = null;

  for (const hour of hours) {
    const value = hourlyCountForRole(hour, role);
    if (value <= 0) continue;

    if (value > peakTotal) {
      peakTotal = value;
      peakHour = hourLabel(hour.timestamp);
    }

    const d = new Date(hour.timestamp);
    const isCurrentHour = !Number.isNaN(d.getTime()) && londonHourKey(d) === currentHour;
    if (!isCurrentHour) {
      completedTotal += value;
      completedHours += 1;
    }
  }

  return {
    avgPerHour: completedHours ? completedTotal / completedHours : null,
    activeHours: completedHours,
    completedHourlyTotal: completedTotal,
    peakTotal: peakTotal || null,
    peakHour
  };
}

function parseLeaderboard(raw) {
  const users = Array.isArray(raw?.users) ? raw.users : Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
  const picking = [];
  const packing = [];
  const hourlyMap = new Map();
  let packedToday = 0;

  for (const user of users) {
    const role = userRole(user);
    const name = userName(user);
    const picks = pickCount(user);
    const packs = packCount(user);
    packedToday += packs;
    if (role === 'Picking' || picks > 0) picking.push({ name, total: picks, ...userHourlyStats(user, 'Picking') });
    if (role === 'Packing' || packs > 0) packing.push({ name, total: packs, ...userHourlyStats(user, 'Packing') });

    for (const h of Array.isArray(user.hours) ? user.hours : []) {
      const label = hourLabel(h.timestamp);
      if (!label) continue;
      const current = hourlyMap.get(label) || { hour: label, picking: 0, packing: 0 };
      current.packing += num(h.packs ?? h.pack ?? (role === 'Packing' ? h.tasks : 0));
      current.picking += num(h.picks ?? h.pick ?? (role === 'Picking' ? h.tasks : 0));
      hourlyMap.set(label, current);
    }
  }

  const sortDesc = (a, b) => b.total - a.total;
  const hourly = [...hourlyMap.values()].sort((a, b) => a.hour.localeCompare(b.hour));
  return {
    packedToday,
    picking: picking.filter(x => x.total > 0).sort(sortDesc).slice(0, 8),
    packing: packing.filter(x => x.total > 0).sort(sortDesc).slice(0, 8),
    hourly,
    rawUserCount: users.length
  };
}

function parseOrderCreatedAt(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function oldestOrderInfo(raw) {
  const orders = Array.isArray(raw?.orders) ? raw.orders : Array.isArray(raw?.data?.orders) ? raw.data.orders : [];
  const first = orders[0];
  if (!first) return { oldestOutstandingAt: null, oldestOutstandingReference: null };
  return {
    oldestOutstandingAt: parseOrderCreatedAt(first.created_at ?? first.createdAt),
    oldestOutstandingReference: first.reference ?? first.id ?? null
  };
}


function localDateForInstant(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

function parseEventTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function extractOrders(raw) {
  if (Array.isArray(raw?.orders)) return raw.orders;
  if (Array.isArray(raw?.data?.orders)) return raw.data.orders;
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw)) return raw;
  return [];
}

function extractNextCursor(raw) {
  return raw?.pagination?.next_cursor
    ?? raw?.pagination?.cursor
    ?? raw?.next_cursor
    ?? raw?.next?.cursor
    ?? raw?.page?.next_cursor
    ?? null;
}

function hasNextPage(raw) {
  return raw?.next_page === true
    || raw?.pagination?.next_page === true
    || raw?.pagination?.has_next === true
    || Boolean(extractNextCursor(raw));
}

let currentWaitCache = { loadedAt: 0, createdAts: [], pages: 0, error: null };
let currentWaitRefreshPromise = null;

async function refreshCurrentOutstandingOrders({ force = false } = {}) {
  const fresh = currentWaitCache.loadedAt && (Date.now() - currentWaitCache.loadedAt < CURRENT_WAIT_REFRESH_MS);
  if (!force && fresh) return currentWaitCache;
  if (currentWaitRefreshPromise) return currentWaitRefreshPromise;

  currentWaitRefreshPromise = (async () => {
    const createdAts = [];
    let cursor = '';
    let pages = 0;
    try {
      for (let page = 0; page < 100; page++) {
        const raw = await hutchPost('/orders/List', {
          is_search: false,
          filters: [{ field: 'status', op: 7, values: ['Pending', 'Picked', 'Blocked'] }],
          pagination: { order_by: 'created_at', direction: 1, limit: 50, cursor }
        });
        pages += 1;
        const orders = extractOrders(raw);
        for (const order of orders) {
          const createdAt = parseOrderCreatedAt(order?.created_at ?? order?.createdAt);
          if (createdAt) createdAts.push(createdAt);
        }
        if (!orders.length) break;
        const nextCursor = extractNextCursor(raw);
        if (!hasNextPage(raw) || !nextCursor || String(nextCursor) === String(cursor)) break;
        cursor = String(nextCursor);
      }
      currentWaitCache = { loadedAt: Date.now(), createdAts, pages, error: null };
    } catch (error) {
      currentWaitCache = { ...currentWaitCache, pages, error: error.message };
      if (!currentWaitCache.createdAts.length) throw error;
    }
    return currentWaitCache;
  })();
  try { return await currentWaitRefreshPromise; }
  finally { currentWaitRefreshPromise = null; }
}

async function currentOutstandingWaitSummary() {
  if (DEMO_MODE) return {
    averageSeconds: 4 * 3600 + 12 * 60,
    orders: 176,
    refreshedAt: new Date().toISOString(),
    refreshMinutes: 5,
    statuses: ['Pending', 'Picked', 'Blocked']
  };
  const cache = await refreshCurrentOutstandingOrders();
  const now = Date.now();
  const waits = cache.createdAts
    .map(value => Math.max(0, Math.round((now - Date.parse(value)) / 1000)))
    .filter(Number.isFinite);
  return {
    averageSeconds: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null,
    orders: waits.length,
    waits,
    refreshedAt: cache.loadedAt ? new Date(cache.loadedAt).toISOString() : null,
    refreshMinutes: Math.round(CURRENT_WAIT_REFRESH_MS / 60000),
    statuses: ['Pending', 'Picked', 'Blocked'],
    pages: cache.pages,
    error: cache.error
  };
}

function restrictedMeanTimeToDispatch(completedSeconds, openSeconds) {
  const observations = [
    ...completedSeconds.map(time => ({ time: Number(time), event: 1 })),
    ...openSeconds.map(time => ({ time: Number(time), event: 0 }))
  ].filter(row => Number.isFinite(row.time) && row.time >= 0)
    .sort((a, b) => a.time - b.time || b.event - a.event);

  if (!observations.length) return { estimatedSeconds: null, horizonSeconds: null, survivalAtHorizon: null };

  let atRisk = observations.length;
  let survival = 1;
  let area = 0;
  let previousTime = 0;
  let index = 0;

  while (index < observations.length && atRisk > 0) {
    const time = observations[index].time;
    area += survival * Math.max(0, time - previousTime);

    let events = 0;
    let censored = 0;
    while (index < observations.length && observations[index].time === time) {
      if (observations[index].event) events += 1;
      else censored += 1;
      index += 1;
    }

    if (events > 0 && atRisk > 0) survival *= Math.max(0, 1 - events / atRisk);
    atRisk -= events + censored;
    previousTime = time;
  }

  return {
    estimatedSeconds: area,
    horizonSeconds: previousTime,
    survivalAtHorizon: survival
  };
}

async function currentEstimatedDispatchSummary() {
  if (DEMO_MODE) return {
    estimatedSeconds: 8 * 3600 + 18 * 60,
    shippedOrders: 684,
    openOrders: 257,
    totalOrders: 941,
    ordersBeyondEstimate: 23,
    windowHours: 72,
    method: 'censored-rmst',
    refreshedAt: new Date().toISOString(),
    openRefreshMinutes: 5,
    shippedRefreshMinutes: Math.round(CYCLE_REFRESH_INTERVAL_MS / 60000)
  };

  const [records, outstanding] = await Promise.all([
    readCycleRecords(),
    currentOutstandingWaitSummary()
  ]);

  const now = Date.now();
  const cutoff = now - 72 * 3600 * 1000;
  const recentShipped = records.filter(record => {
    const shippedMs = Date.parse(record.shippedAt || '');
    return Number.isFinite(shippedMs) && shippedMs >= cutoff && shippedMs <= now;
  });
  const completedSeconds = recentShipped
    .map(record => Number(record.cycleSeconds))
    .filter(value => Number.isFinite(value) && value >= 0);
  const openSeconds = Array.isArray(outstanding.waits) ? outstanding.waits : [];
  const estimate = restrictedMeanTimeToDispatch(completedSeconds, openSeconds);
  const estimatedSeconds = estimate.estimatedSeconds;
  const ordersBeyondEstimate = Number.isFinite(estimatedSeconds)
    ? openSeconds.filter(wait => wait > estimatedSeconds).length
    : 0;

  return {
    estimatedSeconds,
    shippedOrders: completedSeconds.length,
    openOrders: openSeconds.length,
    totalOrders: completedSeconds.length + openSeconds.length,
    ordersBeyondEstimate,
    windowHours: 72,
    method: 'censored-rmst',
    horizonSeconds: estimate.horizonSeconds,
    survivalAtHorizon: estimate.survivalAtHorizon,
    refreshedAt: outstanding.refreshedAt,
    openRefreshMinutes: outstanding.refreshMinutes,
    shippedRefreshMinutes: Math.round(CYCLE_REFRESH_INTERVAL_MS / 60000),
    openError: outstanding.error || null
  };
}

async function readCycleRecords() {
  try {
    const parsed = JSON.parse(await fs.readFile(CYCLE_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function saveCycleRecords(records) {
  const tmp = `${CYCLE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(records, null, 2) + '\n');
  await fs.rename(tmp, CYCLE_FILE);
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function cycleMetrics(records) {
  const values = records.map(r => num(r.cycleSeconds)).filter(v => v >= 0 && Number.isFinite(v)).sort((a, b) => a - b);
  if (!values.length) return { averageSeconds: null, medianSeconds: null, p90Seconds: null, orders: 0 };
  const total = values.reduce((a, b) => a + b, 0);
  return {
    averageSeconds: total / values.length,
    medianSeconds: percentile(values, 0.5),
    p90Seconds: percentile(values, 0.9),
    orders: values.length
  };
}

async function cycleSummaryForDate(date) {
  const records = await readCycleRecords();
  return cycleMetrics(records.filter(r => r.shippedDate === date));
}

async function cycleSummaryForRollingDays(endDate, days = 7) {
  const safeDays = Math.max(1, Math.floor(Number(days) || 7));
  const startDate = dateOnlyAdd(endDate, -(safeDays - 1));
  const records = await cycleRecordsForRange(startDate, endDate);
  return { ...cycleMetrics(records), startDate, endDate, windowDays: safeDays };
}

async function cycleRecordsForRange(start, end) {
  const records = await readCycleRecords();
  return records.filter(r => r.shippedDate && r.shippedDate >= start && r.shippedDate <= end);
}

function shippedEventFromTimeline(raw) {
  const events = Array.isArray(raw?.events) ? raw.events : Array.isArray(raw?.data?.events) ? raw.data.events : [];
  const matches = events.filter(event => String(event?.title || '').toLowerCase().includes('status updated to shipped'));
  if (!matches.length) return null;
  return matches.reduce((latest, event) => {
    const iso = parseEventTimestamp(event.timestamp);
    if (!iso) return latest;
    if (!latest || Date.parse(iso) > Date.parse(latest.shippedAt)) return { shippedAt: iso, title: event.title || '' };
    return latest;
  }, null);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function hutchPostWithBackoff(endpoint, payload) {
  let lastError;
  for (let attempt = 0; attempt <= CYCLE_BACKOFF_MS.length; attempt++) {
    try { return await hutchPost(endpoint, payload); }
    catch (error) {
      lastError = error;
      const retryable = error?.status === 429 || Number(error?.status) >= 500;
      if (!retryable || attempt >= CYCLE_BACKOFF_MS.length) throw error;
      const waitMs = CYCLE_BACKOFF_MS[attempt];
      console.warn(`Hutch ${error.status} on ${endpoint}; backing off for ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

let cycleRefreshPromise = null;
let cycleLastAttemptAt = null;
let cycleLastSuccessAt = null;
let cycleLastError = null;
let cycleLastNewRecords = 0;
let cycleLastScannedOrders = 0;
let cycleLastPages = 0;
let cycleBackfillCompleted = false;
let cycleBackfillStartedAt = null;
let cycleBackfillCompletedAt = null;
let cycleBackfillProcessed = 0;
let cycleBackfillFailed = 0;
let cycleBackfillTarget = 0;
let cycleReconcileCompleted = false;
let cycleReconcileStartedAt = null;
let cycleReconcileCompletedAt = null;
let cycleReconcileProcessed = 0;
let cycleReconcileFailed = 0;
let cycleReconcileTarget = 0;
let cycleReconcileScannedOrders = 0;
let cycleReconcilePages = 0;

async function loadCycleRefreshState() {
  try {
    const state = JSON.parse(await fs.readFile(CYCLE_STATE_FILE, 'utf8'));
    cycleLastAttemptAt = state.lastAttemptAt || null;
    cycleLastSuccessAt = state.lastSuccessAt || null;
    cycleLastError = state.lastError || null;
    cycleLastNewRecords = num(state.newRecords);
    cycleLastScannedOrders = num(state.scannedOrders);
    cycleLastPages = num(state.pages);
    cycleBackfillCompleted = state.backfillCompleted === true;
    cycleBackfillStartedAt = state.backfillStartedAt || null;
    cycleBackfillCompletedAt = state.backfillCompletedAt || null;
    cycleBackfillProcessed = num(state.backfillProcessed);
    cycleBackfillFailed = num(state.backfillFailed);
    cycleBackfillTarget = num(state.backfillTarget);
    cycleReconcileCompleted = state.reconcileCompleted === true;
    cycleReconcileStartedAt = state.reconcileStartedAt || null;
    cycleReconcileCompletedAt = state.reconcileCompletedAt || null;
    cycleReconcileProcessed = num(state.reconcileProcessed);
    cycleReconcileFailed = num(state.reconcileFailed);
    cycleReconcileTarget = num(state.reconcileTarget);
    cycleReconcileScannedOrders = num(state.reconcileScannedOrders);
    cycleReconcilePages = num(state.reconcilePages);
  } catch {}
}

async function saveCycleRefreshState() {
  const state = {
    lastAttemptAt: cycleLastAttemptAt,
    lastSuccessAt: cycleLastSuccessAt,
    lastError: cycleLastError,
    newRecords: cycleLastNewRecords,
    scannedOrders: cycleLastScannedOrders,
    pages: cycleLastPages,
    backfillCompleted: cycleBackfillCompleted,
    backfillStartedAt: cycleBackfillStartedAt,
    backfillCompletedAt: cycleBackfillCompletedAt,
    backfillProcessed: cycleBackfillProcessed,
    backfillFailed: cycleBackfillFailed,
    backfillTarget: cycleBackfillTarget,
    reconcileCompleted: cycleReconcileCompleted,
    reconcileStartedAt: cycleReconcileStartedAt,
    reconcileCompletedAt: cycleReconcileCompletedAt,
    reconcileProcessed: cycleReconcileProcessed,
    reconcileFailed: cycleReconcileFailed,
    reconcileTarget: cycleReconcileTarget,
    reconcileScannedOrders: cycleReconcileScannedOrders,
    reconcilePages: cycleReconcilePages
  };
  const tmp = `${CYCLE_STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
  await fs.rename(tmp, CYCLE_STATE_FILE);
}

function cycleRefreshDue() {
  const last = Date.parse(cycleLastSuccessAt || cycleLastAttemptAt || '');
  return !Number.isFinite(last) || (Date.now() - last >= CYCLE_REFRESH_INTERVAL_MS);
}

async function refreshCycleTimes({ force = false, backfill = false, reconcile = false } = {}) {
  if (DEMO_MODE) return false;
  if (!backfill && !reconcile && !force && !cycleRefreshDue()) return false;
  if (cycleRefreshPromise) return cycleRefreshPromise;

  cycleRefreshPromise = (async () => {
    cycleLastAttemptAt = new Date().toISOString();
    cycleLastError = null;
    if (backfill && !cycleBackfillStartedAt) cycleBackfillStartedAt = cycleLastAttemptAt;
    if (reconcile && !cycleReconcileStartedAt) cycleReconcileStartedAt = cycleLastAttemptAt;
    await saveCycleRefreshState();

    const existing = await readCycleRecords();
    const byId = new Map(existing.map(r => [String(r.orderId), r]));
    const candidates = [];
    let cursor = '';
    let pages = 0;
    let scanned = 0;
    const maxPages = reconcile ? CYCLE_RECONCILE_MAX_PAGES : backfill ? CYCLE_BACKFILL_MAX_PAGES : CYCLE_MAX_PAGES;
    const maxNew = reconcile ? CYCLE_RECONCILE_MAX_NEW_TIMELINES : backfill ? CYCLE_BACKFILL_MAX_NEW_TIMELINES : CYCLE_MAX_NEW_TIMELINES;

    try {
      for (let page = 0; page < maxPages; page++) {
        const raw = await hutchPostWithBackoff('/orders/List', {
          is_search: false,
          filters: [{ field: 'status', op: 7, values: ['Shipped'] }],
          pagination: { order_by: 'created_at', direction: 0, limit: 50, cursor }
        });
        pages += 1;
        const orders = extractOrders(raw);
        if (!orders.length) break;
        scanned += orders.length;
        for (const order of orders) {
          const orderId = String(order?.id ?? order?.order_id ?? '');
          if (!orderId || byId.has(orderId)) continue;
          const createdAt = parseOrderCreatedAt(order?.created_at ?? order?.createdAt);
          if (!createdAt) continue;
          candidates.push({ orderId, reference: order?.reference ?? null, createdAt });
          if (candidates.length >= maxNew) break;
        }
        if (candidates.length >= maxNew) break;
        const nextCursor = extractNextCursor(raw);
        if (!hasNextPage(raw) || !nextCursor || String(nextCursor) === String(cursor)) break;
        cursor = String(nextCursor);
      }

      if (backfill) {
        cycleBackfillTarget = candidates.length;
        cycleBackfillProcessed = 0;
        cycleBackfillFailed = 0;
        await saveCycleRefreshState();
      } else if (reconcile) {
        cycleReconcileTarget = candidates.length;
        cycleReconcileProcessed = 0;
        cycleReconcileFailed = 0;
        cycleReconcileScannedOrders = scanned;
        cycleReconcilePages = pages;
        await saveCycleRefreshState();
      }

      let added = 0;
      let processedThisRun = 0;
      let failedThisRun = 0;

      for (let index = 0; index < candidates.length; index++) {
        const order = candidates[index];
        try {
          const timeline = await hutchPostWithBackoff('/orders/Timeline', { id: order.orderId });
          const shipped = shippedEventFromTimeline(timeline);
          if (shipped) {
            const createdMs = Date.parse(order.createdAt);
            const shippedMs = Date.parse(shipped.shippedAt);
            if (Number.isFinite(createdMs) && Number.isFinite(shippedMs) && shippedMs >= createdMs) {
              byId.set(String(order.orderId), {
                orderId: order.orderId,
                reference: order.reference,
                createdAt: order.createdAt,
                shippedAt: shipped.shippedAt,
                shippedDate: localDateForInstant(shipped.shippedAt),
                cycleSeconds: Math.round((shippedMs - createdMs) / 1000),
                eventTitle: shipped.title,
                recordedAt: new Date().toISOString()
              });
              added += 1;
            }
          }
        } catch (error) {
          failedThisRun += 1;
          console.warn(`Cycle timeline skipped for ${order.orderId}: ${error.message}`);
        }

        processedThisRun += 1;
        if (backfill) {
          cycleBackfillProcessed = processedThisRun;
          cycleBackfillFailed = failedThisRun;
        } else if (reconcile) {
          cycleReconcileProcessed = processedThisRun;
          cycleReconcileFailed = failedThisRun;
        }

        if (processedThisRun % 10 === 0 || index === candidates.length - 1) {
          await saveCycleRecords([...byId.values()].sort((a, b) => String(a.shippedAt).localeCompare(String(b.shippedAt))));
          await saveCycleRefreshState();
        }

        if (index < candidates.length - 1) await sleep(CYCLE_TIMELINE_DELAY_MS);
      }

      cycleLastNewRecords = added;
      cycleLastScannedOrders = scanned;
      cycleLastPages = pages;
      cycleLastSuccessAt = new Date().toISOString();
      if (backfill) {
        cycleBackfillCompleted = true;
        cycleBackfillCompletedAt = cycleLastSuccessAt;
      } else if (reconcile) {
        cycleReconcileScannedOrders = scanned;
        cycleReconcilePages = pages;
        // A failed Timeline request is retried by a later reconciliation pass;
        // successful orders are already cached and will not be requested again.
        cycleReconcileCompleted = failedThisRun === 0;
        cycleReconcileCompletedAt = cycleReconcileCompleted ? cycleLastSuccessAt : null;
      }
      await saveCycleRefreshState();
      return true;
    } catch (error) {
      cycleLastError = error.message;
      await saveCycleRefreshState().catch(() => {});
      const mode = reconcile ? 'reconciliation' : backfill ? 'backfill' : 'refresh';
      console.error(`Cycle-time ${mode} failed:`, error.message);
      return false;
    }
  })();

  try { return await cycleRefreshPromise; }
  finally { cycleRefreshPromise = null; }
}

function cycleRefreshStatus() {
  return {
    lastAttemptAt: cycleLastAttemptAt,
    lastSuccessAt: cycleLastSuccessAt,
    lastError: cycleLastError,
    newRecords: cycleLastNewRecords,
    scannedOrders: cycleLastScannedOrders,
    pages: cycleLastPages,
    refreshMinutes: Math.round(CYCLE_REFRESH_INTERVAL_MS / 60000),
    timelineDelaySeconds: Math.round(CYCLE_TIMELINE_DELAY_MS / 1000),
    backfill: {
      completed: cycleBackfillCompleted,
      startedAt: cycleBackfillStartedAt,
      completedAt: cycleBackfillCompletedAt,
      processed: cycleBackfillProcessed,
      failed: cycleBackfillFailed,
      target: cycleBackfillTarget,
      maxOrders: CYCLE_BACKFILL_MAX_NEW_TIMELINES
    },
    reconciliation: {
      completed: cycleReconcileCompleted,
      startedAt: cycleReconcileStartedAt,
      completedAt: cycleReconcileCompletedAt,
      processed: cycleReconcileProcessed,
      failed: cycleReconcileFailed,
      target: cycleReconcileTarget,
      scannedOrders: cycleReconcileScannedOrders,
      pages: cycleReconcilePages,
      maxPages: CYCLE_RECONCILE_MAX_PAGES,
      maxOrders: CYCLE_RECONCILE_MAX_NEW_TIMELINES,
      retryMinutes: Math.round(CYCLE_RECONCILE_RETRY_MS / 60000)
    }
  };
}

function demoData(target) {
  const packedToday = 1318;
  return {
    date: londonDateParts().iso,
    target,
    packedToday,
    remainingToTarget: Math.max(target - packedToday, 0),
    progressPct: target > 0 ? Math.min((packedToday / target) * 100, 100) : 0,
    remainingToPick: 102,
    remainingToPack: 72,
    onHold: 10,
    priorityOrders: 7,
    dpdToPick: 48,
    dpdToPack: 31,
    royalMailToPick: 54,
    royalMailToPack: 41,
    oldestOutstandingAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    cycleTime: { averageSeconds: 4680, medianSeconds: 3300, p90Seconds: 9900, orders: 184, windowDays: 7, startDate: dateOnlyAdd(londonDateParts().iso, -6), endDate: londonDateParts().iso },
    currentWait: { averageSeconds: 15120, orders: 176, waits: [9000, 12000, 18000], refreshedAt: new Date().toISOString(), refreshMinutes: 5, statuses: ['Pending', 'Picked', 'Blocked'] },
    dispatchEstimate: { estimatedSeconds: 29880, shippedOrders: 684, openOrders: 257, totalOrders: 941, ordersBeyondEstimate: 23, windowHours: 72, method: 'censored-rmst', refreshedAt: new Date().toISOString(), openRefreshMinutes: 5, shippedRefreshMinutes: 180 },
    picking: [
      { name: 'Finn Buckley', total: 127, avgPerHour: 31.8, peakTotal: 52, peakHour: '08:00' },
      { name: 'Zack Manea', total: 79, avgPerHour: 26.3, peakTotal: 48, peakHour: '08:00' },
      { name: 'Callum Robson', total: 64, avgPerHour: 21.3, peakTotal: 33, peakHour: '10:00' },
      { name: 'Jamie', total: 58, avgPerHour: 19.3, peakTotal: 27, peakHour: '11:00' },
      { name: 'Alex', total: 51, avgPerHour: 17.0, peakTotal: 24, peakHour: '09:00' }
    ],
    packing: [
      { name: 'Felicia Prenger', total: 121, avgPerHour: 20.2, peakTotal: 31, peakHour: '10:00' },
      { name: 'Olivia Steward', total: 117, avgPerHour: 23.4, peakTotal: 45, peakHour: '12:00' },
      { name: 'Ryan', total: 108, avgPerHour: 21.6, peakTotal: 34, peakHour: '11:00' },
      { name: 'Chloe', total: 96, avgPerHour: 19.2, peakTotal: 29, peakHour: '14:00' },
      { name: 'Sarah', total: 91, avgPerHour: 18.2, peakTotal: 27, peakHour: '13:00' }
    ],
    hourly: [
      { hour: '08:00', picking: 114, packing: 17 },
      { hour: '09:00', picking: 0, packing: 36 },
      { hour: '10:00', picking: 5, packing: 71 },
      { hour: '11:00', picking: 0, packing: 84 },
      { hour: '12:00', picking: 4, packing: 32 },
      { hour: '13:00', picking: 0, packing: 26 },
      { hour: '14:00', picking: 12, packing: 29 },
      { hour: '15:00', picking: 51, packing: 19 }
    ],
    version: 'v6.0',
    mode: 'demo',
    updatedAt: new Date().toISOString()
  };
}

async function dashboardData() {
  const date = londonDateParts().iso;
  const targets = await getTargets();
  const target = num(targets[date]) || DEFAULT_TARGET;
  if (DEMO_MODE) return demoData(target);

  const statusPending = { field: 'status', op: 7, values: ['Pending'] };
  const statusPicked = { field: 'status', op: 7, values: ['Picked'] };
  const statusBlocked = { field: 'status', op: 7, values: ['Blocked'] };
  const dpd = { field: 'shipping_method', op: 7, values: ['DeliveryUKNextDayTracked'] };
  const royalMail = { field: 'shipping_method', op: 7, values: ['DeliveryUKFirstClassTracked'] };
  const priority = { field: 'priority', op: 1, values: ['true'] };
  const outstandingStatuses = { field: 'status', op: 7, values: ['Pending', 'Picked'] };

  const [leaderboardRaw, pickRaw, packRaw, holdRaw, priorityRaw, dpdPickRaw, dpdPackRaw, royalPickRaw, royalPackRaw, oldestRaw] = await Promise.all([
    hutchPost('/admin/Leaderboard', { date: hutchDatePayload() }),
    hutchPost('/orders/Count', { filters: [statusPending] }),
    hutchPost('/orders/Count', { filters: [statusPicked] }),
    hutchPost('/orders/Count', { filters: [statusBlocked] }),
    hutchPost('/orders/Count', { filters: [outstandingStatuses, priority] }),
    hutchPost('/orders/Count', { filters: [statusPending, dpd] }),
    hutchPost('/orders/Count', { filters: [statusPicked, dpd] }),
    hutchPost('/orders/Count', { filters: [statusPending, royalMail] }),
    hutchPost('/orders/Count', { filters: [statusPicked, royalMail] }),
    hutchPost('/orders/List', {
      is_search: false,
      filters: [outstandingStatuses],
      pagination: { order_by: 'created_at', direction: 1, limit: 1, cursor: '' }
    })
  ]);

  const leaderboard = parseLeaderboard(leaderboardRaw);
  const oldest = oldestOrderInfo(oldestRaw);
  const packedToday = leaderboard.packedToday;
  const [cycleTime, currentWait, dispatchEstimate] = await Promise.all([
    cycleSummaryForRollingDays(date, 7),
    currentOutstandingWaitSummary(),
    currentEstimatedDispatchSummary()
  ]);
  return {
    date,
    target,
    packedToday,
    remainingToTarget: Math.max(target - packedToday, 0),
    progressPct: target > 0 ? Math.min((packedToday / target) * 100, 100) : 0,
    remainingToPick: num(pickRaw?.count),
    remainingToPack: num(packRaw?.count),
    onHold: num(holdRaw?.count),
    priorityOrders: num(priorityRaw?.count),
    dpdToPick: num(dpdPickRaw?.count),
    dpdToPack: num(dpdPackRaw?.count),
    royalMailToPick: num(royalPickRaw?.count),
    royalMailToPack: num(royalPackRaw?.count),
    oldestOutstandingAt: oldest.oldestOutstandingAt,
    oldestOutstandingReference: oldest.oldestOutstandingReference,
    cycleTime,
    currentWait,
    dispatchEstimate,
    cycleRefresh: cycleRefreshStatus(),
    picking: leaderboard.picking,
    packing: leaderboard.packing,
    hourly: leaderboard.hourly,
    version: 'v6.0',
    mode: 'live',
    authStatus: HUTCH_REFRESH_TOKEN ? 'auto-refresh' : 'access-token',
    updatedAt: new Date().toISOString(),
    diagnostics: { users: leaderboard.rawUserCount, lastRefreshAt }
  };
}


function dateOnlyAdd(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateOnlyDiffDays(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

function localClockParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, hourCycle: 'h23'
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    second: `${parts.hour}:${parts.minute}:${parts.second}`,
    hour: parts.hour,
    minute: parts.minute
  };
}

function historyFile(date) {
  return path.join(HISTORY_DIR, `${date}.jsonl`);
}

async function readSnapshots(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return [];
  try {
    const raw = await fs.readFile(historyFile(date), 'utf8');
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
  } catch { return []; }
}

function minutesFromTime(value) {
  const m = /^(\d{2}):(\d{2})/.exec(String(value || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

function snapshotAtOrBefore(snapshots, time) {
  if (!snapshots.length) return null;
  const target = minutesFromTime(time);
  const before = snapshots.filter(s => minutesFromTime(s.localTime) <= target);
  return before.length ? before[before.length - 1] : snapshots[0];
}

function snapshotNearest(snapshots, time) {
  if (!snapshots.length) return null;
  const target = minutesFromTime(time);
  return snapshots.reduce((best, s) => {
    if (!best) return s;
    return Math.abs(minutesFromTime(s.localTime) - target) < Math.abs(minutesFromTime(best.localTime) - target) ? s : best;
  }, null);
}

async function appendSnapshot(data) {
  const now = new Date();
  const local = localClockParts(now);
  const bucketMinute = Math.floor(Number(local.minute) / 5) * 5;
  const bucket = `${local.date}T${local.hour}:${String(bucketMinute).padStart(2, '0')}`;
  const snapshots = await readSnapshots(local.date);
  if (snapshots.at(-1)?.bucket === bucket) return false;

  const snapshot = {
    ...data,
    capturedAt: now.toISOString(),
    localDate: local.date,
    localTime: local.second,
    bucket
  };
  await fs.appendFile(historyFile(local.date), JSON.stringify(snapshot) + '\n');
  return true;
}

let snapshotInProgress = false;
async function captureSnapshot() {
  if (snapshotInProgress || DEMO_MODE) return;
  snapshotInProgress = true;
  try {
    const data = await dashboardData();
    if (await appendSnapshot(data)) console.log(`Saved warehouse snapshot ${localClockParts().date} ${localClockParts().time}`);
  } catch (error) {
    console.error('Snapshot capture failed:', error.message);
  } finally {
    snapshotInProgress = false;
  }
}

async function historyDates() {
  try {
    const files = await fs.readdir(HISTORY_DIR);
    return files.filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map(f => f.slice(0, 10)).sort();
  } catch { return []; }
}

function dailyPersonBest(snapshots, roleKey) {
  const map = new Map();
  for (const snap of snapshots) {
    for (const row of Array.isArray(snap[roleKey]) ? snap[roleKey] : []) {
      const current = map.get(row.name);
      if (!current || num(row.total) > num(current.total)) map.set(row.name, row);
    }
  }
  return [...map.values()];
}

function aggregateWeeklyPeople(days, roleKey) {
  const map = new Map();
  for (const day of days) {
    for (const row of dailyPersonBest(day.snapshots, roleKey)) {
      const current = map.get(row.name) || { name: row.name, total: 0, completedHourlyTotal: 0, activeHours: 0, peakTotal: 0, peakHour: null, peakDate: null };
      current.total += num(row.total);
      current.completedHourlyTotal += num(row.completedHourlyTotal);
      current.activeHours += num(row.activeHours);
      if (num(row.peakTotal) > num(current.peakTotal)) {
        current.peakTotal = num(row.peakTotal);
        current.peakHour = row.peakHour || null;
        current.peakDate = day.date;
      }
      map.set(row.name, current);
    }
  }
  return [...map.values()].map(row => ({
    ...row,
    avgPerHour: row.activeHours ? row.completedHourlyTotal / row.activeHours : null
  })).sort((a, b) => b.total - a.total).slice(0, 10);
}

function finalHourlyForDay(snapshots) {
  let best = null;
  for (const snap of snapshots) {
    if (!best || num(snap.packedToday) >= num(best.packedToday)) best = snap;
  }
  return Array.isArray(best?.hourly) ? best.hourly : [];
}

function previousWeekStart() {
  const today = londonDateParts().iso;
  const d = new Date(`${today}T00:00:00Z`);
  const mondayOffset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - mondayOffset - 7);
  return d.toISOString().slice(0, 10);
}

function dayLabel(date) {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

async function weeklyData(weekStart) {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(weekStart || '')) ? weekStart : previousWeekStart();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = dateOnlyAdd(start, i);
    const snapshots = await readSnapshots(date);
    const actual = snapshots.length ? Math.max(...snapshots.map(s => num(s.packedToday))) : null;
    const last = snapshots.at(-1) || null;
    const target = last ? num(last.target) : null;
    days.push({ date, label: dayLabel(date), snapshots, actual, target });
  }

  const recorded = days.filter(d => d.snapshots.length);
  const daily = days.map(d => ({ date: d.date, label: d.label, dispatched: d.actual, target: d.target }));
  const totalDispatched = recorded.reduce((sum, d) => sum + num(d.actual), 0);
  const averageDaily = recorded.length ? totalDispatched / recorded.length : 0;
  const targetAchievedDays = recorded.filter(d => num(d.actual) >= num(d.target) && num(d.target) > 0).length;
  const peakDayRaw = recorded.reduce((best, d) => !best || num(d.actual) > num(best.actual) ? d : best, null);

  const hourlyMap = new Map();
  for (const d of recorded) {
    for (const h of finalHourlyForDay(d.snapshots)) {
      const row = hourlyMap.get(h.hour) || { hour: h.hour, picking: 0, packing: 0 };
      row.picking += num(h.picking);
      row.packing += num(h.packing);
      hourlyMap.set(h.hour, row);
    }
  }

  const benchmarkTimes = ['09:00', '12:00', '15:00', '18:00'];
  const backlogBenchmarks = benchmarkTimes.map(time => {
    const samples = recorded.map(d => snapshotNearest(d.snapshots, time)).filter(Boolean);
    return {
      time,
      days: samples.length,
      toPick: samples.length ? samples.reduce((a, s) => a + num(s.remainingToPick), 0) / samples.length : null,
      toPack: samples.length ? samples.reduce((a, s) => a + num(s.remainingToPack), 0) / samples.length : null
    };
  });

  const cycleRecords = await cycleRecordsForRange(start, dateOnlyAdd(start, 6));
  const cycleTime = cycleMetrics(cycleRecords);
  const cycleDaily = days.map(d => ({
    date: d.date,
    label: d.label,
    ...cycleMetrics(cycleRecords.filter(r => r.shippedDate === d.date))
  }));

  return {
    version: 'v6.0',
    weekStart: start,
    weekEnd: dateOnlyAdd(start, 6),
    daysWithData: recorded.length,
    totalDispatched,
    averageDaily,
    targetAchievedDays,
    peakDay: peakDayRaw ? { date: peakDayRaw.date, label: peakDayRaw.label, dispatched: peakDayRaw.actual } : null,
    daily,
    picking: aggregateWeeklyPeople(recorded, 'picking'),
    packing: aggregateWeeklyPeople(recorded, 'packing'),
    hourly: [...hourlyMap.values()].sort((a, b) => String(a.hour).localeCompare(String(b.hour))),
    backlogBenchmarks,
    cycleTime,
    cycleDaily
  };
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

async function serveStatic(req, res) {
  let pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (pathname === '/') pathname = '/index.html';
  const safePath = path.normalize(pathname).replace(/^\.\.(\/|\\|$)/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    const data = await fs.readFile(filePath);
    const cacheControl = path.extname(filePath) === '.html' ? 'no-store, max-age=0' : 'no-cache, max-age=0';
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': cacheControl });
    res.end(data);
    return true;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      try { return json(res, 200, await dashboardData()); }
      catch (error) {
        return json(res, error.status === 401 ? 401 : 502, {
          error: 'Unable to read Hutch data',
          message: error.message,
          code: error.code || 'HUTCH_ERROR',
          hint: error.status === 401
            ? (HUTCH_REFRESH_TOKEN ? 'Hutch automatic refresh failed. A new Hutch sign-in may be required.' : 'The Hutch access token expired. Configure HUTCH_REFRESH_TOKEN for automatic renewal, or sign in again and update HUTCH_BEARER_TOKEN.')
            : 'Check network access and Hutch API availability.'
        });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/history/dates') {
      return json(res, 200, { dates: await historyDates(), snapshotIntervalMinutes: Math.round(SNAPSHOT_INTERVAL_MS / 60000) });
    }
    if (req.method === 'GET' && url.pathname === '/api/history') {
      const date = String(url.searchParams.get('date') || '');
      const time = String(url.searchParams.get('time') || '12:00');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return json(res, 400, { error: 'Invalid date or time' });
      const snapshots = await readSnapshots(date);
      const selected = snapshotAtOrBefore(snapshots, time);
      const previousDate = dateOnlyAdd(date, -1);
      const previousSnapshots = await readSnapshots(previousDate);
      const previous = snapshotAtOrBefore(previousSnapshots, time);
      return json(res, 200, {
        version: 'v6.0',
        date,
        requestedTime: time,
        selected,
        comparison: previous ? { date: previousDate, snapshot: previous } : null,
        availableSnapshots: snapshots.length,
        snapshotIntervalMinutes: Math.round(SNAPSHOT_INTERVAL_MS / 60000)
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/weekly') {
      return json(res, 200, await weeklyData(url.searchParams.get('weekStart')));
    }
    if (req.method === 'GET' && url.pathname === '/api/cycle-time') {
      const date = String(url.searchParams.get('date') || londonDateParts().iso);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'Invalid date' });
      return json(res, 200, { version: 'v6.0', date, cycleTime: await cycleSummaryForDate(date), refresh: cycleRefreshStatus() });
    }
    if (req.method === 'POST' && url.pathname === '/api/target') {
      const body = await readBody(req);
      const date = String(body.date || londonDateParts().iso);
      const target = Math.round(num(body.target));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || target < 1 || target > 1000000) {
        return json(res, 400, { error: 'Invalid date or target' });
      }
      await saveTarget(date, target);
      return json(res, 200, { ok: true, date, target });
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        version: 'v6.0',
        mode: DEMO_MODE ? 'demo' : 'live',
        authMode: HUTCH_REFRESH_TOKEN ? 'refresh-token' : (hutchAccessToken ? 'access-token' : 'none'),
        accessTokenLoaded: Boolean(hutchAccessToken),
        refreshTokenConfigured: Boolean(HUTCH_REFRESH_TOKEN),
        lastRefreshAt,
        historyEnabled: true,
        snapshotIntervalMinutes: Math.round(SNAPSHOT_INTERVAL_MS / 60000),
        historyDirectory: HISTORY_DIR,
        timezone: APP_TIMEZONE,
        cycleTimeTracking: true,
        cycleRefreshMinutes: Math.round(CYCLE_REFRESH_INTERVAL_MS / 60000),
        cycleRefresh: cycleRefreshStatus()
      });
    }
    if (await serveStatic(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (error) {
    json(res, 500, { error: 'Server error', message: error.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dylan Oaks Warehouse Dashboard running at http://localhost:${PORT}`);
  if (DEMO_MODE) console.log('Mode: DEMO (set HUTCH_BEARER_TOKEN or HUTCH_REFRESH_TOKEN for live data)');
  else if (HUTCH_REFRESH_TOKEN) console.log('Mode: LIVE Hutch API (automatic token refresh enabled)');
  else console.log('Mode: LIVE Hutch API (access token only)');
});


if (!DEMO_MODE) {
  // Take one snapshot shortly after startup, then every five minutes.
  setTimeout(() => captureSnapshot(), 10000);
  const delay = SNAPSHOT_INTERVAL_MS - (Date.now() % SNAPSHOT_INTERVAL_MS) + 2500;
  setTimeout(() => {
    captureSnapshot();
    setInterval(captureSnapshot, SNAPSHOT_INTERVAL_MS);
  }, delay);
}


if (!DEMO_MODE) {
  // Build a controlled one-time cache of recent shipped orders, then maintain it every three hours.
  // Backfill is sequential and deliberately paced to avoid a burst of Timeline requests.
  await loadCycleRefreshState();

  const scheduleCycleRefresh = () => {
    const last = Date.parse(cycleLastSuccessAt || cycleLastAttemptAt || '');
    const dueAt = Number.isFinite(last) ? last + CYCLE_REFRESH_INTERVAL_MS : Date.now() + 5000;
    const delay = Math.max(5000, dueAt - Date.now());
    setTimeout(async () => {
      await refreshCycleTimes();
      scheduleCycleRefresh();
    }, delay);
  };

  const runReconciliation = async () => {
    if (cycleReconcileCompleted) return;
    console.log(`Starting one-time deep cycle-time reconciliation: scanning up to ${CYCLE_RECONCILE_MAX_PAGES * 50} shipped orders; only missing orders will request Timeline, one every ${Math.round(CYCLE_TIMELINE_DELAY_MS / 1000)}s.`);
    await refreshCycleTimes({ force: true, reconcile: true });
    if (!cycleReconcileCompleted) {
      console.warn(`Cycle-time reconciliation is incomplete; retrying in ${Math.round(CYCLE_RECONCILE_RETRY_MS / 60000)} minutes. Cached successes will not be requested again.`);
      setTimeout(runReconciliation, CYCLE_RECONCILE_RETRY_MS);
    }
  };

  setTimeout(async () => {
    if (!cycleBackfillCompleted) {
      console.log(`Starting controlled cycle-time backfill: up to ${CYCLE_BACKFILL_MAX_NEW_TIMELINES} new orders, one Timeline request every ${Math.round(CYCLE_TIMELINE_DELAY_MS / 1000)}s.`);
      await refreshCycleTimes({ force: true, backfill: true });
    }

    // v6 one-time catch-up: go deeper than the normal 2,000-order scan to fill
    // any gaps caused by older-created orders being shipped recently. This state
    // is persisted on the Render disk so future deploys do not repeat the scan.
    if (!cycleReconcileCompleted) await runReconciliation();

    if (cycleRefreshDue()) await refreshCycleTimes();
    scheduleCycleRefresh();
  }, 5000);
}

