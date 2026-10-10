import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { rotaPDF } from './lib/pdf.mjs';
import { createDashboardReader } from './lib/dashboard.mjs';
import { normalizeAvailability, availabilityWarning, isShiftAvailable } from './public/availability.js';
import { arrivalDetails } from './public/manager-tools.js';
import { holidayBalance } from './lib/holiday.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const uuid = () => randomUUID();
const KINDS = ['work', 'training', 'holiday', 'sick', 'unavailable'];
const COLOURS = ['blue', 'teal', 'violet', 'amber'];
const DEPARTMENTS = ['Picking', 'Engraving', 'Packing'];
const WAREHOUSES = ['Warehouse 1', 'Warehouse 2'];
const SESSION_MS = 12 * 60 * 60 * 1000;

export function today() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function monday(date = today()) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}
class Problem extends Error {
  constructor(status, message, details = {}) { super(message); this.status = status; this.details = details; }
}
function requireThat(condition, message, status = 400) {
  if (!condition) throw new Problem(status, message);
}
function textValue(value, label, max = 100, optional = false) {
  requireThat(typeof value === 'string', `${label} is required.`);
  const trimmed = value.trim();
  requireThat((optional || trimmed.length > 0) && trimmed.length <= max, `${label} must be ${optional ? 'at most' : 'between 1 and'} ${max} characters.`);
  requireThat(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed), `${label} contains an unsupported character.`);
  return trimmed;
}
function dateValue(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Choose a valid date.');
  const parsed = new Date(`${value}T12:00:00Z`);
  requireThat(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= '2020-01-01' && value <= '2100-12-31', 'Choose a valid date between 2020 and 2100.');
  return value;
}
function weekValue(value) { return monday(dateValue(value)); }
function timeMinutes(value) {
  requireThat(typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value), 'Enter a valid start and finish time.');
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function integer(value, min, max, label) {
  requireThat(Number.isInteger(value) && value >= min && value <= max, `${label} must be a whole number from ${min} to ${max}.`);
  return value;
}
export function scheduledMinutes(shift) {
  if (!['work', 'training'].includes(shift.kind)) return 0;
  let duration = timeMinutes(shift.end_time) - timeMinutes(shift.start_time);
  if (duration < 0) duration += 1440;
  return duration - shift.break_minutes;
}
function interval(shift) {
  const startOfDay = Date.parse(`${shift.date}T00:00:00Z`) / 60000;
  if (!['work', 'training'].includes(shift.kind)) return [startOfDay, startOfDay + 1440];
  const start = startOfDay + timeMinutes(shift.start_time);
  let end = startOfDay + timeMinutes(shift.end_time);
  if (end < start) end += 1440;
  return [start, end];
}
function overlaps(a, b) {
  if (a.person_id !== b.person_id) return false;
  const [aStart, aEnd] = interval(a), [bStart, bEnd] = interval(b);
  return aStart < bEnd && bStart < aEnd;
}
function shiftFields(body) {
  const kind = body.kind || 'work';
  requireThat(KINDS.includes(kind), 'Choose a valid shift type.');
  const working = ['work', 'training'].includes(kind);
  const start_time = working ? body.start_time : null;
  const end_time = working ? body.end_time : null;
  const break_minutes = working ? integer(Number(body.break_minutes ?? 0), 0, 240, 'Break length') : 0;
  const break_start = working && break_minutes > 0 && body.break_start ? body.break_start : null;
  if (working) {
    const start = timeMinutes(start_time), end = timeMinutes(end_time);
    requireThat(start !== end, 'Start and finish must be different. Overnight shifts finish the following day.');
    const duration = (end - start + 1440) % 1440;
    requireThat(break_minutes < duration, 'The break must be shorter than the shift.');
    if (break_start) {
      const offset = (timeMinutes(break_start) - start + 1440) % 1440;
      requireThat(offset + break_minutes <= duration, 'The timed break must fit completely inside the shift.');
    }
  }
  return {
    kind, start_time, end_time, break_minutes, break_start,
    label: textValue(body.label || ({ holiday: 'Holiday', sick: 'Sick', unavailable: 'Unavailable' })[kind] || 'Shift', 'Shift name', 60),
    colour: COLOURS.includes(body.colour) ? body.colour : 'blue',
    note: textValue(body.note || '', 'Manager note', 500, true)
  };
}
function csvCell(value) {
  let result = String(value ?? '');
  if (/^[=+@\-\t\r]/.test(result)) result = `'${result}`;
  return `"${result.replaceAll('"', '""')}"`;
}

