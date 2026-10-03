'use strict';
import { coverageForDay, clockMinutes, clockLabel, shiftWindow } from './coverage.js';
const departmentColour = { Picking: 'blue', Engraving: 'violet', Packing: 'teal' };
const $ = id => document.getElementById(id);
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const departments = ['Picking', 'Engraving', 'Packing'];
const warehouses = ['Warehouse 1', 'Warehouse 2'];
const defaultDepartment = p => p.default_department ?? (departments.includes(p.team) ? p.team : '');
const departmentName = p => defaultDepartment(p) || 'No department';
const choices = (items, selected) => items.map(v => `<option value="${h(v)}" ${v === selected ? 'selected' : ''}>${h(v)}</option>`).join('');
const kindNames = { work: 'Work', training: 'Training', holiday: 'Holiday', unavailable: 'Unavailable' };
const paths = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  share: '<rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/><rect x="3" y="15" width="6" height="6"/><path d="M15 15h3v3h3v3h-6v-3M21 12v3M12 3v9H3M12 15v6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
const readOnly = /^\/rota\//.test(location.pathname);
const shareToken = readOnly ? location.pathname.split('/').at(-1) : '';
function londonToday() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = t => parts.find(p => p.type === t).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function plusDays(date, n) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function monday(date) { const day = new Date(`${date}T12:00:00Z`).getUTCDay(); return plusDays(date, -((day + 6) % 7)); }
function shortDate(date, options = {}) { return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC', ...options }).format(new Date(`${date}T12:00:00Z`)); }
const hours = minutes => Number((minutes / 60).toFixed(2)).toLocaleString('en-GB', { maximumFractionDigits: 2 });
function minutes(shift) {
  if (!['work', 'training'].includes(shift.kind)) return 0;
  const parse = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  let diff = parse(shift.end_time) - parse(shift.start_time);
  if (diff < 0) diff += 1440;
  return diff - shift.break_minutes;
}
function stored(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function store(key, value) { try { localStorage.setItem(key, value); } catch {} }
const S = {
  data: null, week: monday(londonToday()), locationId: stored('rota-location', ''),
  query: '', team: '', warehouse: '', view: stored('rota-view', matchMedia('(max-width: 720px)').matches ? 'day' : 'week'),
  day: (new Date(`${londonToday()}T12:00:00Z`).getUTCDay() + 6) % 7,
  coverageStart: '08:00', coverageEnd: '16:30', minimumCover: 1,
  selected: new Set(), authenticated: false, loading: false
};
if (readOnly && S.view === 'timeline') S.view = 'day';
const rotaContent = () => S.view === 'timeline' && !readOnly ? renderTimeline() : S.view === 'week' ? renderGrid() : renderDay();
let loadSequence = 0, toastTimer, focusBeforeDialog;
function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').className = error ? 'visible error' : 'visible';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').className = '', error ? 7000 : 4500);
}
async function api(url, options = {}) {
  const headers = { ...options.headers };
  if (options.method && options.method !== 'GET') {
    headers['Content-Type'] = 'application/json'; headers['X-Rota-Request'] = '1';
    if (S.data?.revision !== undefined) headers['If-Match'] = String(S.data.revision);
  }
  const response = await fetch(url, { ...options, headers });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 409) await load();
    if (response.status === 401 && !readOnly && !url.endsWith('/api/login')) { S.authenticated = false; renderLogin(); }
    throw new Error(result.error || 'The request could not be completed.');
  }
  return result;
}
async function load(background = false) {
  const sequence = ++loadSequence;
  if (!background) { S.loading = true; $('app').setAttribute('aria-busy', 'true'); }
  try {
    let data;
    if (readOnly) {
      const week = S.data || new URLSearchParams(location.search).has('week') ? `?week=${encodeURIComponent(S.week)}` : '';
      data = await api(`/api/public/${encodeURIComponent(shareToken)}${week}`);
    } else {
      if (!S.authenticated) {
        const session = await api('/api/session');
        if (sequence !== loadSequence) return;
        if (!session.authenticated) { S.loading = false; renderLogin(); return; }
        S.authenticated = true;
      }
      data = await api(`/api/state?week=${S.week}`);
    }
    if (sequence !== loadSequence) return;
    const same = background && S.data && (readOnly ? data.published_at === S.data.published_at && data.week === S.data.week && data.unpublished === S.data.unpublished && JSON.stringify(data.weeks) === JSON.stringify(S.data.weeks) : data.revision === S.data.revision);
    S.data = data; S.week = data.week;
    S.loading = false;
    if (!readOnly) {
      if (!data.locations.some(l => l.id === S.locationId)) S.locationId = data.locations.find(l => l.active)?.id || data.locations[0].id;
      const valid = new Set(data.people.filter(p => p.active).map(p => p.id));
      for (const id of S.selected) if (!valid.has(id)) S.selected.delete(id);
    } else S.locationId = data.location.id;
    if (!same) render();
  } catch (error) {
    S.loading = false;
    if (S.data) { S.week = S.data.week; toast(error.message, true); }
    else $('app').innerHTML = `<main class="error-screen"><h1>Rota unavailable</h1><p>${h(error.message)}</p><button class="button primary" data-action="retry">Try again</button></main>`;
  }
  $('app').setAttribute('aria-busy', 'false');
}
async function mutate(url, body = {}, method = 'POST') {
  const result = await api(url, { method, body: JSON.stringify(body) });
  if (S.data) S.data.revision = result.revision;
  await load();
  return result;
}
async function formAction(form, action) {
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(b => b.disabled = true);
  $('form-error') && ($('form-error').textContent = '');
  try { await action(); } catch (error) {
    if ($('form-error')) $('form-error').textContent = error.message;
    else toast(error.message, true);
  } finally { buttons.forEach(b => b.disabled = false); }
}
function currentLocation() { return readOnly ? S.data.location : S.data.locations.find(l => l.id === S.locationId); }
function allLocationShifts() { return S.data.shifts.filter(s => s.location_id === S.locationId); }
function locationShifts() { return allLocationShifts().filter(s => (!S.team || s.department === S.team) && (!S.warehouse || s.warehouse === S.warehouse)); }
function peopleForLocation() {
  if (readOnly) return S.data.people;
  const ids = new Set(allLocationShifts().map(s => s.person_id));
  return S.data.people.filter(p => (p.active && p.location_id === S.locationId) || ids.has(p.id));
}
function visiblePeople() {
  const query = S.query.toLocaleLowerCase();
  const assigned = new Set(locationShifts().map(s => s.person_id));
  return peopleForLocation().filter(p => (!(S.team || S.warehouse) || assigned.has(p.id)) && (!query || p.name.toLocaleLowerCase().includes(query)))
    .sort((a, b) => (departments.indexOf(defaultDepartment(a)) + 1 || 4) - (departments.indexOf(defaultDepartment(b)) + 1 || 4) || a.row_order - b.row_order || a.name.localeCompare(b.name));
}
function publication() { return readOnly ? null : S.data.publications.find(p => p.location_id === S.locationId); }
function personHours(personId) { return S.data.shifts.filter(s => s.person_id === personId).reduce((sum, s) => sum + minutes(s), 0); }
function dayMetrics(date) {
  const shifts = locationShifts().filter(s => s.date === date && ['work', 'training'].includes(s.kind));
  return { count: new Set(shifts.map(s => s.person_id)).size, minutes: shifts.reduce((sum, s) => sum + minutes(s), 0) };
}
function renderLogin() {
  $('app').setAttribute('aria-busy', 'false');
  $('app').innerHTML = `<main class="login-shell"><div class="login-brand"><span class="brand-symbol">${icon('calendar')}</span> DYLAN OAKS</div><section class="login-card"><span class="eyebrow">WAREHOUSE OPERATIONS</span><h1>Plan the week.</h1><p>Sign in to manage colleagues, shifts and the published rota.</p><form id="login-form"><label for="password">Manager password</label><input id="password" type="password" name="password" autocomplete="current-password" required maxlength="256"><p id="login-error" class="form-error" role="alert"></p><button class="button primary full" type="submit">Sign in</button></form><p class="login-note">Colleagues can scan the shared QR code to view the published rota.</p></section></main>`;
  $('login-form').onsubmit = async event => {
    event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) }); S.authenticated = true; await load(); }
    catch (error) { $('login-error').textContent = error.message; }
    finally { button.disabled = false; }
  };
}
function shiftCard(shift) {
  const working = ['work', 'training'].includes(shift.kind);
  const overnight = working && shift.end_time < shift.start_time;
  const detail = working ? `${hours(minutes(shift))}h${shift.break_minutes ? shift.break_start ? ` · Break ${shift.break_start}–${clockLabel(clockMinutes(shift.break_start) + shift.break_minutes)}` : ` · ${shift.break_minutes}m break (time unset)` : ''}` : 'All day';
  const assignment = [shift.department, shift.warehouse].filter(Boolean).join(' · ');
  const shortWarehouse = shift.warehouse === 'Warehouse 1' ? 'WH1' : shift.warehouse === 'Warehouse 2' ? 'WH2' : shift.warehouse;
  const untimedBreak = `<span class="break-untimed-full">${shift.break_minutes}m break (time unset)</span><span class="break-untimed-compact">Break ${shift.break_minutes}m · unset</span>`;
  const breakDetail = working && shift.break_minutes ? `<span class="shift-net">${hours(minutes(shift))}h · </span>${shift.break_start ? `Break ${h(shift.break_start)}–${clockLabel(clockMinutes(shift.break_start) + shift.break_minutes)}` : untimedBreak}` : h(detail);
  const title = [shift.label, working ? `${shift.start_time}–${shift.end_time}${overnight ? ' +1' : ''}` : kindNames[shift.kind], assignment, detail].filter(Boolean).join(' · ');
  const content = `<span class="shift-time">${working ? `${h(shift.start_time)}–${h(shift.end_time)}${overnight ? '<sup>+1</sup>' : ''}` : h(kindNames[shift.kind])}${shift.kind === 'training' ? '<span class="training-mark">Training</span>' : ''}</span><span class="shift-label">${h(shift.label)}</span>${assignment || working ? `<span class="shift-assignment" title="${h(assignment)}">${assignment ? [shift.department, shortWarehouse].filter(Boolean).map(v => `<span>${h(v)}</span>`).join(' · ') : 'Set department and warehouse'}${working && !shift.warehouse && assignment ? ' · Set warehouse' : ''}</span>` : ''}<span class="shift-detail">${breakDetail}</span>`;
  return readOnly ? `<div class="shift-card ${h(working ? departmentColour[shift.department] || shift.colour : shift.kind)}" title="${h(title)}">${content}</div>` : `<button class="shift-card ${h(working ? departmentColour[shift.department] || shift.colour : shift.kind)}" title="${h(title)}" data-action="edit-shift" data-id="${h(shift.id)}" aria-label="Edit ${h(title)} on ${h(shift.date)}">${content}</button>`;
}
function renderGrid() {
  const people = visiblePeople(), shifts = locationShifts();
  if (!people.length) return `<section class="empty-state"><span class="empty-icon">${icon('people')}</span><h2>${peopleForLocation().length ? 'No colleagues match your search' : readOnly ? 'No shifts to show' : 'Add your warehouse team'}</h2><p>${peopleForLocation().length ? 'Try a different name, department or warehouse.' : readOnly ? 'Your manager will publish the rota here.' : 'Import your colleague list, then set up your usual shift patterns.'}</p>${!readOnly && !peopleForLocation().length ? '<button class="button primary" data-action="team">Add colleagues</button><button class="button" data-action="patterns">Set shift patterns</button>' : ''}</section>`;
  const allSelected = people.filter(p => p.active).length > 0 && people.filter(p => p.active).every(p => S.selected.has(p.id));
  const head = days.map((day, index) => {
    const date = plusDays(S.week, index), stats = dayMetrics(date);
    return `<th class="day-column ${date === londonToday() ? 'today-column' : ''}" scope="col"><span class="day-name">${day}</span><span class="day-date">${shortDate(date, { month: undefined })}</span><span class="day-summary">${stats.count} on · ${hours(stats.minutes)}h</span></th>`;
  }).join('');
  let lastTeam = '';
  const rows = people.map(p => {
    let separator = '';
    const group = departmentName(p);
    if (group !== lastTeam) { separator = `<tr class="team-separator"><th colspan="${readOnly ? 9 : 10}" scope="rowgroup">${h(group)} <span>${people.filter(x => departmentName(x) === group).length}</span></th></tr>`; lastTeam = group; }
    const total = personHours(p.id);
    const over = !readOnly && p.contract_minutes > 0 && total > p.contract_minutes;
    const cells = days.map((_, index) => {
      const date = plusDays(S.week, index), entries = shifts.filter(s => s.person_id === p.id && s.date === date);
      return `<td class="shift-cell ${date === londonToday() ? 'today-column' : ''}">${entries.map(shiftCard).join('')}${!readOnly && p.active ? `<button class="cell-add ${entries.length ? 'small' : ''}" data-action="add-cell" data-person="${h(p.id)}" data-date="${date}" aria-label="Add shift for ${h(p.name)} on ${shortDate(date)}">${icon('plus')}</button>` : !entries.length ? '<span class="off-day">—</span>' : ''}</td>`;
    }).join('');
    const initials = p.name.split(/\s+/).slice(0, 2).map(n => n[0]).join('');
    return `${separator}<tr class="colleague-row">${!readOnly ? `<td class="check-cell"><input type="checkbox" data-select-person="${h(p.id)}" aria-label="Select ${h(p.name)}" ${S.selected.has(p.id) ? 'checked' : ''} ${p.active ? '' : 'disabled'}></td>` : ''}<th class="person-column" scope="row"><div class="person-name-row"><span class="avatar">${h(initials)}</span><span>${readOnly ? `<span class="person-name" title="${h(p.name)}">${h(p.name)}</span>` : `<button class="person-name profile-link" title="${h(p.name)}" data-action="profile" data-person="${h(p.id)}">${h(p.name)}</button>`}<span class="person-role" title="${h(p.role || departmentName(p))}${p.is_example ? ' · Example' : ''}${!readOnly && !p.active ? ' · Archived' : ''}">${h(p.role || departmentName(p))}${p.is_example ? ' · Example' : ''}${!readOnly && !p.active ? ' · Archived' : ''}</span></span></div></th>${cells}<td class="hours-column ${over ? 'over-hours' : ''}" title="${readOnly ? 'Scheduled hours' : 'Scheduled hours across all locations'}"><strong>${hours(total)}<small>h</small></strong>${!readOnly && p.contract_minutes > 0 ? `<span>of ${hours(p.contract_minutes)}h</span>` : ''}</td></tr>`;
  }).join('');
  return `<div class="rota-scroll" tabindex="0" aria-label="Weekly rota; scroll to see all colleagues and days"><table class="rota-table ${readOnly ? 'read-only' : ''}"><thead><tr>${!readOnly ? `<th class="check-cell" scope="col"><input id="select-all" type="checkbox" aria-label="Select all visible colleagues" ${allSelected ? 'checked' : ''}></th>` : ''}<th class="person-column" scope="col">Colleague <span class="muted">${people.length}</span></th>${head}<th class="hours-column" scope="col">Hours</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function renderDay() {
  const date = plusDays(S.week, S.day), shifts = locationShifts().filter(s => s.date === date), people = visiblePeople();
  const tabs = days.map((d, i) => `<button class="day-tab ${i === S.day ? 'active' : ''}" data-action="day" data-day="${i}" aria-pressed="${i === S.day}"><span>${d}</span><strong>${shortDate(plusDays(S.week, i), { month: undefined })}</strong><small>${dayMetrics(plusDays(S.week, i)).count} on</small></button>`).join('');
  const rows = people.map(p => {
    const entries = shifts.filter(s => s.person_id === p.id);
    return `<article class="day-person"><div>${readOnly ? `<strong>${h(p.name)}</strong>` : `<button class="profile-link" data-action="profile" data-person="${h(p.id)}">${h(p.name)}</button>`}<span class="person-role">${h(departmentName(p))}${p.role ? ` · ${h(p.role)}` : ''}</span></div><div class="day-shifts">${entries.length ? entries.map(shiftCard).join('') : '<span class="off-label">No shift</span>'}${!readOnly && p.active ? `<button class="button compact" data-action="add-cell" data-person="${h(p.id)}" data-date="${date}" aria-label="Add shift for ${h(p.name)}">${icon('plus')}</button>` : ''}</div></article>`;
  }).join('');
  return `<div class="day-tabs" aria-label="Choose day">${tabs}</div><div class="day-list">${rows || '<div class="empty-state"><h2>No colleagues to show</h2><p>Try a different filter or add colleagues.</p></div>'}</div>`;
}
function renderTimeline() {
  const date = plusDays(S.week, S.day);
  const start = S.coverageFull ? 0 : clockMinutes(S.coverageStart), end = S.coverageFull ? 1440 : clockMinutes(S.coverageEnd);
  const tabs = `<div class="day-tabs">${days.map((d, i) => `<button class="day-tab ${i === S.day ? 'active' : ''}" data-action="day" data-day="${i}" aria-pressed="${i === S.day}"><span>${d}</span><strong>${shortDate(plusDays(S.week, i), { month: undefined })}</strong></button>`).join('')}</div>`;
  const controls = `<div class="coverage-controls"><label>Cover from<input id="coverage-start" type="time" value="${S.coverageStart}" ${S.coverageFull ? 'disabled' : ''}></label><label>Cover until<input id="coverage-end" type="time" value="${S.coverageEnd}" ${S.coverageFull ? 'disabled' : ''}></label><label>Minimum per department<input id="minimum-cover" type="number" min="0" max="100" value="${S.minimumCover}"></label><button class="button" data-action="coverage-full" aria-pressed="${Boolean(S.coverageFull)}">${S.coverageFull ? 'Use chosen hours' : 'Show 24 hours'}</button></div>`;
  if (!(end > start)) return tabs + controls + '<p class="coverage-help">Choose a finish after the start, or show 24 hours.</p>';
  const shifts = [...(S.data.previousShifts || []), ...allLocationShifts()].filter(s => s.location_id === S.locationId);
  const x = value => Math.max(0, Math.min(1000, (value - start) / (end - start) * 1000));
  const axis = `<svg preserveAspectRatio="none" viewBox="0 0 1000 26" class="timeline-axis" aria-hidden="true">${Array.from({ length: Math.ceil((end - start) / 60) + 1 }, (_, i) => start + i * 60).filter(t => t <= end).map(t => `<text x="${x(t)}" y="18" text-anchor="${t === start ? 'start' : t === end ? 'end' : 'middle'}">${clockLabel(t)}</text>`).join('')}</svg>`;
  const groups = warehouses.filter(w => !S.warehouse || w === S.warehouse).map(warehouse => {
    const sections = departments.filter(d => !S.team || d === S.team).map(department => {
      const data = coverageForDay(shifts, date, { warehouse, department, start, end, minimum: S.minimumCover });
      const colour = departmentColour[department];
      const gapMinutes = data.gaps.reduce((sum, segment) => sum + segment.end - segment.start, 0);
      const status = data.unplaced.length ? `${data.unplaced.length} break time${data.unplaced.length === 1 ? '' : 's'} needed` : gapMinutes ? `${gapMinutes} minutes below cover` : 'Cover confirmed';
      const summary = `<svg preserveAspectRatio="none" viewBox="0 0 1000 42" class="coverage-summary" role="img" aria-label="${h(department)} ${h(warehouse)} available colleagues after breaks">${data.segments.map(s => { const left = x(s.start), width = x(s.end) - left; return `<g><title>${clockLabel(s.start)}–${clockLabel(s.end)}: ${s.available} available, ${s.onBreak} on break${s.unplaced ? `, ${s.unplaced} breaks awaiting a time` : ''}</title><rect x="${left}" y="3" width="${width}" height="34" class="coverage-${s.status} ${colour}"/>${width > 30 ? `<text x="${left + width / 2}" y="25" text-anchor="middle">${s.available}${s.unplaced ? '?' : ''}</text>` : ''}</g>`; }).join('')}</svg>`;
      const windows = data.windows.filter(({ shift }) => !S.query || S.data.people.find(p => p.id === shift.person_id)?.name.toLocaleLowerCase().includes(S.query.toLocaleLowerCase()));
      const detail = windows.map(({ shift, window: w }) => {
        const p = S.data.people.find(p => p.id === shift.person_id);
        const left = x(w.start), right = x(w.end), pattern = `break-${shift.id}`;
        const bar = `<svg preserveAspectRatio="none" viewBox="0 0 1000 30" role="img" aria-label="${h(p?.name)} ${h(shift.start_time)} to ${h(shift.end_time)}${shift.break_start ? `, break ${h(shift.break_start)} for ${shift.break_minutes} minutes` : ''}"><defs><pattern id="${h(pattern)}" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#ffffff"/><path d="M0 8L8 0" stroke="#586780" stroke-width="2"/></pattern></defs><rect x="${left}" y="5" width="${right - left}" height="20" rx="3" class="timeline-work ${colour}"/>${w.breakStart !== null && w.breakEnd > start && w.breakStart < end ? `<rect x="${x(w.breakStart)}" y="5" width="${x(w.breakEnd) - x(w.breakStart)}" height="20" fill="url(#${h(pattern)})"/>` : ''}</svg>`;
        return `<button class="timeline-row timeline-person" data-action="edit-shift" data-id="${h(shift.id)}"><span class="timeline-name"><strong>${h(p?.name || 'Colleague')}</strong><small>${h(shift.start_time)}–${h(shift.end_time)} · ${shift.break_start ? `Break ${h(shift.break_start)}–${clockLabel(clockMinutes(shift.break_start) + shift.break_minutes)}` : shift.break_minutes ? 'Break time needed' : 'No break'}</small></span>${bar}</button>`;
      }).join('');
      const gaps = data.gaps.map(s => `${clockLabel(s.start)}–${clockLabel(s.end)} (${s.available} available)`).join(', ');
      return `<section class="coverage-department"><div class="coverage-heading"><strong class="department-text ${colour}">${h(department)}</strong><span class="coverage-status ${gapMinutes ? 'gap' : data.unplaced.length ? 'unconfirmed' : 'covered'}">${h(status)}</span></div><div class="timeline-row"><span class="timeline-name">Available after breaks</span>${summary}</div>${gaps ? `<p class="coverage-alert">Below ${S.minimumCover}: ${h(gaps)}</p>` : ''}${detail ? `<details class="timeline-details"><summary>View ${windows.length} colleague${windows.length === 1 ? '' : 's'} and breaks</summary>${detail}</details>` : '<p class="coverage-help">No shifts in this time range.</p>'}</section>`;
    }).join('');
    return `<section class="warehouse-timeline"><h3><span class="warehouse-badge">${warehouse === 'Warehouse 1' ? 'WH1' : 'WH2'}</span>${h(warehouse)}</h3><div class="timeline-row timeline-axis-row"><span class="timeline-name">${shortDate(date, { weekday: 'long' })}</span>${axis}</div>${sections}</section>`;
  }).join('');
  return tabs + controls + '<p class="coverage-help">Numbers show available colleagues after timed breaks. Hatched sections are breaks. A ? means break times are still needed; cover is unconfirmed. Name search filters the individual rows, while coverage counts include the full department. Click a colleague’s bar to change their shift or break.</p>' + `<div class="timeline-scroll">${groups}</div>`;
}
function render() {
  const data = S.data; if (!data) return;
  const loc = currentLocation(), people = visiblePeople(), shifts = locationShifts();
  const work = shifts.filter(s => ['work', 'training'].includes(s.kind));
  const total = work.reduce((sum, s) => sum + minutes(s), 0);
  const pub = publication();
  const status = readOnly ? 'Published rota' : pub ? pub.dirty ? 'Changes to publish' : 'Published' : 'Private draft';
  const end = plusDays(S.week, 6);
  $('app').innerHTML = `<header class="topbar"><a class="brand" href="${readOnly ? h(location.pathname) : '/'}"><span class="brand-symbol">${icon('calendar')}</span><span>DYLAN OAKS <small>ROTA</small></span></a>${readOnly ? '<span class="viewer-badge">Colleague view</span>' : `<nav aria-label="Rota management"><button class="nav-button" data-action="team">${icon('people')}<span>Colleagues</span></button><button class="nav-button" data-action="patterns">${icon('clock')}<span>Shift patterns</span></button><button class="nav-button" data-action="settings" aria-label="Settings">${icon('settings')}</button><button class="button lime" data-action="share">${icon('share')}<span>Share rota</span></button></nav>`}</header>
  <main class="workspace"><div class="page-heading"><div><span class="eyebrow">${h(loc.name.toUpperCase())}${data.demo ? ' · EXAMPLE DATA' : ''}</span><h1>${readOnly ? 'Your team’s rota' : 'Weekly rota'}</h1></div><div class="heading-summary"><span>${icon('people')}<strong>${people.length}</strong> colleagues</span><span>${icon('clock')}<strong>${hours(total)}h</strong> scheduled</span><span class="publication ${status === 'Published' || readOnly ? 'published' : ''}">${h(status)}</span></div></div>
  <section class="rota-panel" aria-label="Rota planner"><div class="week-toolbar"><div class="week-controls"><button class="button icon-only" data-action="previous" aria-label="Previous week">${icon('left')}</button><div class="week-title"><strong>${shortDate(S.week)} – ${shortDate(end, { year: 'numeric' })}</strong><span>Week commencing Monday</span></div><button class="button icon-only" data-action="next" aria-label="Next week">${icon('right')}</button><button class="button this-week" data-action="today">This week</button><label class="date-jump"><span class="sr-only">Jump to a week</span><input id="week-picker" type="date" value="${S.week}" min="2020-01-01" max="2100-12-31" aria-label="Jump to a week"></label></div>${!readOnly ? `<div class="week-actions"><label class="location-picker"><span class="sr-only">Location</span><select id="location-picker">${data.locations.map(l => `<option value="${h(l.id)}" ${l.id === S.locationId ? 'selected' : ''}>${h(l.name)}${!l.active ? ' (archived)' : ''}</option>`).join('')}</select></label><button class="button primary" data-action="publish">${icon('check')}${pub ? 'Publish changes' : 'Publish week'}</button></div>` : data.weeks.length ? `<label class="published-picker"><span class="sr-only">Published weeks</span><select id="published-week"><option value="${S.week}">Choose published week</option>${data.weeks.map(w => `<option value="${w.week}">${shortDate(w.week)} – ${shortDate(plusDays(w.week, 6))}</option>`).join('')}</select></label>` : ''}</div>
  <div class="filter-toolbar"><div class="filters"><label class="search-field">${icon('search')}<span class="sr-only">Find a colleague</span><input id="colleague-search" type="search" value="${h(S.query)}" placeholder="${readOnly ? 'Find your name…' : 'Find a colleague…'}" autocomplete="off"></label><label><span class="sr-only">Department</span><select id="team-filter"><option value="">All departments</option>${choices(departments, S.team)}</select></label><label><span class="sr-only">Warehouse</span><select id="warehouse-filter"><option value="">Both warehouses</option>${choices(warehouses, S.warehouse)}</select></label><div class="view-toggle" aria-label="Rota view"><button data-action="view-week" class="${S.view === 'week' ? 'active' : ''}" aria-pressed="${S.view === 'week'}">Week</button><button data-action="view-day" class="${S.view === 'day' ? 'active' : ''}" aria-pressed="${S.view === 'day'}">Day</button>${!readOnly ? `<button data-action="view-timeline" class="${S.view === 'timeline' ? 'active' : ''}" aria-pressed="${S.view === 'timeline'}">Timeline</button>` : ''}</div></div>${!readOnly ? `<div class="edit-actions"><button class="button" data-action="copy">${icon('copy')}<span>Copy last week</span></button><button class="button dark" data-action="assign">${icon('plus')}<span>Assign shifts</span></button></div>` : '<button class="button" data-action="pdf">Download PDF</button><button class="button" data-action="print">Print rota</button>'}</div>
  ${!readOnly && S.selected.size ? `<div class="selection-bar"><strong>${S.selected.size} colleague${S.selected.size === 1 ? '' : 's'} selected</strong><button class="button compact" data-action="assign">Assign shifts</button><button class="text-button" data-action="clear-selection">Clear selection</button></div>` : ''}
  ${readOnly && data.unpublished ? `<div class="empty-state"><span class="empty-icon">${icon('calendar')}</span><h2>This week hasn’t been published yet</h2><p>Select a published week above or check again later.</p></div>` : `<div id="rota-content">${rotaContent()}</div>`}
  <footer class="panel-footer"><div class="legend"><span><i class="legend-picking"></i>Picking</span><span><i class="legend-engraving"></i>Engraving</span><span><i class="legend-packing"></i>Packing</span><span><i class="legend-holiday"></i>Holiday</span><span><i class="legend-unavailable"></i>Unavailable</span></div><span>${readOnly && data.published_at ? `Updated ${h(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(data.published_at)))}` : !readOnly ? 'Private draft edits appear to colleagues after publishing.' : ''}</span></footer></section><div class="workspace-footer"><span>WH1 = Warehouse 1 · WH2 = Warehouse 2. UK local time. Breaks are unpaid. +1 means next-day finish.</span>${!readOnly ? `<div><a class="text-button" href="/api/export.csv?locationId=${encodeURIComponent(S.locationId)}&week=${S.week}">Export CSV</a><button class="text-button" data-action="pdf">Share PDF</button><button class="text-button" data-action="print">Print</button><button class="text-button" data-action="logout">Sign out</button></div>` : '<a class="text-button" href="/">Manager sign in</a>'}</div></main>`;
  $('colleague-search').oninput = event => {
    S.query = event.target.value;
    if (S.view === 'timeline') { const position = event.target.selectionStart; render(); $('colleague-search').focus(); $('colleague-search').setSelectionRange(position, position); }
    else { const content = $('rota-content'); if (content) content.innerHTML = rotaContent(); }
  };
  $('team-filter').onchange = event => { S.team = event.target.value; S.selected.clear(); render(); };
  if ($('coverage-start')) $('coverage-start').onchange = event => { if (event.target.value) S.coverageStart = event.target.value; render(); };
  if ($('coverage-end')) $('coverage-end').onchange = event => { if (event.target.value) S.coverageEnd = event.target.value; render(); };
  if ($('minimum-cover')) $('minimum-cover').onchange = event => { S.minimumCover = Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0))); render(); };
  $('warehouse-filter').onchange = event => { S.warehouse = event.target.value; S.selected.clear(); render(); };
  $('week-picker').onchange = event => { if (event.target.value) changeWeek(monday(event.target.value)); };
  if ($('location-picker')) $('location-picker').onchange = event => { S.locationId = event.target.value; S.team = ''; S.warehouse = ''; S.selected.clear(); store('rota-location', S.locationId); render(); };
  if ($('published-week')) $('published-week').onchange = event => changeWeek(event.target.value);
  $('app').setAttribute('aria-busy', 'false');
}
function changeWeek(week) {
  if (week < '2020-01-01' || week > '2100-12-31') return;
  S.week = week; S.selected.clear(); load();
}
function closeDialog() {
  $('modal').close();
  if (focusBeforeDialog?.isConnected) focusBeforeDialog.focus();
}
function modal(title, content, footer, wide = false) {
  const dialog = $('modal'); focusBeforeDialog = document.activeElement;
  dialog.className = wide ? 'wide-dialog' : '';
  dialog.innerHTML = `<form id="dialog-form"><div class="dialog-head"><h2 id="modal-title">${h(title)}</h2><button type="button" class="button icon-only subtle" data-action="close-modal" aria-label="Close">${icon('close')}</button></div><div class="dialog-body">${content}<p id="form-error" class="form-error" role="alert"></p></div>${footer ? `<div class="dialog-footer">${footer}</div>` : ''}</form>`;
  dialog.dataset.profileId = '';
  if (!dialog.open) dialog.showModal();
  $('dialog-form').onsubmit = event => event.preventDefault();
}
const cancel = '<button class="button" type="button" data-action="close-modal">Cancel</button>';
function patternOptions(selected = '') {
  return `<option value="">Manual shift</option>${S.data.templates.map(t => `<option value="${h(t.id)}" ${t.id === selected ? 'selected' : ''}>${h(t.name)} · ${h(t.start_time)}–${h(t.end_time)}</option>`).join('')}`;
}
function fieldsHTML(shift = {}) {
  return `<div class="field-row"><label>Shift type<select id="shift-kind">${Object.entries(kindNames).map(([k, v]) => `<option value="${k}" ${(shift.kind || 'work') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label>Shift name<input id="shift-label" maxlength="60" value="${h(shift.label || 'Shift')}" required></label></div><div id="working-fields"><div class="field-row three"><label>Start<input id="shift-start" type="time" value="${h(shift.start_time || '')}" required></label><label>Finish<input id="shift-end" type="time" value="${h(shift.end_time || '')}" required></label><label>Unpaid break (mins)<input id="shift-break" type="number" min="0" max="240" step="1" value="${shift.break_minutes || 0}" required></label></div><label>Break starts <span class="optional">optional - needed to confirm cover</span><input id="shift-break-start" type="time" value="${h(shift.break_start || '')}"></label><p class="field-help" id="shift-duration">Choose times or select a shift pattern.</p><label>Colour<select id="shift-colour">${['blue', 'teal', 'violet', 'amber'].map(c => `<option value="${c}" ${(shift.colour || 'blue') === c ? 'selected' : ''}>${c[0].toUpperCase() + c.slice(1)}</option>`).join('')}</select></label></div><label>Manager note <span class="optional">optional · hidden from colleagues</span><textarea id="shift-note" rows="2" maxlength="500">${h(shift.note || '')}</textarea></label>`;
}
function readShiftFields() {
  return { kind: $('shift-kind').value, label: $('shift-label').value, start_time: $('shift-start').value, end_time: $('shift-end').value, break_minutes: Number($('shift-break').value), break_start: $('shift-break-start').value || null, colour: $('shift-colour').value, note: $('shift-note').value, ...($('shift-department') ? { department: $('shift-department').value || ($('shift-person') ? '' : undefined), warehouse: $('shift-warehouse').value } : {}) };
}
function wireShiftFields() {
  function update() {
    const working = ['work', 'training'].includes($('shift-kind').value);
    $('working-fields').hidden = !working;
    $('shift-break-start').disabled = !working || Number($('shift-break').value) === 0;
    if (!working || Number($('shift-break').value) === 0) $('shift-break-start').value = '';
    if ($('shift-department')) $('shift-colour').closest('label').hidden = true;
    if ($('assignment-fields')) {
      $('assignment-fields').hidden = !working;
      $('shift-warehouse').required = working;
      $('shift-department').required = working && Boolean($('shift-person'));
    }
    $('shift-start').required = working; $('shift-end').required = working; $('shift-break').required = working;
    if (!working) return;
    const start = $('shift-start').value, end = $('shift-end').value;
    if (!start || !end) { $('shift-duration').textContent = 'Choose times or select a shift pattern.'; return; }
    const shift = readShiftFields();
    $('shift-duration').textContent = start === end ? 'Start and finish must be different.' : `${hours(minutes(shift))} scheduled hours${end < start ? ' · finishes the following day' : ''}.${shift.break_start && shift.break_minutes ? ` Break ${shift.break_start}–${clockLabel(clockMinutes(shift.break_start) + shift.break_minutes)}.` : shift.break_minutes ? ' Set a break start to confirm coverage.' : ''}`;
  }
  $('shift-kind').onchange = () => {
    const kind = $('shift-kind').value;
    if (['holiday', 'unavailable'].includes(kind)) $('shift-label').value = kindNames[kind];
    else if (['Holiday', 'Unavailable'].includes($('shift-label').value)) $('shift-label').value = 'Shift';
    update();
  };
  for (const id of ['shift-start', 'shift-end', 'shift-break', 'shift-break-start']) $(id).oninput = update;
  if ($('shift-pattern')) $('shift-pattern').onchange = event => {
    const template = S.data.templates.find(t => t.id === event.target.value);
    if (template) {
      $('shift-kind').value = template.kind; $('shift-label').value = template.name;
      $('shift-start').value = template.start_time; $('shift-end').value = template.end_time;
      $('shift-break').value = template.break_minutes; $('shift-break-start').value = template.break_start || ''; $('shift-colour').value = template.colour;
    }
    update();
  };
  update();
}
function openAssign({ personIds = [...S.selected], dates = [], shift = null } = {}) {
  if (readOnly) return;
  const single = Boolean(shift) || (personIds.length === 1 && dates.length === 1);
  let people = single ? S.data.people.filter(p => p.active || p.id === shift?.person_id) : peopleForLocation().filter(p => p.active);
  if (!people.length) { openTeam(); toast('Add colleagues before assigning shifts.'); return; }
  if (shift) { personIds = [shift.person_id]; dates = [shift.date]; }
  const body = single ? `<div class="field-row"><label>Colleague<select id="shift-person">${people.map(p => `<option value="${h(p.id)}" ${personIds.includes(p.id) ? 'selected' : ''}>${h(p.name)}</option>`).join('')}</select></label><label>Date<input type="date" id="shift-date" value="${dates[0]}" required min="2020-01-01" max="2100-12-31"></label></div>` : `<div class="assign-layout"><section><div class="section-label"><strong>Colleagues</strong><label class="check-label"><input id="bulk-all" type="checkbox">Select all</label></div><input id="bulk-search" type="search" placeholder="Find a colleague…" aria-label="Find colleagues to assign"><div class="people-checklist">${people.map(p => `<label class="person-check" data-name="${h(p.name.toLocaleLowerCase())}"><input type="checkbox" name="person_ids" value="${h(p.id)}" ${personIds.includes(p.id) ? 'checked' : ''}><span><strong>${h(p.name)}</strong><small>${h(departmentName(p))}</small></span></label>`).join('')}</div><p class="field-help" id="bulk-count"></p></section><section><strong class="section-label">Days this week</strong><div class="days-checklist">${days.map((d, i) => { const date = plusDays(S.week, i); return `<label class="check-label"><input type="checkbox" name="dates" value="${date}" ${dates.length ? dates.includes(date) ? 'checked' : '' : i < 5 ? 'checked' : ''}><span>${d}</span><small>${shortDate(date)}</small></label>`; }).join('')}</div></section></div>`;
  const department = shift?.department ?? (single ? defaultDepartment(people.find(p => p.id === personIds[0])) : '');
  const assignmentFields = `<div id="assignment-fields"><div class="field-row"><label>Department<select id="shift-department"><option value="">${single ? 'Choose department' : 'Use each colleague’s default'}</option>${choices(departments, department)}</select></label><label>Warehouse<select id="shift-warehouse"><option value="">Choose warehouse</option>${choices(warehouses, shift?.warehouse ?? S.warehouse)}</select></label></div><p class="field-help">${single ? 'The colleague’s default department is preselected. Change it for this shift if needed.' : 'Use each colleague’s default department, or choose one department for all selected colleagues.'} Choose the warehouse for these shifts.</p></div>`;
  modal(shift ? 'Edit shift' : single ? 'Add shift' : 'Assign shifts', `${body}<label>Shift pattern<select id="shift-pattern">${patternOptions()}</select></label>${!S.data.templates.length ? '<p class="field-help">Enter a manual shift here. Save your usual patterns under “Shift patterns”.</p>' : '<p class="field-help">Select a pattern, then adjust times if needed.</p>'}${assignmentFields}${fieldsHTML(shift || {})}`, `${shift ? '<button type="button" class="button danger" id="remove-shift">Remove shift</button><span class="footer-spacer"></span>' : ''}${cancel}<button class="button primary" type="submit">${shift ? 'Save changes' : 'Assign shifts'}</button>`, !single);
  wireShiftFields();
  if (single) $('shift-person').onchange = event => { $('shift-department').value = defaultDepartment(people.find(p => p.id === event.target.value)); };
  if (!single) {
    const updateCount = () => {
      const count = $('dialog-form').querySelectorAll('[name="person_ids"]:checked').length;
      const dates = $('dialog-form').querySelectorAll('[name="dates"]:checked').length;
      $('bulk-count').textContent = `${count} colleagues · ${dates} days · ${count * dates} assignments`;
      const visible = [...$('dialog-form').querySelectorAll('.person-check')].filter(l => !l.hidden).map(l => l.querySelector('input'));
      $('bulk-all').checked = visible.length > 0 && visible.every(c => c.checked);
    };
    $('bulk-all').onchange = event => { for (const label of $('dialog-form').querySelectorAll('.person-check')) if (!label.hidden) label.querySelector('input').checked = event.target.checked; updateCount(); };
    $('bulk-search').oninput = event => { for (const label of $('dialog-form').querySelectorAll('.person-check')) label.hidden = !label.dataset.name.includes(event.target.value.toLocaleLowerCase()); updateCount(); };
    $('dialog-form').onchange = updateCount; updateCount();
  }
  $('dialog-form').onsubmit = event => {
    event.preventDefault(); const form = event.currentTarget;
    formAction(form, async () => {
      let result;
      if (single) result = await mutate(shift ? `/api/shifts/${shift.id}` : '/api/shifts', { ...readShiftFields(), person_id: $('shift-person').value, date: $('shift-date').value, location_id: S.locationId }, shift ? 'PUT' : 'POST');
      else result = await mutate('/api/shifts/bulk', { ...readShiftFields(), person_ids: [...form.querySelectorAll('[name="person_ids"]:checked')].map(c => c.value), dates: [...form.querySelectorAll('[name="dates"]:checked')].map(c => c.value), location_id: S.locationId });
      closeDialog(); S.selected.clear(); render(); toast(single ? 'Shift saved. Publish the week when ready.' : `${result.created} shifts assigned. Publish the week when ready.`);
    });
  };
  if ($('remove-shift')) $('remove-shift').onclick = () => {
    if (confirm('Remove this shift from the draft rota?')) formAction($('dialog-form'), async () => { await mutate(`/api/shifts/${shift.id}`, {}, 'DELETE'); closeDialog(); toast('Shift removed from the draft rota.'); });
  };
}
function openTeam() {
  const people = S.data.people.filter(p => p.location_id === S.locationId);
  modal('Colleagues', `<div class="modal-toolbar"><input id="team-search" type="search" placeholder="Search colleagues…" aria-label="Search colleagues"><button type="button" class="button" id="import-colleagues">Import CSV</button><button type="button" class="button primary" id="add-colleague">${icon('plus')}Add colleague</button></div><p class="field-help">${people.filter(p => p.active).length} active colleagues at ${h(currentLocation().name)}. Open a profile to edit or delete a colleague. Archive people when they leave to retain draft history.</p><div class="management-list" id="team-list">${people.map(p => `<button type="button" class="management-row" data-edit-person="${h(p.id)}" data-name="${h(p.name.toLocaleLowerCase())}"><span><strong>${h(p.name)}</strong><small>${h(departmentName(p))}${p.role ? ` · ${h(p.role)}` : ''}</small></span><span class="row-meta">${p.contract_minutes ? `${hours(p.contract_minutes)}h / week` : 'Hours not set'}${!p.active ? '<em>Archived</em>' : ''}<span class="edit-label">Edit</span></span></button>`).join('') || '<div class="empty-list">Add colleagues individually or import your list.</div>'}</div>`, '<button type="button" class="button" data-action="close-modal">Done</button>', true);
  $('team-search').oninput = event => { for (const row of $('team-list').querySelectorAll('[data-name]')) row.hidden = !row.dataset.name.includes(event.target.value.toLocaleLowerCase()); };
  $('add-colleague').onclick = () => editPerson();
  $('import-colleagues').onclick = openImport;
  $('team-list').onclick = event => { const row = event.target.closest('[data-edit-person]'); if (row) openProfile(row.dataset.editPerson); };
}
function openProfile(id) {
  const p = S.data.people.find(p => p.id === id); if (!p) return;
  const shifts = S.data.shifts.filter(s => s.person_id === id);
  modal(p.name, `<div class="profile-summary"><span class="department-tag ${departmentColour[defaultDepartment(p)] || 'blue'}">${h(departmentName(p))}</span>${p.is_example ? '<span class="example-tag">Example colleague</span>' : ''}<p>${h(p.role || 'Warehouse colleague')} · ${hours(personHours(id))}h scheduled this week</p></div><h3>Dashboard performance</h3><div id="profile-performance" aria-live="polite"><p class="field-help">Reading the dashboard…</p></div><h3>This week’s shifts</h3><div class="profile-shifts">${shifts.map(s => `<div><strong>${shortDate(s.date, { weekday: 'short' })}</strong>${shiftCard(s)}</div>`).join('') || '<p class="field-help">No shifts assigned this week.</p>'}</div>`, '<button type="button" class="button danger" id="delete-profile">Delete colleague</button><span class="footer-spacer"></span><button type="button" class="button" data-action="close-modal">Done</button><button type="button" class="button primary" id="edit-profile">Edit colleague</button>', true);
  $('modal').dataset.profileId = id; $('edit-profile').onclick = () => editPerson(id); $('delete-profile').onclick = () => deletePerson(id);
  api(`/api/people/${encodeURIComponent(id)}/performance`).then(data => {
    if (!$('profile-performance') || $('modal').dataset.profileId !== id) return;
    if (!data.configured) { $('profile-performance').innerHTML = '<p class="field-help">Connect your existing warehouse dashboard to show Picking and Packing totals, average per hour and peak hour.</p><button type="button" class="button" id="connect-from-profile">Connect dashboard</button>'; $('connect-from-profile').onclick = openDashboardSettings; return; }
    const metric = value => value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('en-GB', { maximumFractionDigits: 1 });
    $('profile-performance').innerHTML = `<p class="field-help">${data.mode === 'demo' ? 'Example dashboard data · ' : ''}${h(data.date || 'Today')} · Matched to ${h(data.matchedName)}${data.updatedAt ? ` · Updated ${h(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(new Date(data.updatedAt)))}` : ''}</p>${data.stale ? '<p class="coverage-alert">The dashboard is unavailable. Showing the last retrieved data.</p>' : ''}${data.limited ? '<p class="coverage-alert">The dashboard needs the supplied update to include colleagues outside the top eight.</p>' : ''}${data.ambiguous ? '<p class="coverage-alert">More than one dashboard entry has this name. Check the colleague’s dashboard name.</p>' : ''}<div class="performance-grid">${['picking', 'packing'].map(kind => { const row = data[kind]; return `<section><h4 class="department-text ${kind === 'picking' ? 'blue' : 'teal'}">${kind === 'picking' ? 'Picking' : 'Packing'}</h4>${row ? `<strong>${metric(row.total)}<small>completed</small></strong><dl><div><dt>Daily rank</dt><dd>${metric(row.rank)}</dd></div><div><dt>Average / hour</dt><dd>${metric(row.avgPerHour)}</dd></div><div><dt>Peak hour</dt><dd>${metric(row.peakTotal)}${row.peakHour ? ` at ${h(row.peakHour)}` : ''}</dd></div></dl>` : '<p>No matching activity supplied by the dashboard.</p>'}</section>`; }).join('')}</div><p class="field-help">The current dashboard supplies Picking and Packing performance. Engraving performance is not available from it. Dashboard readings are shared across profiles and refresh at most once every five minutes.</p>`;
  }).catch(error => { if ($('profile-performance') && $('modal').dataset.profileId === id) $('profile-performance').innerHTML = `<p class="form-error">${h(error.message)}</p>`; });
}
function openDashboardSettings() {
  const current = S.data.dashboard || {};
  modal('Connect warehouse dashboard', `<p>Use the Render address of your existing Dylan Oaks dashboard. Colleague profiles read its Picking and Packing leaderboard.</p><label>Dashboard URL<input id="dashboard-url" type="url" value="${h(current.url || '')}" placeholder="https://your-dashboard.onrender.com" maxlength="200"></label><label>Integration key <span class="optional">${current.hasKey ? 'already saved - leave blank to keep it' : 'matches ROTA_API_KEY on the dashboard'}</span><input id="dashboard-key" type="password" autocomplete="new-password" maxlength="256"></label><p class="field-help">The package includes the dashboard update for all colleagues. Add the same integration key to that dashboard’s Render environment as ROTA_API_KEY. The key stays in the manager system. Each colleague’s name must match, or set their Dashboard leaderboard name in their profile.</p>`, `${cancel}<button class="button primary" type="submit">Save connection</button>`);
  $('dialog-form').onsubmit = event => { event.preventDefault(); formAction(event.currentTarget, async () => { const key = $('dashboard-key').value; await mutate('/api/dashboard/settings', { url: $('dashboard-url').value, ...(key ? { api_key: key } : {}) }); closeDialog(); toast('Dashboard connection saved. Open a colleague profile to view performance.'); }); };
}
function openPDF() {
  const published = readOnly ? !S.data.unpublished : Boolean(publication());
  if (!published) { modal('Share rota as PDF', '<p>Publish this week first. Shareable PDFs contain the published rota, so draft shifts stay private.</p>', '<button type="button" class="button" data-action="close-modal">Done</button>'); return; }
  modal('Share published rota as PDF', `<p>${shortDate(S.week)} – ${shortDate(plusDays(S.week, 6))}. PDFs contain the published version${!readOnly && publication()?.dirty ? '; your draft changes are still private' : ''}.</p><label>PDF layout<select id="pdf-layout"><option value="warehouse">By warehouse</option><option value="department">By department</option><option value="az">Full rota - A-Z</option><option value="overview">A-Z weekly overview</option></select></label><div class="field-row"><label>Warehouse<select id="pdf-warehouse"><option value="">Both warehouses</option>${choices(warehouses, '')}</select></label><label>Department<select id="pdf-department"><option value="">All departments</option>${choices(departments, '')}</select></label></div><p class="field-help">Warehouse and department layouts start a separate section for each group. A-Z sorts colleagues by name. The overview uses compact weekly rows. Shift times, department, warehouse and breaks are included.</p>`, '<button type="button" class="button" data-action="close-modal">Done</button><a class="button primary" id="pdf-download" download>Download PDF</a>');
  const update = () => { const params = new URLSearchParams({ week: S.week, layout: $('pdf-layout').value, warehouse: $('pdf-warehouse').value, department: $('pdf-department').value }); if (!readOnly) params.set('locationId', S.locationId); $('pdf-download').href = `${readOnly ? `/api/public/${shareToken}/pdf` : '/api/export.pdf'}?${params}`; };
  for (const id of ['pdf-layout', 'pdf-warehouse', 'pdf-department']) $(id).onchange = update; update();
}
function deletePerson(id) {
  const p = S.data.people.find(p => p.id === id); if (!p || readOnly) return;
  modal('Delete colleague?', `<p>Delete <strong>${h(p.name)}</strong>?</p><p>The colleague and all their saved draft shifts across every week will be removed.</p><p class="field-help">Published rota copies stay unchanged. Republish affected weeks when you want colleagues to see the change. You can archive the colleague instead by clearing Active colleague in their edit form.</p>`, '<button type="button" class="button" id="cancel-delete-person">Cancel</button><button type="submit" class="button danger">Delete colleague</button>');
  $('cancel-delete-person').onclick = () => openProfile(id);
  $('dialog-form').onsubmit = event => {
    event.preventDefault();
    formAction(event.currentTarget, async () => {
      await mutate(`/api/people/${encodeURIComponent(id)}`, { confirm: true }, 'DELETE');
      openTeam(); toast('Colleague deleted.');
    });
  };
}
function editPerson(id) {
  const p = S.data.people.find(p => p.id === id) || { name: '', team: 'Warehouse', role: '', contract_minutes: 0, location_id: S.locationId, active: 1 };
  modal(id ? 'Edit colleague' : 'Add colleague', `<label>Name<input id="person-name" value="${h(p.name)}" maxlength="120" required autocomplete="off"></label><div class="field-row"><label>Department <span class="optional">optional</span><select id="person-department"><option value="">Not set</option>${choices(departments, defaultDepartment(p))}</select></label><label>Role <span class="optional">optional</span><input id="person-role" value="${h(p.role)}" maxlength="80"></label></div><label>Dashboard leaderboard name <span class="optional">optional - uses the colleague name if blank</span><input id="person-leaderboard-name" maxlength="120" value="${h(p.leaderboard_name || '')}" autocomplete="off"></label><div class="field-row"><label>Contracted hours / week<input id="person-hours" type="number" value="${p.contract_minutes / 60}" min="0" max="100" step="0.25" required></label><label>Home location<select id="person-location">${S.data.locations.map(l => `<option value="${h(l.id)}" ${l.id === p.location_id ? 'selected' : ''}>${h(l.name)}</option>`).join('')}</select></label></div><p class="field-help">This department is preselected for new shifts and can be changed per shift. Saved shifts keep their assigned department. Set hours to 0 for colleagues without fixed contracted hours.</p>${id ? `<label class="check-label"><input id="person-active" type="checkbox" ${p.active ? 'checked' : ''}>Active colleague</label>` : ''}`, `${id ? '<button type="button" class="button danger" id="delete-colleague">Delete colleague</button><span class="footer-spacer"></span>' : ''}<button type="button" class="button" id="back-team">Back</button><button class="button primary" type="submit">Save colleague</button>`);
  $('back-team').onclick = openTeam;
  if (id) $('delete-colleague').onclick = () => deletePerson(id);
  $('dialog-form').onsubmit = event => {
    event.preventDefault(); formAction(event.currentTarget, async () => {
      await mutate(id ? `/api/people/${id}` : '/api/people', { name: $('person-name').value, default_department: $('person-department').value, role: $('person-role').value, leaderboard_name: $('person-leaderboard-name').value, is_example: false, contract_hours: Number($('person-hours').value), location_id: $('person-location').value, active: $('person-active') ? $('person-active').checked : true }, id ? 'PUT' : 'POST');
      openTeam(); toast('Colleague saved.');
    });
  };
}
function parseCSV(text) {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/)[0];
  const delimiter = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === delimiter && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(c => c.trim())) rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (quoted) throw new Error('A quoted value in the CSV is unfinished.');
  row.push(cell); if (row.some(c => c.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('The file needs a Name column and at least one colleague.');
  const headings = rows.shift().map(c => c.trim().toLocaleLowerCase().replace(/[\s_-]+/g, ''));
  const name = headings.indexOf('name'), role = headings.indexOf('role');
  const department = headings.includes('defaultdepartment') ? headings.indexOf('defaultdepartment') : headings.includes('department') ? headings.indexOf('department') : headings.indexOf('team');
  const hours = headings.findIndex(c => ['contracthours', 'contractedhours'].includes(c));
  if (name < 0) throw new Error('Include a column headed Name. Optional columns: Default department, Role, Contract hours.');
  if (rows.length > 1000) throw new Error('Import at most 1,000 colleagues at once.');
  return rows.map((row, index) => {
    const p = { name: (row[name] || '').trim(), default_department: (row[department] || '').trim(), role: (row[role] || '').trim(), contract_hours: hours >= 0 ? Number(row[hours] || 0) : 0 };
    if (!p.name || p.name.length > 120 || (p.default_department && !departments.includes(p.default_department)) || p.role.length > 80 || !Number.isFinite(p.contract_hours) || p.contract_hours < 0 || p.contract_hours > 100) throw new Error(`Check the name, default department, role or hours on row ${index + 2}.`);
    return p;
  });
}
function downloadText(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function openImport() {
  let people = [];
  modal('Import colleagues', `<p>Upload a CSV with a <strong>Name</strong> column. You can also include <strong>Default department</strong>, <strong>Role</strong> and <strong>Contract hours</strong>.</p><button type="button" class="button" id="csv-template">Download blank template</button><label class="file-drop">Colleague CSV<input type="file" id="csv-file" accept=".csv,text/csv"></label><p class="field-help">Default department can be Picking, Engraving or Packing, or left blank. Colleagues with the same name at this location are skipped. Existing records stay as they are.</p><div id="import-preview"></div>`, '<button type="button" class="button" id="back-team">Back</button><button type="submit" class="button primary" id="import-submit" disabled>Import colleagues</button>');
  $('back-team').onclick = openTeam;
  $('csv-template').onclick = () => downloadText('colleagues-template.csv', 'Name,Default department,Role,Contract hours\r\n');
  $('csv-file').onchange = async event => {
    people = []; $('import-submit').disabled = true; $('form-error').textContent = ''; $('import-preview').textContent = '';
    try {
      const file = event.target.files[0]; if (!file) return;
      if (file.size > 2000000) throw new Error('Use a CSV smaller than 2 MB.');
      people = parseCSV(await file.text());
      $('import-preview').innerHTML = `<div class="import-summary"><strong>${people.length} colleagues ready to import</strong><p>${people.slice(0, 5).map(p => h(p.name)).join(', ')}${people.length > 5 ? '…' : ''}</p></div>`;
      $('import-submit').disabled = false;
    } catch (error) { $('form-error').textContent = error.message; }
  };
  $('dialog-form').onsubmit = event => { event.preventDefault(); formAction(event.currentTarget, async () => {
    const result = await mutate('/api/people/import', { people, location_id: S.locationId }); openTeam(); toast(`${result.imported} colleagues imported${result.skipped ? ` · ${result.skipped} duplicates skipped` : ''}.`);
  }); };
}
function openPatterns() {
  modal('Standard shift patterns', `<p>Create your usual shifts here. Select a pattern when assigning shifts, or enter a manual shift.</p><div class="management-list">${S.data.templates.map(t => `<button type="button" class="management-row" data-edit-pattern="${h(t.id)}"><span><strong>${h(t.name)}</strong><small>${h(kindNames[t.kind])} · ${t.break_minutes}m unpaid break</small></span><span class="row-meta"><strong>${h(t.start_time)}–${h(t.end_time)}${t.end_time < t.start_time ? ' +1' : ''}</strong><span class="edit-label">Edit</span></span></button>`).join('') || '<div class="empty-list">No patterns yet. Add your first standard shift.</div>'}</div><p class="field-help">Updating a pattern changes future assignments. Existing shifts keep their saved times.</p>`, '<button type="button" class="button" data-action="close-modal">Done</button><button type="button" class="button primary" id="add-pattern">Add shift pattern</button>');
  $('add-pattern').onclick = () => editPattern();
  $('dialog-form').onclick = event => { const button = event.target.closest('[data-edit-pattern]'); if (button) editPattern(button.dataset.editPattern); };
}
function editPattern(id) {
  const t = S.data.templates.find(t => t.id === id) || {};
  modal(id ? 'Edit shift pattern' : 'Add shift pattern', fieldsHTML({ ...t, label: t.name || '' }), `${id ? '<button type="button" class="button danger" id="delete-pattern">Delete pattern</button><span class="footer-spacer"></span>' : ''}<button type="button" class="button" id="back-patterns">Back</button><button type="submit" class="button primary">Save pattern</button>`);
  $('shift-label').value = t.name || '';
  $('shift-label').placeholder = 'e.g. Early shift';
  $('shift-kind').innerHTML = `<option value="work" ${t.kind !== 'training' ? 'selected' : ''}>Work</option><option value="training" ${t.kind === 'training' ? 'selected' : ''}>Training</option>`;
  $('shift-note').closest('label').hidden = true;
  wireShiftFields(); $('back-patterns').onclick = openPatterns;
  $('dialog-form').onsubmit = event => { event.preventDefault(); formAction(event.currentTarget, async () => {
    const fields = readShiftFields(); await mutate(id ? `/api/templates/${id}` : '/api/templates', { ...fields, name: fields.label }, id ? 'PUT' : 'POST'); openPatterns(); toast('Shift pattern saved.');
  }); };
  if ($('delete-pattern')) $('delete-pattern').onclick = () => { if (confirm('Delete this shift pattern? Existing shifts will keep their times.')) formAction($('dialog-form'), async () => { await mutate(`/api/templates/${id}`, {}, 'DELETE'); openPatterns(); toast('Shift pattern deleted.'); }); };
}
function openPublish() {
  const loc = currentLocation(), pub = publication(), shifts = allLocationShifts();
  modal('Publish this week', `<div class="publish-summary"><span class="eyebrow">${h(loc.name)}</span><h3>${shortDate(S.week)} – ${shortDate(plusDays(S.week, 6))}</h3><p><strong>${peopleForLocation().length}</strong> colleagues · <strong>${shifts.length}</strong> assignments · <strong>${hours(shifts.reduce((sum, s) => sum + minutes(s), 0))}h</strong> scheduled</p></div><p>${pub ? 'The updated rota will replace the published version for this week.' : 'The rota will be available to colleagues through the shared link and QR code.'}</p><p class="field-help">This publishes the full week for both warehouses, including any shifts hidden by your filters. Later edits will remain in draft until you publish again. Manager notes and contracted hours are kept in the manager view.</p>`, `${pub ? '<button type="button" class="button danger" id="unpublish-week">Unpublish week</button><span class="footer-spacer"></span>' : ''}${cancel}<button type="submit" class="button primary">Publish rota</button>`);
  $('dialog-form').onsubmit = event => { event.preventDefault(); formAction(event.currentTarget, async () => { await mutate('/api/publish', { location_id: S.locationId, week: S.week }); closeDialog(); toast('Rota published. The shared QR code is up to date.'); }); };
  if ($('unpublish-week')) $('unpublish-week').onclick = () => { if (confirm('Unpublish this week? Colleagues will no longer see it, and the draft will stay saved.')) formAction($('dialog-form'), async () => { await mutate('/api/publish', { location_id: S.locationId, week: S.week }, 'DELETE'); closeDialog(); toast('Week unpublished. The draft is private.'); }); };
}
function openCopy() {
  modal('Copy last week', `<p>Copy shifts from <strong>${shortDate(plusDays(S.week, -7))} – ${shortDate(plusDays(S.week, -1))}</strong> into <strong>${shortDate(S.week)} – ${shortDate(plusDays(S.week, 6))}</strong> for ${h(currentLocation().name)}.</p><p class="field-help">Overlapping shifts and archived colleagues are skipped. Review the copied rota before publishing.</p>`, `${cancel}<button type="submit" class="button primary">Copy shifts</button>`);
  $('dialog-form').onsubmit = event => { event.preventDefault(); formAction(event.currentTarget, async () => { const r = await mutate('/api/weeks/copy', { location_id: S.locationId, week: S.week }); closeDialog(); toast(`${r.copied} shifts copied${r.skipped ? ` · ${r.skipped} skipped` : ''}.`); }); };
}
function openShare() {
  const loc = currentLocation(), url = `${location.origin}/rota/${loc.share_token}`;
  modal('Share the warehouse rota', `<section class="share-content"><div class="qr-heading"><span class="eyebrow">DYLAN OAKS</span><h3>${h(loc.name)} rota</h3><p>Scan to view the published rota.</p></div><img class="qr-image" src="/api/qr.svg?locationId=${encodeURIComponent(loc.id)}&v=${encodeURIComponent(loc.share_token)}" alt="QR code for the published ${h(loc.name)} rota" width="280" height="280"><div class="share-link"><input id="share-url" value="${h(url)}" readonly aria-label="Published rota link"><button type="button" class="button" id="copy-link">Copy link</button></div><p class="field-help">One QR code covers Warehouse 1 and Warehouse 2. Use this same QR code every week. Anyone with the code or link can view the full published rota. Draft shifts and manager notes are hidden.</p><div class="share-buttons"><button type="button" class="button" data-action="pdf">Download PDF</button><a class="button" href="${h(url)}" target="_blank" rel="noopener">Open colleague view</a><a class="button" href="/api/qr.svg?locationId=${encodeURIComponent(loc.id)}" download="${h(loc.name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-'))}-rota-qr.svg">Download QR</a><button type="button" class="button" id="print-qr">Print QR</button></div><div class="share-advanced"><button type="button" class="text-button danger-text" id="reset-link">Reset shared link and QR code</button></div></section>`, '<button type="button" class="button" data-action="close-modal">Done</button>');
  $('copy-link').onclick = async () => {
    try { await navigator.clipboard.writeText(url); toast('Rota link copied.'); }
    catch { $('share-url').select(); toast('Select and copy the rota link.'); }
  };
  $('print-qr').onclick = () => window.print();
  $('reset-link').onclick = () => { if (confirm('Reset the shared link? The existing QR code will stop working. You will need to print and share the new code.')) formAction($('dialog-form'), async () => { await mutate('/api/share/reset', { location_id: S.locationId }); openShare(); toast('New link created. Download and print the updated QR code.'); }); };
}
function openSettings() {
  modal('Settings', `<div class="management-list"><button type="button" class="management-row" id="dashboard-settings"><span><strong>Dashboard connection</strong><small>Picking and Packing performance in colleague profiles.</small></span><span class="edit-label">Connect</span></button><button type="button" class="management-row" id="manage-locations"><span><strong>Locations</strong><small>Add other sites for separate rotas.</small></span><span class="edit-label">Manage</span></button><a class="management-row" href="/api/backup"><span><strong>Download data backup</strong><small>Save a complete copy of colleagues, shifts and published rotas.</small></span>${icon('download')}</a></div><p class="field-help">Seven daily backups are also retained on the server. Scheduled hours use the entered start and finish times, less unpaid breaks.</p>`, '<button type="button" class="button" data-action="close-modal">Done</button>');
  $('manage-locations').onclick = openLocations; $('dashboard-settings').onclick = openDashboardSettings;
}
function openLocations() {
  modal('Locations', `<div class="management-list">${S.data.locations.map(l => `<button type="button" class="management-row" data-edit-location="${h(l.id)}"><span><strong>${h(l.name)}</strong><small>${l.active ? 'Active' : 'Archived'} · separate rota and QR link</small></span><span class="edit-label">Edit</span></button>`).join('')}</div>`, '<button type="button" class="button" id="back-settings">Back</button><button type="button" class="button primary" id="add-location">Add location</button>');
  $('back-settings').onclick = openSettings; $('add-location').onclick = () => editLocation();
  $('dialog-form').onclick = event => { const row = event.target.closest('[data-edit-location]'); if (row) editLocation(row.dataset.editLocation); };
}
function editLocation(id) {
  const loc = S.data.locations.find(l => l.id === id);
  modal(id ? 'Edit location' : 'Add location', `<label>Location name<input id="location-name" value="${h(loc?.name || '')}" maxlength="80" required></label>${id ? `<label class="check-label"><input id="location-active" type="checkbox" ${loc.active ? 'checked' : ''}>Active location</label><p class="field-help">Archiving retains existing shifts and published weeks.</p>` : ''}`, '<button type="button" class="button" id="back-locations">Back</button><button type="submit" class="button primary">Save location</button>');
  $('back-locations').onclick = openLocations;
  $('dialog-form').onsubmit = event => { event.preventDefault(); formAction(event.currentTarget, async () => { await mutate(id ? `/api/locations/${id}` : '/api/locations', { name: $('location-name').value, active: $('location-active') ? $('location-active').checked : true }, id ? 'PUT' : 'POST'); openLocations(); toast('Location saved.'); }); };
}
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (S.loading && !['retry', 'close-modal', 'previous', 'next', 'today'].includes(action)) return;
  try {
    if (action === 'retry') return load();
    if (action === 'close-modal') return closeDialog();
    if (action === 'previous') return changeWeek(plusDays(S.week, -7));
    if (action === 'next') return changeWeek(plusDays(S.week, 7));
    if (action === 'today') return changeWeek(monday(londonToday()));
    if (action === 'day') { S.day = Number(button.dataset.day); render(); return; }
    if (action === 'coverage-full' && !readOnly) { S.coverageFull = !S.coverageFull; render(); return; }
    if (action === 'view-day' || action === 'view-week' || (!readOnly && action === 'view-timeline')) { S.view = action.slice(5); store('rota-view', S.view); render(); return; }
    if (action === 'print') return window.print();
    if (action === 'pdf') return openPDF();
    if (readOnly) return;
    if (action === 'profile') return openProfile(button.dataset.person);
    if (action === 'team') return openTeam();
    if (action === 'patterns') return openPatterns();
    if (action === 'settings') return openSettings();
    if (action === 'assign') return openAssign();
    if (action === 'add-cell') return openAssign({ personIds: [button.dataset.person], dates: [button.dataset.date] });
    if (action === 'edit-shift') return openAssign({ shift: [...S.data.shifts, ...(S.data.previousShifts || [])].find(s => s.id === button.dataset.id) });
    if (action === 'publish') return openPublish();
    if (action === 'copy') return openCopy();
    if (action === 'share') return openShare();
    if (action === 'clear-selection') { S.selected.clear(); render(); return; }
    if (action === 'logout') { await api('/api/logout', { method: 'POST', body: '{}' }); S.authenticated = false; S.data = null; closeDialog(); renderLogin(); }
  } catch (error) { toast(error.message, true); }
});
document.addEventListener('change', event => {
  if (event.target.matches('[data-select-person]')) {
    if (event.target.checked) S.selected.add(event.target.dataset.selectPerson); else S.selected.delete(event.target.dataset.selectPerson);
    const scroll = document.querySelector('.rota-scroll'), top = scroll?.scrollTop || 0, left = scroll?.scrollLeft || 0;
    render(); const next = document.querySelector('.rota-scroll'); if (next) { next.scrollTop = top; next.scrollLeft = left; }
  }
  if (event.target.id === 'select-all') {
    for (const p of visiblePeople().filter(p => p.active)) { if (event.target.checked) S.selected.add(p.id); else S.selected.delete(p.id); }
    render();
  }
});
const requestedWeek = new URLSearchParams(location.search).get('week');
if (requestedWeek && /^\d{4}-\d{2}-\d{2}$/.test(requestedWeek) && Number.isFinite(Date.parse(requestedWeek))) S.week = monday(requestedWeek);
load();
setInterval(() => { if (S.data && !$('modal').open && document.visibilityState === 'visible') load(true); }, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.data && !$('modal').open) load(true); });

// Feature-detected browser tools use the same displayed state and editor as the UI.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const register = tool => { try { Promise.resolve(document.modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch {} };
  register({
    name: 'read_displayed_rota', title: 'Read displayed rota', description: 'Read the current location, week and filtered colleagues with their scheduled shifts. Does not edit or publish the rota.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute(input) {
      if (!input || typeof input !== 'object' || Object.keys(input).length) throw new Error('Use an empty input object.');
      if (!S.data) throw new Error('Open the rota first.');
      const ids = new Set(visiblePeople().map(p => p.id));
      return { week: S.week, location: currentLocation().name, colleagues: visiblePeople().map(p => ({ id: p.id, name: p.name, default_department: defaultDepartment(p) })), shifts: locationShifts().filter(s => ids.has(s.person_id)).map(({ note, ...s }) => s), readOnly };
    }
  });
  if (!readOnly) register({
    name: 'start_shift_assignment', title: 'Open shift assignment', description: 'Open the manager shift editor with chosen colleagues and dates in the displayed week. The manager must save the form to assign shifts.',
    inputSchema: { type: 'object', properties: { personIds: { type: 'array', items: { type: 'string' }, minItems: 1 }, dates: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['personIds', 'dates'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      if (!S.authenticated || !S.data) throw new Error('Sign in as a manager first.');
      const allowed = new Set(peopleForLocation().filter(p => p.active).map(p => p.id));
      if (!input || Object.keys(input).some(k => !['personIds', 'dates'].includes(k)) || !Array.isArray(input.personIds) || !input.personIds.length || !input.personIds.every(id => allowed.has(id)) || !Array.isArray(input.dates) || !input.dates.length || !input.dates.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= S.week && d <= plusDays(S.week, 6))) throw new Error('Choose active colleagues and valid dates in the displayed week.');
      openAssign({ personIds: [...new Set(input.personIds)], dates: [...new Set(input.dates)] }); return { status: 'editor_open', saved: false };
    }
  });
  addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
