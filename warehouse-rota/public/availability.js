// Shared by the manager UI and server: recurring availability uses UK wall-clock times.
export const availabilityDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const clock = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const dayIndex = date => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;

export function normalizeAvailability(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.days) || value.days.length !== 7) throw new Error('Set availability for all seven days, or leave weekly availability switched off.');
  return { days: value.days.map((day, index) => {
    const name = availabilityDays[index];
    if (!day || !['unavailable', 'all_day', 'times'].includes(day.mode)) throw new Error(`${name}: choose unavailable, all day or available times.`);
    if (day.mode !== 'times') return { mode: day.mode };
    if (!validTime(day.start) || !validTime(day.end) || day.start === day.end) throw new Error(`${name}: enter different start and finish times, or choose All day.`);
    return { mode: 'times', start: day.start, end: day.end };
  }) };
}

export function availabilityDayText(availability, index) {
  if (!availability) return 'Not set';
  const day = availability.days[index];
  if (day.mode === 'unavailable') return 'Unavailable';
  if (day.mode === 'all_day') return 'All day';
  return `${day.start}–${day.end}${day.end < day.start ? ' (+1 day)' : ''}`;
}

export function hasAvailabilityOnDate(availability, date) {
  if (!availability) return true; // Unset availability does not mean unavailable.
  const index = dayIndex(date), current = availability.days[index], previous = availability.days[(index + 6) % 7];
  return current.mode !== 'unavailable' || previous.mode === 'times' && previous.end < previous.start && previous.end !== '00:00';
}

export function isShiftAvailable(availability, shift) {
  if (!availability || !['work', 'training'].includes(shift.kind || 'work')) return true;
  if (!validTime(shift.start_time) || !validTime(shift.end_time) || shift.start_time === shift.end_time) return true; // Time validation runs separately.
  const start = clock(shift.start_time);
  let end = clock(shift.end_time);
  if (end < start) end += 1440;
  const index = dayIndex(shift.date), windows = [];
  for (const offset of [-1, 0, 1]) {
    const day = availability.days[(index + offset + 7) % 7];
    if (day.mode === 'unavailable') continue;
    const from = day.mode === 'all_day' ? 0 : clock(day.start);
    let until = day.mode === 'all_day' ? 1440 : clock(day.end);
    if (until < from) until += 1440;
    windows.push([offset * 1440 + from, offset * 1440 + until]);
  }
  windows.sort((a, b) => a[0] - b[0]);
  let coveredUntil = start;
  for (const [from, until] of windows) {
    if (until <= coveredUntil) continue;
    if (from > coveredUntil) break;
    coveredUntil = until;
    if (coveredUntil >= end) return true;
  }
  return false;
}

export function availabilityWarning(person, shift) {
  if (!person || isShiftAvailable(person.availability, shift)) return '';
  const index = dayIndex(shift.date);
  const date = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${shift.date}T12:00:00Z`));
  const saved = [`${availabilityDays[index]}: ${availabilityDayText(person.availability, index)}`];
  if (shift.end_time < shift.start_time) saved.push(`${availabilityDays[(index + 1) % 7]}: ${availabilityDayText(person.availability, (index + 1) % 7)}`);
  return `${person.name} · ${date}, ${shift.start_time}–${shift.end_time}${shift.end_time < shift.start_time ? ' (+1 day)' : ''} is outside saved availability (${saved.join('; ')}).`;
}