export function createRotaServer(options = {}) {
  const password = options.password ?? process.env.ADMIN_PASSWORD;
  requireThat(typeof password === 'string' && password.length >= 12, 'Set ADMIN_PASSWORD to a password containing at least 12 characters.', 500);
  if (process.env.RENDER === 'true') requireThat(process.env.DATA_DIR && path.isAbsolute(process.env.DATA_DIR), 'Set DATA_DIR to the mount path of your Render persistent disk.', 500);
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? path.join(ROOT, 'data'));
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, 'rota.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO meta VALUES ('revision', '0');
    INSERT OR IGNORE INTO meta VALUES ('schema_version', '1');
    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, share_token TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
      contract_minutes INTEGER NOT NULL DEFAULT 0, location_id TEXT NOT NULL REFERENCES locations(id),
      active INTEGER NOT NULL DEFAULT 1, row_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
      break_minutes INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'work', colour TEXT NOT NULL DEFAULT 'blue'
    );
    CREATE TABLE IF NOT EXISTS shifts (
      id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), location_id TEXT NOT NULL REFERENCES locations(id),
      date TEXT NOT NULL, start_time TEXT, end_time TEXT, break_minutes INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL, label TEXT NOT NULL, colour TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_shifts_date_location ON shifts(date, location_id);
    CREATE INDEX IF NOT EXISTS idx_shifts_person_date ON shifts(person_id, date);
    CREATE TABLE IF NOT EXISTS publications (
      location_id TEXT NOT NULL REFERENCES locations(id), week TEXT NOT NULL,
      snapshot TEXT NOT NULL, published_at TEXT NOT NULL, PRIMARY KEY (location_id, week)
    );
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, password_fingerprint TEXT NOT NULL);
  `);
  const schemaVersion = Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value);
  requireThat(schemaVersion <= 6, 'This database needs a newer version of the rota app.', 500);
  if (schemaVersion < 2) {
    // Keep the original assignments and QR tokens. Old warehouse assignments
    // stay unset until a manager chooses them; never guess where someone works.
    if (db.prepare('SELECT COUNT(*) AS n FROM people').get().n > 0) {
      const backupDir = path.join(dataDir, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const destination = path.join(backupDir, 'rota-before-schema-2.sqlite');
      if (!fs.existsSync(destination)) db.prepare('VACUUM INTO ?').run(destination);
    }
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE people ADD COLUMN default_department TEXT NOT NULL DEFAULT '';
      ALTER TABLE shifts ADD COLUMN department TEXT NOT NULL DEFAULT '';
      ALTER TABLE shifts ADD COLUMN warehouse TEXT NOT NULL DEFAULT '';
      UPDATE people SET default_department = team WHERE team IN ('Picking', 'Engraving', 'Packing');
      UPDATE shifts SET department = COALESCE((SELECT default_department FROM people WHERE people.id = shifts.person_id), '');
      UPDATE meta SET value = '2' WHERE key = 'schema_version';
      UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision';
      COMMIT;`);
  }
  if (schemaVersion < 3) {
    if (db.prepare('SELECT COUNT(*) AS n FROM people').get().n > 0) {
      const dir = path.join(dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true });
      const destination = path.join(dir, 'rota-before-schema-3.sqlite');
      if (!fs.existsSync(destination)) db.prepare('VACUUM INTO ?').run(destination);
    }
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE shifts ADD COLUMN break_start TEXT;
      ALTER TABLE templates ADD COLUMN break_start TEXT;
      ALTER TABLE people ADD COLUMN leaderboard_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE people ADD COLUMN is_example INTEGER NOT NULL DEFAULT 0;
      UPDATE meta SET value = '3' WHERE key = 'schema_version';
      UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision';
      COMMIT;`);
  }
  if (schemaVersion < 4) {
    if (db.prepare('SELECT COUNT(*) AS n FROM people').get().n > 0) {
      const dir = path.join(dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true });
      const destination = path.join(dir, 'rota-before-schema-4.sqlite');
      if (!fs.existsSync(destination)) db.prepare('VACUUM INTO ?').run(destination);
    }
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE attendance (
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id), date TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('checked_in', 'no_show')), marked_at TEXT NOT NULL,
        PRIMARY KEY (person_id, location_id, date)
      );
      CREATE TABLE day_plans (
        location_id TEXT NOT NULL REFERENCES locations(id), date TEXT NOT NULL,
        budget_minutes INTEGER CHECK(budget_minutes >= 0), requirement_minutes INTEGER CHECK(requirement_minutes >= 0),
        PRIMARY KEY (location_id, date)
      );
      UPDATE meta SET value = '4' WHERE key = 'schema_version';
      UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision';
      COMMIT;`);
  }
  if (schemaVersion < 5) {
    if (db.prepare('SELECT COUNT(*) AS n FROM people').get().n > 0) {
      const dir = path.join(dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true });
      const destination = path.join(dir, 'rota-before-schema-5.sqlite');
      if (!fs.existsSync(destination)) db.prepare('VACUUM INTO ?').run(destination);
    }
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE people ADD COLUMN availability TEXT NOT NULL DEFAULT 'null';
      ALTER TABLE people ADD COLUMN default_warehouse TEXT NOT NULL DEFAULT '';
      ALTER TABLE people ADD COLUMN preferred_template_id TEXT REFERENCES templates(id) ON DELETE SET NULL;
      UPDATE meta SET value = '5' WHERE key = 'schema_version';
      UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision';
      COMMIT;`);
  }
  if (schemaVersion < 6) {
    if (db.prepare('SELECT COUNT(*) AS n FROM people').get().n > 0) {
      const dir = path.join(dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true });
      const destination = path.join(dir, 'rota-before-schema-6.sqlite');
      if (!fs.existsSync(destination)) db.prepare('VACUUM INTO ?').run(destination);
    }
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE attendance ADD COLUMN arrival_time TEXT;
      ALTER TABLE attendance ADD COLUMN arrival_date TEXT;
      ALTER TABLE attendance ADD COLUMN is_late INTEGER NOT NULL DEFAULT 0 CHECK(is_late IN (0,1));
      ALTER TABLE attendance ADD COLUMN late_minutes INTEGER CHECK(late_minutes >= 0);
      ALTER TABLE shifts ADD COLUMN holiday_minutes INTEGER CHECK(holiday_minutes > 0 AND holiday_minutes <= 1440);
      ALTER TABLE shifts ADD COLUMN holiday_approved INTEGER NOT NULL DEFAULT 1 CHECK(holiday_approved IN (0,1));
      CREATE TABLE leave_accounts (
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        year_start TEXT NOT NULL, year_end TEXT NOT NULL, tracking_start TEXT NOT NULL,
        day_minutes INTEGER NOT NULL CHECK(day_minutes > 0 AND day_minutes <= 1440),
        allowance_minutes INTEGER NOT NULL CHECK(allowance_minutes >= 0),
        carry_minutes INTEGER NOT NULL CHECK(carry_minutes >= 0),
        opening_taken_minutes INTEGER NOT NULL CHECK(opening_taken_minutes >= 0),
        PRIMARY KEY(person_id, year_start)
      );
      UPDATE meta SET value = '6' WHERE key = 'schema_version';
      UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision';
      COMMIT;`);
  }
  if (!db.prepare('SELECT id FROM locations LIMIT 1').get()) {
    db.prepare('INSERT INTO locations (id, name, share_token) VALUES (?, ?, ?)').run(uuid(), 'Warehouse', token());
  }
  if (!db.prepare("SELECT value FROM meta WHERE key = 'starter_colleagues'").get()) {
    if (options.seedExamples !== false && !db.prepare('SELECT id FROM people LIMIT 1').get()) {
      const loc = db.prepare('SELECT id FROM locations LIMIT 1').get();
      const insert = db.prepare('INSERT INTO people (id, name, team, location_id, row_order, default_department, is_example) VALUES (?, ?, ?, ?, ?, ?, 1)');
      for (let i = 0; i < 10; i++) {
        const department = DEPARTMENTS[i % 3];
        insert.run(uuid(), `Example Colleague ${String(i + 1).padStart(2, '0')}`, department, loc.id, i, department);
      }
    }
    db.prepare("INSERT INTO meta VALUES ('starter_colleagues', '1')").run();
  }
  const salt = randomBytes(16);
  const passwordHash = scryptSync(password, salt, 32);
  const passwordFingerprint = hash(password);
  const demo = options.demo === true;
  const dashboardSetting = key => process.env[key.toUpperCase()] || db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value || '';
  const dashboard = createDashboardReader({ getURL: () => dashboardSetting('dashboard_url'), getKey: () => dashboardSetting('dashboard_api_key'), allowLocal: options.allowLocalDashboard === true, fetch: options.dashboardFetch });
  const attempts = new Map();
  const revision = () => Number(db.prepare("SELECT value FROM meta WHERE key = 'revision'").get().value);
  const location = id => {
    const row = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
    requireThat(row, 'Location not found.', 404);
    return row;
  };
  const personRecord = row => ({ ...row, availability: JSON.parse(row.availability) });
  const person = id => {
    const row = db.prepare('SELECT * FROM people WHERE id = ?').get(id);
    requireThat(row, 'Colleague not found.', 404);
    return personRecord(row);
  };
  function snapshot(locationId, week) {
    const loc = location(locationId);
    const shifts = db.prepare('SELECT * FROM shifts WHERE location_id = ? AND date BETWEEN ? AND ? ORDER BY date, person_id, start_time, id').all(locationId, week, addDays(week, 6));
    const ids = new Set(shifts.map(s => s.person_id));
    const people = db.prepare('SELECT * FROM people ORDER BY team COLLATE NOCASE, row_order, name COLLATE NOCASE, id').all()
      .filter(p => (p.active && p.location_id === locationId) || ids.has(p.id))
      .map(({ id, name, team, default_department, role, row_order, is_example }) => ({ id, name, team, default_department, role, row_order, is_example }));
    return {
      location: { id: loc.id, name: loc.name }, week, people,
      departments: DEPARTMENTS, warehouses: WAREHOUSES,
      // Absence reasons and daily manager records do not go on the shared rota.
      shifts: shifts.map(({ note, holiday_minutes, holiday_approved, ...shift }) => shift.kind === 'sick' ? { ...shift, kind: 'unavailable', label: 'Unavailable' } : shift)
    };
  }
  function state(week) {
    const publications = db.prepare('SELECT * FROM publications WHERE week = ?').all(week).map(p => ({
      location_id: p.location_id, week: p.week, published_at: p.published_at,
      dirty: hash(JSON.stringify(snapshot(p.location_id, week))) !== hash(p.snapshot)
    }));
    return {
      revision: revision(), week, demo, build: 'rota-manager-tools-20261009', departments: DEPARTMENTS, warehouses: WAREHOUSES,
      previousShifts: db.prepare('SELECT * FROM shifts WHERE date = ?').all(addDays(week, -1)),
      previousAttendance: db.prepare('SELECT * FROM attendance WHERE date = ? ORDER BY person_id').all(addDays(week, -1)),
      dashboard: { url: dashboardSetting('dashboard_url'), hasKey: Boolean(dashboardSetting('dashboard_api_key')) },
      locations: db.prepare('SELECT id, name, share_token, active FROM locations ORDER BY active DESC, name COLLATE NOCASE').all(),
      people: db.prepare('SELECT * FROM people ORDER BY team COLLATE NOCASE, row_order, name COLLATE NOCASE, id').all().map(personRecord),
      templates: db.prepare('SELECT * FROM templates ORDER BY name COLLATE NOCASE').all(),
      shifts: db.prepare('SELECT * FROM shifts WHERE date BETWEEN ? AND ? ORDER BY date, start_time, id').all(week, addDays(week, 6)),
      attendance: db.prepare('SELECT * FROM attendance WHERE date BETWEEN ? AND ? ORDER BY date, person_id').all(week, addDays(week, 6)),
      dayPlans: db.prepare('SELECT location_id, date, requirement_minutes FROM day_plans WHERE date BETWEEN ? AND ? AND requirement_minutes IS NOT NULL ORDER BY date, location_id').all(week, addDays(week, 6)),
      publications
    };
  }
  function validateShift(body, skipId, additional = [], allowUnassigned = false) {
    const p = person(body.person_id), loc = location(body.location_id);
    requireThat(p.active && loc.active, 'Reactivate this colleague or location before assigning shifts.');
    const shift = { id: skipId || uuid(), person_id: p.id, location_id: loc.id, date: dateValue(body.date), ...shiftFields(body) };
    const working = ['work', 'training'].includes(shift.kind);
    const previous = skipId ? db.prepare('SELECT holiday_minutes, holiday_approved, kind FROM shifts WHERE id = ?').get(skipId) : null;
    const holidayHours = body.holiday_hours === undefined ? undefined : body.holiday_hours;
    shift.holiday_minutes = null;
    if (shift.kind === 'holiday') {
      if (holidayHours === undefined) shift.holiday_minutes = body.holiday_minutes === undefined ? previous?.kind === 'holiday' ? previous.holiday_minutes : null : body.holiday_minutes;
      else if (holidayHours !== '' && holidayHours !== null) {
        requireThat((typeof holidayHours === 'number' || typeof holidayHours === 'string') && Number.isFinite(Number(holidayHours)) && Number(holidayHours) > 0 && Number(holidayHours) <= 24, 'Holiday hours must be greater than 0 and at most 24, or left blank.');
        shift.holiday_minutes = Math.round(Number(holidayHours) * 60);
      }
    }
    if (shift.holiday_minutes !== null) integer(shift.holiday_minutes, 1, 1440, 'Holiday hours in minutes');
    if (body.holiday_approved !== undefined) requireThat([true, false, 0, 1].includes(body.holiday_approved), 'Choose whether this holiday is approved.');
    const approval = body.holiday_approved ?? (previous?.kind === 'holiday' ? previous.holiday_approved : 1);
    shift.holiday_approved = shift.kind === 'holiday' && (approval === false || approval === 0) ? 0 : 1;
    shift.department = body.department === undefined ? p.default_department : body.department;
    shift.warehouse = body.warehouse ?? '';
    shift.colour = ({ Picking: 'blue', Engraving: 'violet', Packing: 'teal' })[shift.department] || shift.colour;
    requireThat(DEPARTMENTS.includes(shift.department) || (shift.department === '' && (!working || allowUnassigned)), `${p.name}: choose Picking, Engraving or Packing for this shift, or set a default department.`);
    requireThat(WAREHOUSES.includes(shift.warehouse) || (shift.warehouse === '' && (!working || allowUnassigned)), 'Choose Warehouse 1 or Warehouse 2 for this shift.');
    const existing = db.prepare('SELECT * FROM shifts WHERE person_id = ? AND date BETWEEN ? AND ?').all(p.id, addDays(shift.date, -1), addDays(shift.date, 1));
    const conflict = [...existing, ...additional].find(s => s.id !== skipId && overlaps(s, shift));
    requireThat(!conflict, `${p.name} already has an overlapping shift or absence on ${conflict?.date || shift.date}.`, 422);
    return shift;
  }
  const insertShift = db.prepare('INSERT INTO shifts (id, person_id, location_id, date, start_time, end_time, break_minutes, kind, label, colour, note, department, warehouse, break_start, holiday_minutes, holiday_approved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const shiftArgs = s => [s.id, s.person_id, s.location_id, s.date, s.start_time, s.end_time, s.break_minutes, s.kind, s.label, s.colour, s.note, s.department, s.warehouse, s.break_start, s.holiday_minutes ?? null, s.holiday_approved ?? 1];
  function checkAvailability(shifts, body) {
    if (body.override_availability === true) return;
    const warnings = shifts.map(shift => ({ person_id: shift.person_id, date: shift.date, message: availabilityWarning(person(shift.person_id), shift) })).filter(w => w.message);
    if (warnings.length) throw new Problem(422, 'This shift is outside saved availability. Review the warning and choose Schedule anyway to override.', { code: 'availability_warning', warnings });
  }
  function savePerson(body, id) {
    const loc = location(body.location_id);
    requireThat(loc.active || id, 'Choose an active location.');
    const name = textValue(body.name, 'Colleague name', 120);
    const existing = id ? person(id) : null;
    const defaultDepartment = body.default_department ?? (body.team === undefined ? existing?.default_department || '' : DEPARTMENTS.includes(body.team) ? body.team : '');
    requireThat(defaultDepartment === '' || DEPARTMENTS.includes(defaultDepartment), 'Choose Picking, Engraving or Packing as the default department, or leave it unset.');
    const team = textValue(body.team || defaultDepartment || existing?.team || 'Warehouse', 'Team', 60);
    const role = textValue(body.role || '', 'Role', 80, true);
    const leaderboardName = textValue(body.leaderboard_name ?? existing?.leaderboard_name ?? '', 'Dashboard name', 120, true);
    const isExample = body.is_example === false || body.is_example === 0 ? 0 : existing?.is_example || 0;
    const hours = Number(body.contract_hours ?? 0);
    requireThat(Number.isFinite(hours) && hours >= 0 && hours <= 100, 'Contracted hours must be between 0 and 100. Leave this at 0 if not applicable.');
    const active = body.active === false || body.active === 0 ? 0 : 1;
    let availability;
    try { availability = normalizeAvailability(body.availability === undefined ? existing?.availability ?? null : body.availability); }
    catch (error) { throw new Problem(400, error.message); }
    const defaultWarehouse = body.default_warehouse ?? existing?.default_warehouse ?? '';
    requireThat(defaultWarehouse === '' || WAREHOUSES.includes(defaultWarehouse), 'Choose Warehouse 1 or Warehouse 2, or leave the warehouse unset.');
    const preferredTemplate = body.preferred_template_id === undefined ? existing?.preferred_template_id ?? null : body.preferred_template_id || null;
    requireThat(preferredTemplate === null || typeof preferredTemplate === 'string' && db.prepare('SELECT id FROM templates WHERE id = ?').get(preferredTemplate), 'Choose an existing preferred shift pattern, or leave it unset.');
    if (id) {
      db.prepare('UPDATE people SET name = ?, team = ?, role = ?, contract_minutes = ?, location_id = ?, active = ?, default_department = ?, leaderboard_name = ?, is_example = ?, availability = ?, default_warehouse = ?, preferred_template_id = ? WHERE id = ?')
        .run(name, team, role, Math.round(hours * 60), loc.id, active, defaultDepartment, leaderboardName, isExample, JSON.stringify(availability), defaultWarehouse, preferredTemplate, id);
      return id;
    }
    const newId = uuid();
    const order = db.prepare('SELECT COALESCE(MAX(row_order), 0) + 1 AS n FROM people').get().n;
    db.prepare('INSERT INTO people (id, name, team, role, contract_minutes, location_id, active, row_order, default_department, leaderboard_name, availability, default_warehouse, preferred_template_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId, name, team, role, Math.round(hours * 60), loc.id, active, order, defaultDepartment, leaderboardName, JSON.stringify(availability), defaultWarehouse, preferredTemplate);
    return newId;
  }
  function backupFile(destination) {
    db.prepare('VACUUM INTO ?').run(destination);
  }
  function availabilityPlan(body) {
    const loc = location(body.location_id), week = weekValue(body.week);
    requireThat(loc.active, 'Reactivate this location before filling the rota.');
    requireThat(Array.isArray(body.person_ids) && body.person_ids.length > 0 && Array.isArray(body.dates) && body.dates.length > 0, 'Choose colleagues and days to fill.');
    const ids = [...new Set(body.person_ids)], dates = [...new Set(body.dates)].map(dateValue).sort();
    requireThat(ids.length * dates.length <= 1000, 'Fill at most 1,000 colleague days at once.');
    requireThat(ids.every(id => typeof id === 'string'), 'Choose valid colleague profiles.');
    requireThat(dates.every(date => date >= week && date <= addDays(week, 6)), 'Choose dates in the displayed rota week.');
    const fallbackWarehouse = body.warehouse || '';
    requireThat(!fallbackWarehouse || WAREHOUSES.includes(fallbackWarehouse), 'Choose a valid fallback warehouse.');
    const templateId = body.template_id || null;
    requireThat(!templateId || typeof templateId === 'string' && db.prepare('SELECT id FROM templates WHERE id = ?').get(templateId), 'Choose an existing shift pattern.');
    const breakMinutes = integer(Number(body.break_minutes ?? 30), 0, 240, 'Unpaid break');
    const selectedPeople = ids.map(person), shifts = [], skipped = [];
    const totals = new Map(selectedPeople.map(p => [p.id, db.prepare('SELECT * FROM shifts WHERE person_id = ? AND date BETWEEN ? AND ?').all(p.id, week, addDays(week, 6)).reduce((sum, s) => sum + scheduledMinutes(s), 0)]));
    const timeLabel = value => `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    for (const date of dates) for (const p of selectedPeople) {
      const skip = reason => skipped.push({ person_id: p.id, name: p.name, date, reason });
      if (!p.active || p.location_id !== loc.id) { skip('Not an active colleague at this location'); continue; }
      if (!p.availability) { skip('Availability not set'); continue; }
      const day = p.availability.days[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7];
      if (day.mode === 'unavailable') { skip('Unavailable'); continue; }
      if (db.prepare('SELECT id FROM shifts WHERE person_id = ? AND date = ? LIMIT 1').get(p.id, date)) { skip('Already has a shift or absence'); continue; }
      if (!p.default_department) { skip('Department not set in profile'); continue; }
      const warehouse = p.default_warehouse || fallbackWarehouse;
      if (!warehouse) { skip('Warehouse not set in profile or fill options'); continue; }
      const preferred = templateId || p.preferred_template_id;
      const pattern = preferred ? db.prepare('SELECT * FROM templates WHERE id = ?').get(preferred) : null;
      if (!pattern && day.mode === 'all_day') { skip('All-day availability needs a shift pattern'); continue; }
      const duration = pattern ? 0 : (timeMinutes(day.end) - timeMinutes(day.start) + 1440) % 1440;
      if (!pattern && duration <= breakMinutes) { skip('Available window is shorter than the unpaid break'); continue; }
      const fields = pattern ? { ...pattern, label: pattern.name, note: '' } : {
        kind: 'work', label: 'Shift', start_time: day.start, end_time: day.end,
        break_minutes: breakMinutes,
        break_start: breakMinutes ? timeLabel(timeMinutes(day.start) + Math.floor((duration - breakMinutes) / 2 / 15) * 15) : null
      };
      let shift;
      try { shift = validateShift({ ...fields, person_id: p.id, location_id: loc.id, date, department: p.default_department, warehouse }, undefined, shifts); }
      catch (error) { if (error instanceof Problem && error.status === 422) { skip('Overlaps an existing shift or absence'); continue; } throw error; }
      if (!isShiftAvailable(p.availability, shift)) { skip('Shift pattern is outside availability'); continue; }
      const netMinutes = scheduledMinutes(shift);
      if (body.respect_contract_hours !== false && p.contract_minutes > 0 && totals.get(p.id) + netMinutes > p.contract_minutes) { skip('Would exceed contracted weekly hours'); continue; }
      shifts.push(shift); totals.set(p.id, totals.get(p.id) + netMinutes);
    }
    return { week, shifts, skipped, total_minutes: shifts.reduce((sum, shift) => sum + scheduledMinutes(shift), 0) };
  }
  function dayCopyPlan(body) {
    const loc = location(body.location_id), source = dateValue(body.source_date), target = dateValue(body.target_date);
    requireThat(loc.active, 'Reactivate this location before copying shifts.');
    requireThat(source !== target, 'Choose a different day to copy into.');
    const original = db.prepare("SELECT * FROM shifts WHERE location_id = ? AND date = ? AND kind IN ('work', 'training') ORDER BY person_id, start_time, id").all(loc.id, source);
    requireThat(original.length <= 1000, 'Copy at most 1,000 shifts at once.');
    const shifts = [], skipped = [], warnings = [];
    for (const entry of original) {
      const p = person(entry.person_id), skip = reason => skipped.push({ person_id: p.id, name: p.name, reason });
      if (!p.active) { skip('Colleague is archived'); continue; }
      let shift;
      try { shift = validateShift({ ...entry, date: target }, undefined, shifts, true); }
      catch (error) { if (error instanceof Problem && error.status === 422) { skip(error.message); continue; } throw error; }
      const warning = availabilityWarning(p, shift);
      if (warning) {
        warnings.push({ person_id: p.id, name: p.name, message: warning });
        if (body.override_availability !== true) { skip('Outside saved availability'); continue; }
      }
      shifts.push(shift);
    }
    return { source_date: source, target_date: target, source_count: original.length, shifts, skipped, warnings, total_minutes: shifts.reduce((total, s) => total + scheduledMinutes(s), 0) };
  }
  function leaveProfile(id, date, yearStart) {
    person(id);
    const accounts = db.prepare('SELECT * FROM leave_accounts WHERE person_id = ? ORDER BY year_start DESC').all(id);
    const account = yearStart ? accounts.find(a => a.year_start === dateValue(yearStart)) : accounts.find(a => a.year_start <= date && a.year_end >= date);
    if (yearStart) requireThat(account, 'Holiday year not found.', 404);
    const shifts = db.prepare("SELECT s.*, l.name AS location_name FROM shifts s JOIN locations l ON l.id = s.location_id WHERE person_id = ? AND kind = 'holiday' ORDER BY date, id").all(id);
    return { accounts, account: account || null, as_of: today(), revision: revision(), ...(account ? holidayBalance(account, shifts, today()) : { bookings: shifts.filter(s => s.date >= `${date.slice(0, 4)}-01-01` && s.date <= `${date.slice(0, 4)}-12-31`) }) };
  }
  function saveLeaveAccount(id, body) {
    person(id);
    const start = dateValue(body.year_start), end = dateValue(body.year_end), tracking = dateValue(body.tracking_start || start);
    const originalStart = body.original_year_start ? dateValue(body.original_year_start) : start;
    if (body.original_year_start) requireThat(db.prepare('SELECT year_start FROM leave_accounts WHERE person_id = ? AND year_start = ?').get(id, originalStart), 'Holiday year not found. Reopen the profile.', 404);
    requireThat(end >= start && end <= addDays(start, 365), 'The holiday year must be at most 366 days, including its start and end.');
    requireThat(tracking >= start && tracking <= end, 'Tracking starts within the holiday year.');
    requireThat(!db.prepare('SELECT year_start FROM leave_accounts WHERE person_id = ? AND year_start != ? AND year_start <= ? AND year_end >= ?').get(id, originalStart, end, start), 'This holiday year overlaps an existing year.');
    const hoursValue = (value, name, max = 10000) => {
      requireThat((typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= max, `${name} must be hours between 0 and ${max}.`);
      return Math.round(Number(value) * 60);
    };
    const day = hoursValue(body.day_hours, 'Usual working day', 24);
    requireThat(day > 0, 'Enter the paid hours in one usual working day.');
    const allowance = hoursValue(body.allowance_hours, 'Annual allowance'), carry = hoursValue(body.carry_hours ?? 0, 'Carry-over'), opening = hoursValue(body.opening_taken_hours ?? 0, 'Opening days taken');
    if (originalStart !== start) db.prepare('UPDATE leave_accounts SET year_start=?, year_end=?, tracking_start=?, day_minutes=?, allowance_minutes=?, carry_minutes=?, opening_taken_minutes=? WHERE person_id=? AND year_start=?').run(start, end, tracking, day, allowance, carry, opening, id, originalStart);
    else db.prepare('INSERT INTO leave_accounts (person_id, year_start, year_end, tracking_start, day_minutes, allowance_minutes, carry_minutes, opening_taken_minutes) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(person_id, year_start) DO UPDATE SET year_end=excluded.year_end, tracking_start=excluded.tracking_start, day_minutes=excluded.day_minutes, allowance_minutes=excluded.allowance_minutes, carry_minutes=excluded.carry_minutes, opening_taken_minutes=excluded.opening_taken_minutes').run(id, start, end, tracking, day, allowance, carry, opening);
    return { saved: true, year_start: start };
  }
  function dailyBackup() {
    const dir = path.join(dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const filename = `rota-${new Date().toISOString().slice(0, 10)}.sqlite`;
    const destination = path.join(dir, filename);
    if (!fs.existsSync(destination)) backupFile(destination);
    const files = fs.readdirSync(dir).filter(f => /^rota-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().reverse();
    for (const old of files.slice(7)) fs.unlinkSync(path.join(dir, old));
  }
  dailyBackup();
  const backupTimer = setInterval(() => { try { dailyBackup(); } catch (error) { console.error('Daily backup failed:', error.message); } }, 60 * 60 * 1000);
  backupTimer.unref();
  function authenticated(req) {
    const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('rota_session='));
    if (!cookie) return false;
    const value = cookie.slice('rota_session='.length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
    const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash(value));
    return Boolean(session && session.expires_at > Date.now() && session.password_fingerprint === passwordFingerprint);
  }
  function commonHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  }
  function send(res, status, body, type = 'application/json; charset=utf-8') {
    commonHeaders(res);
    res.writeHead(status, { 'Content-Type': type });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  }
  async function readBody(req) {
    requireThat((req.headers['content-type'] || '').startsWith('application/json'), 'Send application/json.', 415);
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      requireThat(size <= 512000, 'The request is too large.', 413);
      chunks.push(chunk);
    }
    try {
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      requireThat(result && typeof result === 'object' && !Array.isArray(result), 'Send a JSON object.');
      return result;
    } catch (error) {
      if (error instanceof Problem) throw error;
      throw new Problem(400, 'The request could not be read.');
    }
  }
  function csrf(req) {
    requireThat(req.headers['x-rota-request'] === '1', 'Refresh the page and try again.', 403);
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { throw new Problem(403, 'Request origin not allowed.'); }
      const allowed = new Set([req.headers.host, process.env.RENDER_EXTERNAL_HOSTNAME]);
      if (process.env.PUBLIC_URL) allowed.add(new URL(process.env.PUBLIC_URL).host);
      requireThat(allowed.has(origin.host), 'Request origin not allowed.', 403);
    }
  }
  function mutation(req, callback) {
    db.exec('BEGIN IMMEDIATE');
    try {
      requireThat(req.headers['if-match'] === String(revision()), 'The rota changed in another window. The latest version has been loaded; review it and try again.', 409);
      const result = callback();
      db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'").run();
      db.exec('COMMIT');
      return { ...result, revision: revision() };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function siteOrigin(req) {
    if (process.env.PUBLIC_URL) return new URL(process.env.PUBLIC_URL).origin;
    if (process.env.RENDER_EXTERNAL_HOSTNAME) return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
    return `http://${req.headers.host}`;
  }
  async function sharePDF(res, loc, url) {
    const week = weekValue(url.searchParams.get('week') || monday());
    const publication = db.prepare('SELECT * FROM publications WHERE location_id = ? AND week = ?').get(loc.id, week);
    requireThat(publication, 'Publish this week before sharing a PDF.', 404);
    const layout = url.searchParams.get('layout') || 'overview';
    const warehouse = url.searchParams.get('warehouse') || '', department = url.searchParams.get('department') || '';
    requireThat(['warehouse', 'department', 'az', 'overview'].includes(layout), 'Choose a valid PDF layout.');
    requireThat(!warehouse || WAREHOUSES.includes(warehouse), 'Choose Warehouse 1 or Warehouse 2.');
    requireThat(!department || DEPARTMENTS.includes(department), 'Choose a valid department.');
    const pdf = await rotaPDF(JSON.parse(publication.snapshot), { layout, warehouse, department, published_at: publication.published_at });
    res.setHeader('Content-Disposition', `attachment; filename="warehouse-rota-${week}-${layout}.pdf"`);
    return send(res, 200, pdf, 'application/pdf');
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      const method = req.method;
      if (method === 'GET' && pathname === '/health') return send(res, 200, { status: 'ok' });
      if (method === 'GET' && pathname === '/api/session') return send(res, 200, { authenticated: authenticated(req) });
      if (method === 'POST' && pathname === '/api/login') {
        csrf(req);
        const body = await readBody(req);
        const ip = process.env.RENDER === 'true' ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;
        const key = hash(ip || 'unknown');
        for (const [key, value] of attempts) if (value.until < Date.now()) attempts.delete(key);
        const attempt = attempts.get(key) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
        requireThat(attempt.count < 10, 'Too many login attempts. Try again in 15 minutes.', 429);
        requireThat(typeof body.password === 'string' && body.password.length <= 256, 'Enter your manager password.', 401);
        const candidate = scryptSync(body.password, salt, 32);
        if (!timingSafeEqual(candidate, passwordHash)) {
          attempt.count++; attempts.set(key, attempt);
          throw new Problem(401, 'That password was not recognised.');
        }
        attempts.delete(key);
        db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
        const sessionToken = token();
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(sessionToken), Date.now() + SESSION_MS, passwordFingerprint);
        const secure = process.env.NODE_ENV === 'production' || siteOrigin(req).startsWith('https:');
        res.setHeader('Set-Cookie', `rota_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
        return send(res, 200, { ok: true });
      }
      if (method === 'GET' && /^\/api\/public\/[^/]+\/pdf$/.test(pathname)) {
        const loc = db.prepare('SELECT id FROM locations WHERE share_token = ?').get(pathname.split('/')[3]);
        requireThat(loc, 'This rota link is no longer available.', 404);
        return await sharePDF(res, loc, url);
      }
      if (method === 'GET' && pathname.startsWith('/api/public/')) {
        const shareToken = pathname.slice('/api/public/'.length);
        const loc = db.prepare('SELECT id, name FROM locations WHERE share_token = ?').get(shareToken);
        requireThat(loc, 'This rota link is no longer available. Ask your manager for the current link.', 404);
        const weeks = db.prepare('SELECT week, published_at FROM publications WHERE location_id = ? ORDER BY week').all(loc.id);
        const current = monday();
        const requested = url.searchParams.get('week');
        const week = requested ? weekValue(requested) : weeks.find(w => w.week === current)?.week || weeks.find(w => w.week > current)?.week || weeks.at(-1)?.week || current;
        const publication = db.prepare('SELECT * FROM publications WHERE location_id = ? AND week = ?').get(loc.id, week);
        return send(res, 200, publication ? { ...JSON.parse(publication.snapshot), published_at: publication.published_at, weeks, readOnly: true, demo } : { location: loc, week, people: [], shifts: [], weeks, readOnly: true, unpublished: true, demo });
      }
      if (pathname.startsWith('/api/')) {
        requireThat(authenticated(req), 'Sign in to manage the rota.', 401);
        if (method === 'POST' && pathname === '/api/logout') {
          csrf(req);
          const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)rota_session=([^;]+)/);
          if (cookie) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(cookie[1]));
          res.setHeader('Set-Cookie', 'rota_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
          return send(res, 200, { ok: true });
        }
        if (method === 'GET' && pathname === '/api/state') return send(res, 200, state(weekValue(url.searchParams.get('week') || monday())));
        if (method === 'GET' && pathname === '/api/days/copy-plan') {
          return send(res, 200, { ...dayCopyPlan({ location_id: url.searchParams.get('locationId'), source_date: url.searchParams.get('sourceDate'), target_date: url.searchParams.get('targetDate'), override_availability: url.searchParams.get('overrideAvailability') === 'true' }), revision: revision() });
        }
        if (method === 'GET' && /^\/api\/people\/[^/]+\/holiday$/.test(pathname)) {
          return send(res, 200, leaveProfile(pathname.split('/')[3], dateValue(url.searchParams.get('date') || today()), url.searchParams.get('yearStart')));
        }
        if (method === 'GET' && pathname === '/api/weeks/availability-plan') {
          const plan = availabilityPlan({
            location_id: url.searchParams.get('locationId'), week: url.searchParams.get('week'),
            person_ids: (url.searchParams.get('people') || '').split(',').filter(Boolean), dates: (url.searchParams.get('dates') || '').split(',').filter(Boolean),
            warehouse: url.searchParams.get('warehouse'), template_id: url.searchParams.get('template'),
            break_minutes: url.searchParams.get('breakMinutes') ?? 30, respect_contract_hours: url.searchParams.get('contractLimit') !== 'false'
          });
          return send(res, 200, { ...plan, revision: revision() });
        }
        if (method === 'GET' && /^\/api\/people\/[^/]+\/performance$/.test(pathname)) {
          const colleague = person(pathname.split('/')[3]);
          const requestedWeek = url.searchParams.get('week');
          const requestedDate = url.searchParams.get('date');
          requireThat(!(requestedWeek && requestedDate), 'Choose a rota week or a single performance date.');
          if (requestedWeek) {
            const week = weekValue(requestedWeek);
            const loc = location(url.searchParams.get('locationId') || colleague.location_id);
            const shifts = db.prepare('SELECT person_id, date, start_time, end_time, kind FROM shifts WHERE person_id = ? AND location_id = ? AND date BETWEEN ? AND ? ORDER BY date, start_time').all(colleague.id, loc.id, week, addDays(week, 6));
            try { return send(res, 200, await dashboard.weeklyProfile(colleague, shifts, week)); }
            catch (error) { if (error instanceof Problem) throw error; throw new Problem(502, error.message); }
          }
          const date = requestedDate ? dateValue(requestedDate) : '';
          requireThat(!date || date <= today(), 'Choose a performance date up to today.');
          try { return send(res, 200, await dashboard.profile(colleague, date)); }
          catch (error) { if (error instanceof Problem) throw error; throw new Problem(502, error.message); }
        }
        if (method === 'GET' && pathname === '/api/export.pdf') return await sharePDF(res, location(url.searchParams.get('locationId')), url);
        if (method === 'GET' && pathname === '/api/qr.svg') {
          const loc = location(url.searchParams.get('locationId'));
          const svg = await QRCode.toString(`${siteOrigin(req)}/rota/${loc.share_token}`, { type: 'svg', width: 360, margin: 4, errorCorrectionLevel: 'M' });
          return send(res, 200, svg, 'image/svg+xml');
        }
        if (method === 'GET' && pathname === '/api/export.csv') {
          const loc = location(url.searchParams.get('locationId'));
          const week = weekValue(url.searchParams.get('week'));
          const snap = snapshot(loc.id, week);
          const draftShifts = db.prepare('SELECT * FROM shifts WHERE location_id = ? AND date BETWEEN ? AND ? ORDER BY date, person_id, start_time, id').all(loc.id, week, addDays(week, 6));
          const names = new Map(snap.people.map(p => [p.id, p]));
          const rows = [['Name', 'Default department', 'Department', 'Warehouse', 'Date', 'Shift', 'Start', 'Finish', 'Break starts', 'Unpaid break minutes', 'Scheduled hours', 'Type']];
          for (const s of draftShifts) rows.push([names.get(s.person_id).name, names.get(s.person_id).default_department, s.department, s.warehouse, s.date, s.label, s.start_time || '', s.end_time || '', s.break_start || '', s.break_minutes, (scheduledMinutes(s) / 60).toFixed(2), s.kind]);
          res.setHeader('Content-Disposition', `attachment; filename="rota-${week}.csv"`);
          return send(res, 200, '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'), 'text/csv; charset=utf-8');
        }
        if (method === 'GET' && pathname === '/api/backup') {
          const destination = path.join(dataDir, `download-${uuid()}.sqlite`);
          try {
            backupFile(destination);
            const contents = fs.readFileSync(destination);
            res.setHeader('Content-Disposition', `attachment; filename="warehouse-rota-backup-${today()}.sqlite"`);
            return send(res, 200, contents, 'application/vnd.sqlite3');
          } finally { if (fs.existsSync(destination)) fs.unlinkSync(destination); }
        }
        requireThat(['POST', 'PUT', 'DELETE'].includes(method), 'Endpoint not found.', 404);
        csrf(req);
        const body = await readBody(req);
        const result = mutation(req, () => {
          if (method === 'POST' && pathname === '/api/attendance') {
            const p = person(body.person_id), loc = location(body.location_id), date = dateValue(body.date);
            requireThat(['checked_in', 'late', 'no_show', 'unmarked'].includes(body.status), 'Choose checked in, late, no show or clear attendance.');
            requireThat(date <= today(), 'Attendance can be marked on the shift date or afterwards.');
            if (body.status === 'unmarked') {
              db.prepare('DELETE FROM attendance WHERE person_id = ? AND location_id = ? AND date = ?').run(p.id, loc.id, date);
              return { cleared: true };
            }
            const first = db.prepare("SELECT * FROM shifts WHERE person_id = ? AND location_id = ? AND date = ? AND kind IN ('work', 'training') ORDER BY start_time, id LIMIT 1").get(p.id, loc.id, date);
            requireThat(first, 'Attendance needs a work or training shift on this day.');
            let arrival_time = null, arrival_date = null, is_late = body.status === 'late' ? 1 : 0, late_minutes = null;
            if (body.arrival_time) {
              requireThat(body.status === 'checked_in' || body.status === 'late', 'Record an arrival time with a check in.');
              timeMinutes(body.arrival_time); arrival_time = body.arrival_time; arrival_date = dateValue(body.arrival_date || date);
              requireThat(arrival_date === date || first.end_time < first.start_time && arrival_date === addDays(date, 1), 'Choose the shift date, or the next day for an overnight arrival.');
              requireThat(arrival_date <= today(), 'An arrival cannot be recorded for a future day.');
              try { ({ is_late, late_minutes } = arrivalDetails(first, arrival_date, arrival_time)); }
              catch (error) { throw new Problem(400, error.message); }
            }
            const status = body.status === 'late' ? 'checked_in' : body.status;
            const marked_at = new Date().toISOString();
            db.prepare('INSERT INTO attendance (person_id, location_id, date, status, marked_at, arrival_time, arrival_date, is_late, late_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(person_id, location_id, date) DO UPDATE SET status=excluded.status, marked_at=excluded.marked_at, arrival_time=excluded.arrival_time, arrival_date=excluded.arrival_date, is_late=excluded.is_late, late_minutes=excluded.late_minutes').run(p.id, loc.id, date, status, marked_at, arrival_time, arrival_date, is_late, late_minutes);
            return { status, marked_at, arrival_time, arrival_date, is_late, late_minutes };
          }
          if (method === 'POST' && pathname === '/api/day-plans') {
            const loc = location(body.location_id), date = dateValue(body.date);
            requireThat(loc.active, 'Reactivate this location before setting daily hours.');
            const toMinutes = (value, name) => {
              if (value === null || value === undefined || value === '') return null;
              requireThat((typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 10000, `${name} must be hours between 0 and 10,000, or left blank.`);
              return Math.round(Number(value) * 60);
            };
            const required = toMinutes(body.requirement_hours, 'Required hours');
            if (required === null) db.prepare('DELETE FROM day_plans WHERE location_id = ? AND date = ?').run(loc.id, date);
            else db.prepare('INSERT INTO day_plans (location_id, date, budget_minutes, requirement_minutes) VALUES (?, ?, NULL, ?) ON CONFLICT(location_id, date) DO UPDATE SET budget_minutes = NULL, requirement_minutes = excluded.requirement_minutes').run(loc.id, date, required);
            return { saved: true };
          }
          if (method === 'POST' && pathname === '/api/dashboard/settings') {
            let value;
            try { value = dashboard.validateURL(body.url || ''); } catch (error) { throw new Problem(400, error.message); }
            db.prepare('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('dashboard_url', value);
            if (body.api_key !== undefined) db.prepare('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('dashboard_api_key', textValue(body.api_key, 'Dashboard integration key', 256, true));
            dashboard.reset(); return { saved: true };
          }
          if (method === 'POST' && pathname === '/api/people') return { id: savePerson(body) };
          if (method === 'PUT' && /^\/api\/people\/[^/]+\/holiday$/.test(pathname)) return saveLeaveAccount(pathname.split('/')[3], body);
          if (method === 'PUT' && /^\/api\/people\/[^/]+\/availability$/.test(pathname)) {
            const id = pathname.split('/')[3]; person(id);
            let availability;
            try { availability = normalizeAvailability(body.availability); }
            catch (error) { throw new Problem(400, error.message); }
            db.prepare('UPDATE people SET availability = ? WHERE id = ?').run(JSON.stringify(availability), id);
            return { id };
          }
          if (method === 'PUT' && /^\/api\/people\/[^/]+$/.test(pathname)) return { id: savePerson(body, pathname.split('/').at(-1)) };
          if (method === 'DELETE' && /^\/api\/people\/[^/]+$/.test(pathname)) {
            const id = pathname.split('/').at(-1);
            person(id);
            requireThat(body.confirm === true, 'Confirm deletion of this colleague and their draft shifts.');
            const removed = db.prepare('DELETE FROM shifts WHERE person_id = ?').run(id);
            db.prepare('DELETE FROM people WHERE id = ?').run(id);
            return { deleted: true, removed_shifts: Number(removed.changes) };
          }
          if (method === 'POST' && pathname === '/api/people/import') {
            location(body.location_id);
            requireThat(Array.isArray(body.people) && body.people.length > 0 && body.people.length <= 1000, 'Import between 1 and 1,000 colleagues.');
            const names = new Set(db.prepare('SELECT name FROM people WHERE location_id = ?').all(body.location_id).map(p => p.name.toLocaleLowerCase()));
            let imported = 0, skipped = 0;
            for (const p of body.people) {
              requireThat(p && typeof p === 'object' && !Array.isArray(p), 'Check the colleague rows in the import.');
              const name = textValue(p.name, 'Colleague name', 120);
              if (names.has(name.toLocaleLowerCase())) { skipped++; continue; }
              savePerson({ ...p, name, location_id: body.location_id });
              names.add(name.toLocaleLowerCase()); imported++;
            }
            return { imported, skipped };
          }
          if ((method === 'POST' && pathname === '/api/templates') || (method === 'PUT' && /^\/api\/templates\/[^/]+$/.test(pathname))) {
            const id = method === 'PUT' ? pathname.split('/').at(-1) : uuid();
            if (method === 'PUT') requireThat(db.prepare('SELECT id FROM templates WHERE id = ?').get(id), 'Shift pattern not found.', 404);
            const fields = shiftFields({ ...body, label: body.name });
            requireThat(['work', 'training'].includes(fields.kind), 'Shift patterns must be work or training.');
            const name = textValue(body.name, 'Pattern name', 60);
            db.prepare('INSERT INTO templates (id, name, start_time, end_time, break_minutes, kind, colour, break_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, start_time = excluded.start_time, end_time = excluded.end_time, break_minutes = excluded.break_minutes, kind = excluded.kind, colour = excluded.colour, break_start = excluded.break_start')
              .run(id, name, fields.start_time, fields.end_time, fields.break_minutes, fields.kind, fields.colour, fields.break_start);
            return { id };
          }
          if (method === 'DELETE' && /^\/api\/templates\/[^/]+$/.test(pathname)) {
            const result = db.prepare('DELETE FROM templates WHERE id = ?').run(pathname.split('/').at(-1));
            requireThat(result.changes, 'Shift pattern not found.', 404); return { deleted: true };
          }
          if (method === 'POST' && pathname === '/api/shifts') {
            const shift = validateShift(body);
            checkAvailability([shift], body);
            insertShift.run(...shiftArgs(shift)); return { id: shift.id };
          }
          if (method === 'PUT' && /^\/api\/shifts\/[^/]+$/.test(pathname)) {
            const id = pathname.split('/').at(-1);
            requireThat(db.prepare('SELECT id FROM shifts WHERE id = ?').get(id), 'Shift not found.', 404);
            const shift = validateShift(body, id);
            checkAvailability([shift], body);
            db.prepare('DELETE FROM shifts WHERE id = ?').run(id);
            insertShift.run(...shiftArgs(shift)); return { id };
          }
          if (method === 'DELETE' && /^\/api\/shifts\/[^/]+$/.test(pathname)) {
            const result = db.prepare('DELETE FROM shifts WHERE id = ?').run(pathname.split('/').at(-1));
            requireThat(result.changes, 'Shift not found.', 404); return { deleted: true };
          }
          if (method === 'POST' && pathname === '/api/shifts/bulk') {
            requireThat(Array.isArray(body.person_ids) && body.person_ids.length > 0 && Array.isArray(body.dates) && body.dates.length > 0, 'Choose colleagues and days.');
            const people = [...new Set(body.person_ids)], dates = [...new Set(body.dates)];
            requireThat(people.length * dates.length <= 1000, 'Assign at most 1,000 shifts at once.');
            const pending = [];
            for (const person_id of people) for (const date of dates) pending.push(validateShift({ ...body, person_id, date }, undefined, pending));
            checkAvailability(pending, body);
            for (const shift of pending) insertShift.run(...shiftArgs(shift));
            return { created: pending.length };
          }
          if (method === 'POST' && pathname === '/api/weeks/populate') {
            const plan = availabilityPlan(body);
            for (const shift of plan.shifts) insertShift.run(...shiftArgs(shift));
            return { created: plan.shifts.length, skipped: plan.skipped, total_minutes: plan.total_minutes };
          }
          if (method === 'POST' && pathname === '/api/days/copy') {
            const plan = dayCopyPlan(body);
            for (const shift of plan.shifts) insertShift.run(...shiftArgs(shift));
            return { copied: plan.shifts.length, skipped: plan.skipped, warnings: plan.warnings, source_date: plan.source_date, target_date: plan.target_date };
          }
          if (method === 'POST' && pathname === '/api/shifts/clear') {
            const loc = location(body.location_id);
            requireThat(body.scope === 'day' || body.scope === 'week', 'Choose a day or week to clear.');
            requireThat(body.confirm === true, 'Confirm clearing these draft shifts.');
            const start = body.scope === 'day' ? dateValue(body.date) : weekValue(body.week);
            const end = body.scope === 'day' ? start : addDays(start, 6);
            // Clear only assignments: recorded attendance, requirements and publications stay saved.
            const removed = db.prepare('DELETE FROM shifts WHERE location_id = ? AND date BETWEEN ? AND ?').run(loc.id, start, end);
            return { cleared: true, removed_shifts: Number(removed.changes), scope: body.scope, start_date: start, end_date: end };
          }
          if (method === 'POST' && pathname === '/api/weeks/copy') {
            const loc = location(body.location_id), week = weekValue(body.week);
            requireThat(loc.active, 'Reactivate this location before copying shifts.');
            const sourceWeek = addDays(week, -7);
            const shifts = db.prepare('SELECT * FROM shifts WHERE location_id = ? AND date BETWEEN ? AND ? ORDER BY date').all(loc.id, sourceWeek, addDays(sourceWeek, 6));
            let copied = 0, skipped = 0, availabilitySkipped = 0;
            for (const shift of shifts) {
              if (!person(shift.person_id).active) { skipped++; continue; }
              try {
                const next = validateShift({ ...shift, date: addDays(shift.date, 7) }, undefined, [], true);
                if (!isShiftAvailable(person(shift.person_id).availability, next)) { skipped++; availabilitySkipped++; continue; }
                insertShift.run(...shiftArgs(next)); copied++;
              } catch (error) { if (error.status === 422) skipped++; else throw error; }
            }
            return { copied, skipped, availability_skipped: availabilitySkipped };
          }
          if (method === 'POST' && pathname === '/api/publish') {
            const loc = location(body.location_id), week = weekValue(body.week);
            const draft = snapshot(loc.id, week);
            const incomplete = draft.shifts.find(s => ['work', 'training'].includes(s.kind) && (!DEPARTMENTS.includes(s.department) || !WAREHOUSES.includes(s.warehouse)));
            requireThat(!incomplete, 'Set a department and warehouse on every work or training shift before publishing.');
            const snap = JSON.stringify(draft);
            const published_at = new Date().toISOString();
            db.prepare('INSERT INTO publications VALUES (?, ?, ?, ?) ON CONFLICT(location_id, week) DO UPDATE SET snapshot = excluded.snapshot, published_at = excluded.published_at').run(loc.id, week, snap, published_at);
            return { published_at };
          }
          if (method === 'DELETE' && pathname === '/api/publish') {
            const loc = location(body.location_id), week = weekValue(body.week);
            db.prepare('DELETE FROM publications WHERE location_id = ? AND week = ?').run(loc.id, week); return { unpublished: true };
          }
          if (method === 'POST' && pathname === '/api/share/reset') {
            const loc = location(body.location_id), share_token = token();
            db.prepare('UPDATE locations SET share_token = ? WHERE id = ?').run(share_token, loc.id);
            return { share_token };
          }
          if ((method === 'POST' && pathname === '/api/locations') || (method === 'PUT' && /^\/api\/locations\/[^/]+$/.test(pathname))) {
            const name = textValue(body.name, 'Location name', 80);
            if (method === 'POST') {
              const id = uuid(); db.prepare('INSERT INTO locations (id, name, share_token) VALUES (?, ?, ?)').run(id, name, token()); return { id };
            }
            const id = pathname.split('/').at(-1); location(id);
            const active = body.active === false || body.active === 0 ? 0 : 1;
            if (!active) requireThat(db.prepare('SELECT COUNT(*) AS n FROM locations WHERE active = 1 AND id != ?').get(id).n > 0, 'Keep at least one location active.');
            db.prepare('UPDATE locations SET name = ?, active = ? WHERE id = ?').run(name, active, id); return { id };
          }
          throw new Problem(404, 'Endpoint not found.');
        });
        return send(res, 200, result);
      }
      requireThat(method === 'GET' || method === 'HEAD', 'Method not allowed.', 405);
      const publicFiles = { '/manager-tools.js': ['manager-tools.js', 'text/javascript; charset=utf-8'], '/availability.js': ['availability.js', 'text/javascript; charset=utf-8'], '/coverage.js': ['coverage.js', 'text/javascript; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      const file = publicFiles[pathname];
      if (file) return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', file[0])), file[1]);
      if (pathname === '/' || /^\/rota\/[A-Za-z0-9_-]{43}$/.test(pathname)) return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html')), 'text/html; charset=utf-8');
      return send(res, 404, { error: 'Page not found.' });
    } catch (error) {
      if (!(error instanceof Problem)) console.error('Request failed:', error.message);
      if (!res.headersSent) send(res, error.status || 500, { error: error instanceof Problem ? error.message : 'Something went wrong. Please try again.', ...(error instanceof Problem ? error.details : {}) });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return { server, db, dataDir, snapshot, close: () => new Promise(resolve => { clearInterval(backupTimer); server.close(() => { db.close(); resolve(); }); server.closeIdleConnections(); }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
  try {
    const app = createRotaServer();
    const port = Number(process.env.PORT || 3000);
    app.server.listen(port, '0.0.0.0', () => console.log(`Warehouse rota running on port ${port}`));
    const stop = () => { app.close().then(() => process.exit(0)); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch (error) { console.error(error.message); process.exit(1); }
}
