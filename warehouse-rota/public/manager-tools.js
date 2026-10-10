import { hasAvailabilityOnDate } from './availability.js';

const working = shift => ['work', 'training'].includes(shift.kind);

// These categories overlap: late arrivals are included in checked in.
export function managerDaySummary(people, shifts, attendance, date, locationId) {
  const entries = shifts.filter(s => s.date === date && s.location_id === locationId);
  const scheduled = new Set(entries.filter(working).map(s => s.person_id));
  const records = attendance.filter(a => a.date === date && a.location_id === locationId && scheduled.has(a.person_id));
  const holiday = new Set(entries.filter(s => s.kind === 'holiday').map(s => s.person_id));
  const sick = new Set(entries.filter(s => s.kind === 'sick').map(s => s.person_id));
  const unavailable = new Set(entries.filter(s => s.kind === 'unavailable').map(s => s.person_id));
  for (const p of people) {
    if ((p.active && p.location_id === locationId || entries.some(s => s.person_id === p.id)) && !holiday.has(p.id) && !sick.has(p.id) && !hasAvailabilityOnDate(p.availability, date)) unavailable.add(p.id);
  }
  return {
    scheduled: [...scheduled], checked_in: records.filter(a => a.status === 'checked_in').map(a => a.person_id),
    late: records.filter(a => a.status === 'checked_in' && a.is_late).map(a => a.person_id),
    no_show: records.filter(a => a.status === 'no_show').map(a => a.person_id),
    holiday: [...holiday], sick: [...sick], unavailable: [...unavailable],
    unmarked: [...scheduled].filter(id => !records.some(a => a.person_id === id))
  };
}

export function arrivalDetails(shift, arrivalDate, arrivalTime) {
  const clock = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const midnight = Date.parse(`${shift.date}T00:00:00Z`) / 60000;
  const start = midnight + clock(shift.start_time);
  let end = midnight + clock(shift.end_time);
  if (end < start) end += 1440;
  const arrival = Date.parse(`${arrivalDate}T00:00:00Z`) / 60000 + clock(arrivalTime);
  if (arrival < midnight || arrival >= end) throw new Error('Arrival must be on the shift date (or next day for an overnight shift) and before the first shift finishes.');
  return { is_late: arrival > start ? 1 : 0, late_minutes: Math.max(0, arrival - start) };
}
