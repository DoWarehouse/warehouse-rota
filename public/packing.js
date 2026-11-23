// Packing positions belong to a shift, never to a colleague's profile.
export const isPackingShift = shift => shift?.department === 'Packing' && ['work', 'training'].includes(shift.kind);
export function packingPositionLabel(shift, stations = []) {
  if (!isPackingShift(shift) || !shift.packing_station_id || !['A', 'B'].includes(shift.packing_position)) return '';
  const station = stations.find(item => item.id === shift.packing_station_id);
  return station ? `${station.number}${shift.packing_position}` : '';
}
export function packingIntervalsOverlap(a, b) {
  const window = shift => {
    const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const day = Date.parse(`${shift.date}T00:00:00Z`) / 60000;
    const start = minutes(shift.start_time), end = minutes(shift.end_time);
    return [day + start, day + end + (end < start ? 1440 : 0)];
  };
  if (!isPackingShift(a) || !isPackingShift(b)) return false;
  const [as, ae] = window(a), [bs, be] = window(b);
  return as < be && bs < ae;
}
