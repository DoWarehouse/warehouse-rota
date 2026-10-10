// Leave allowances are entered by the manager; this does not calculate entitlement.
export function holidayBalance(account, shifts, currentDate) {
  const bookings = shifts.filter(s => s.kind === 'holiday' && s.date >= account.year_start && s.date <= account.year_end)
    .map(s => ({ ...s, leave_minutes: s.holiday_minutes ?? account.day_minutes, included: s.date >= account.tracking_start, approved: s.holiday_approved !== 0 }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const included = bookings.filter(s => s.included && s.approved);
  const taken = account.opening_taken_minutes + included.filter(s => s.date <= currentDate).reduce((total, s) => total + s.leave_minutes, 0);
  const booked = included.filter(s => s.date > currentDate).reduce((total, s) => total + s.leave_minutes, 0);
  const pending = bookings.filter(s => s.included && !s.approved).reduce((total, s) => total + s.leave_minutes, 0);
  const total = account.allowance_minutes + account.carry_minutes;
  return { total_minutes: total, taken_minutes: taken, booked_minutes: booked, pending_minutes: pending, remaining_minutes: total - taken - booked, bookings };
}
