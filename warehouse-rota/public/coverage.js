export const clockMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
export const clockLabel = value => `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(Math.round(value % 60)).padStart(2, '0')}${value >= 1440 ? ' +1' : ''}`;
export function shiftWindow(shift, date) {
  if (!['work', 'training'].includes(shift.kind)) return null;
  const offset = (Date.parse(shift.date + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 60000;
  const start = offset + clockMinutes(shift.start_time);
  let end = offset + clockMinutes(shift.end_time);
  if (end < start) end += 1440;
  let breakStart = null, breakEnd = null;
  if (shift.break_start && shift.break_minutes > 0) {
    breakStart = start + (clockMinutes(shift.break_start) - clockMinutes(shift.start_time) + 1440) % 1440;
    breakEnd = breakStart + shift.break_minutes;
  }
  return { start, end, breakStart, breakEnd, unplaced: shift.break_minutes > 0 && !shift.break_start };
}
export function coverageForDay(shifts, date, { warehouse, department, start = 0, end = 1440, minimum = 1 } = {}) {
  const windows = shifts.filter(s => (!warehouse || s.warehouse === warehouse) && (!department || s.department === department))
    .map(s => ({ shift: s, window: shiftWindow(s, date) })).filter(s => s.window && s.window.end > start && s.window.start < end);
  const boundaries = new Set([start, end]);
  for (const { window: w } of windows) for (const value of [w.start, w.end, w.breakStart, w.breakEnd]) if (value !== null && value > start && value < end) boundaries.add(value);
  const times = [...boundaries].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i < times.length - 1; i++) {
    const from = times[i], to = times[i + 1], at = (from + to) / 2;
    const scheduled = windows.filter(({ window: w }) => w.start <= at && at < w.end);
    const breaks = scheduled.filter(({ window: w }) => w.breakStart !== null && w.breakStart <= at && at < w.breakEnd);
    const available = scheduled.length - breaks.length;
    const unplaced = scheduled.filter(s => s.window.unplaced).length;
    segments.push({ start: from, end: to, scheduled: scheduled.length, onBreak: breaks.length, available, unplaced, status: available < minimum ? 'gap' : unplaced ? 'unconfirmed' : 'covered' });
  }
  return { windows, segments, unplaced: windows.filter(s => s.window.unplaced).map(s => s.shift.id), gaps: segments.filter(s => s.status === 'gap') };
}
