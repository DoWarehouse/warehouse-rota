import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const palette = { Picking: ['#3157ca', '#edf2ff'], Engraving: ['#8055ad', '#f1edfb'], Packing: ['#247d70', '#e7f5f4'] };
const abbreviations = { Picking: 'PICK', Engraving: 'ENG', Packing: 'PACK' };
const plusDays = (date, n) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dateLabel = date => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
const timeTotal = s => { if (!['work', 'training'].includes(s.kind)) return 0; const m = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)); return (m(s.end_time) - m(s.start_time) + 1440) % 1440 - s.break_minutes; };
const formatHours = n => Number((n / 60).toFixed(2)).toString();
const breakLabel = s => { if (!s.break_minutes) return ''; if (!s.break_start) return `Break ${s.break_minutes}m (time not set)`; const start = Number(s.break_start.slice(0, 2)) * 60 + Number(s.break_start.slice(3)); const end = start + s.break_minutes; return `Break ${s.break_start}-${String(Math.floor(end / 60) % 24).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}${end >= 1440 ? ' +1' : ''}`; };
export function rotaPDF(snapshot, { layout = 'warehouse', warehouse = '', department = '', published_at = '' } = {}) {
  if (!['warehouse', 'department', 'az', 'overview'].includes(layout)) throw new Error('Choose a valid PDF layout.');
  const matchesSelection = s => (!warehouse || s.warehouse === warehouse) && (!department || s.department === department);
  const isAbsence = s => !['work', 'training'].includes(s.kind);
  const selectedIds = new Set(snapshot.shifts.filter(matchesSelection).map(s => s.person_id));
  const shifts = snapshot.shifts.filter(s => matchesSelection(s) || (isAbsence(s) && selectedIds.has(s.person_id)));
  const people = snapshot.people.filter(p => !(warehouse || department) || selectedIds.has(p.id)).sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base', numeric: true }));
  const compact = layout === 'overview';
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true, info: { Title: `Dylan Oaks rota ${snapshot.week}`, Author: 'Dylan Oaks' } });
  doc.registerFont('Rota', path.join(ROOT, 'assets/fonts/DejaVuSans.ttf'));
  doc.registerFont('RotaBold', path.join(ROOT, 'assets/fonts/DejaVuSans-Bold.ttf'));
  const chunks = [];
  const result = new Promise((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const width = doc.page.width - 56, nameWidth = 143, hoursWidth = 39, dayWidth = (width - nameWidth - hoursWidth) / 7;
  let y = 0;
  const txt = (value, x, top, w, size = 8, bold = false, colour = '#172032') => { doc.font(bold ? 'RotaBold' : 'Rota').fontSize(size).fillColor(colour).text(String(value), x, top, { width: w, lineGap: compact ? 0 : 1 }); };
  function pageHeader(group, continuation = false) {
    doc.rect(0, 0, doc.page.width, compact ? 64 : 72).fill('#151b29');
    txt('DYLAN OAKS | WAREHOUSE ROTA', 28, 18, 500, 14, true, '#ffffff');
    txt(`${dateLabel(snapshot.week)} - ${dateLabel(plusDays(snapshot.week, 6))} ${snapshot.week.slice(0, 4)}`, 28, 44, 420, 10, false, '#dde3ec');
    txt('PUBLISHED', doc.page.width - 150, 20, 122, 11, true, '#e7f07b');
    txt(snapshot.people.some(p => p.is_example) ? 'Contains example colleagues' : 'Colleague copy', doc.page.width - 245, 46, 217, 8, false, '#dde3ec');
    txt(`${group}${continuation ? ' (continued)' : ''}`, 28, compact ? 77 : 87, width, 13, true);
    let x = 28;
    for (const [name, [colour]] of Object.entries(palette)) { doc.circle(x + 3, compact ? 107 : 121, 3).fill(colour); txt(`${name}${compact ? ` (${abbreviations[name]})` : ''}`, x + 12, compact ? 102 : 116, 195, 8, true, colour); x += compact ? 195 : 150; }
    if (compact) txt('WH1 = Warehouse 1 | WH2 = Warehouse 2', 28, 121, width, 8);
    else txt('Shift location and timed breaks are shown in each day. +1 means a next-day finish.', 28, 137, width, 8, false, '#647087');
    y = compact ? 137 : 157; doc.rect(28, y, width, 29).fill('#edf0f6'); txt('Colleague (A-Z)', 34, y + 8, nameWidth - 10, 8.5, true);
    for (let i = 0; i < 7; i++) txt(`${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]} ${dateLabel(plusDays(snapshot.week, i))}`, 28 + nameWidth + i * dayWidth + 4, y + 8, dayWidth - 8, 8, true);
    txt('Hours', 28 + width - hoursWidth + 3, y + 8, hoursWidth - 6, 8, true); y += 29;
  }
  function entryText(s) {
    const kindName = { work: 'Work', training: 'Training', holiday: 'Holiday', sick: 'Unavailable', unavailable: 'Unavailable' }[s.kind];
    const label = s.label && !['Shift', kindName].includes(s.label) ? s.label : '';
    if (!['work', 'training'].includes(s.kind)) return [kindName, label].filter(Boolean).join('\n');
    const time = `${s.start_time}-${s.end_time}${s.end_time < s.start_time ? ' +1' : ''}`;
    const assignment = compact ? `${s.warehouse === 'Warehouse 2' ? 'WH2' : s.warehouse === 'Warehouse 1' ? 'WH1' : '?'} | ${abbreviations[s.department] || '?'}` : `${s.department || 'Department unset'}\n${s.warehouse || 'Warehouse unset'}`;
    return [time, s.kind === 'training' ? 'Training' : '', label, assignment, compact ? (s.break_start ? breakLabel(s) : s.break_minutes ? `Break ${s.break_minutes}m - unset` : '') : breakLabel(s)].filter(Boolean).join('\n');
  }
  function row(person, entries, group) {
    const columns = Array.from({ length: 7 }, (_, i) => entries.filter(s => s.date === plusDays(snapshot.week, i)));
    const texts = columns.map(c => c.map(entryText).join('\n\n') || '-');
    doc.font('Rota').fontSize(compact ? 7.4 : 7.6);
    const textHeight = Math.max(...texts.map(t => doc.heightOfString(t, { width: dayWidth - 10, lineGap: compact ? 0 : 1 })), doc.heightOfString(person.name, { width: nameWidth - 12, lineGap: compact ? 0 : 1 }));
    const rowHeight = Math.max(compact ? 38 : 56, textHeight + (compact ? 10 : 14));
    if (y + rowHeight > doc.page.height - 48) { doc.addPage(); pageHeader(group, true); }
    doc.rect(28, y, width, rowHeight).fill('#ffffff');
    txt(person.name, 34, y + 8, nameWidth - 12, 8.2, true);
    if (person.is_example) txt('Example', 34, y + rowHeight - 15, nameWidth - 12, 6.8, false, '#647087');
    for (let i = 0; i < 7; i++) {
      const x = 28 + nameWidth + i * dayWidth;
      const colour = palette[columns[i][0]?.department] || ['#647087', '#fafbfd'];
      doc.rect(x, y, dayWidth, rowHeight).fill(columns[i].length ? colour[1] : '#fafbfd');
      if (columns[i].length) doc.rect(x, y, 2, rowHeight).fill(colour[0]);
      txt(texts[i], x + 5, y + 7, dayWidth - 10, compact ? 7.4 : 7.6, false, '#172032');
    }
    txt(formatHours(entries.reduce((sum, s) => sum + timeTotal(s), 0)), 28 + width - hoursWidth + 4, y + 8, hoursWidth - 7, 8.3, true);
    doc.moveTo(28, y + rowHeight).lineTo(28 + width, y + rowHeight).strokeColor('#dde3ec').lineWidth(0.5).stroke(); y += rowHeight;
  }
  const groups = layout === 'warehouse' ? ['Warehouse 1', 'Warehouse 2'].filter(v => !warehouse || v === warehouse) : layout === 'department' ? ['Picking', 'Engraving', 'Packing'].filter(v => !department || v === department) : [compact ? 'A-Z weekly overview' : 'Full rota - A-Z'];
  let usedPage = false;
  for (const group of groups) {
    const matchesGroup = s => layout === 'warehouse' ? s.warehouse === group : layout === 'department' ? s.department === group : true;
    const ids = new Set(shifts.filter(matchesGroup).map(s => s.person_id));
    const entries = shifts.filter(s => matchesGroup(s) || (isAbsence(s) && ids.has(s.person_id)));
    const rows = people.filter(p => ['az', 'overview'].includes(layout) || ids.has(p.id));
    if (usedPage) doc.addPage(); usedPage = true; pageHeader(group);
    if (!rows.length) { txt('No published assignments for this selection.', 34, y + 18, width - 12, 10); continue; }
    for (const person of rows) row(person, entries.filter(s => s.person_id === person.id), group);
  }
  const pages = doc.bufferedPageRange();
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i);
    txt(`UK local times | Breaks are unpaid | Published ${published_at ? new Date(published_at).toLocaleString('en-GB', { timeZone: 'Europe/London' }) : ''}`, 28, doc.page.height - 40, width - 110, 6.8, false, '#647087');
    txt(`Page ${i + 1} of ${pages.count}`, doc.page.width - 125, doc.page.height - 40, 97, 7, false, '#647087');
  }
  doc.end(); return result;
}
