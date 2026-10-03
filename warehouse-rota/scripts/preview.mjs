// Fictional data only. This starts a local review app in a fresh temporary folder.
import { createRotaServer, monday, addDays } from '../server.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function createDemoRota(options = {}) {
const dataDir = mkdtempSync(path.join(tmpdir(), 'warehouse-rota-demo-'));
const app = createRotaServer({ dataDir, password: 'preview-only-password', demo: true, seedExamples: false, allowLocalDashboard: true, ...options });
const loc = app.db.prepare('SELECT * FROM locations').get();
const names = ['Alex Reid', 'Jamie Quinn', 'Taylor Kelly', 'Casey Parker', 'Sam Scott', 'Jordan Reid', 'Riley Quinn', 'Morgan Kelly', 'Charlie Parker', 'Hayden Scott'];
const week = monday();
for (const [i, first] of names.entries()) {
  const id = randomUUID();
  const department = i < 4 ? 'Picking' : i < 7 ? 'Engraving' : 'Packing';
  const warehouse = i % 3 === 0 ? 'Warehouse 2' : 'Warehouse 1';
  app.db.prepare('INSERT INTO people (id, name, team, role, contract_minutes, location_id, active, row_order, default_department, is_example) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(id, first, department, i < 3 ? 'Supervisor' : 'Warehouse colleague', 2400, loc.id, 1, i, department);
  for (let day = 0; day < 5; day++) {
    const evening = false;
    const holiday = i === 9 && day === 4;
    app.db.prepare('INSERT INTO shifts (id, person_id, location_id, date, start_time, end_time, break_minutes, kind, label, colour, note, department, warehouse, break_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), id, loc.id, addDays(week, day), holiday ? null : evening ? '14:00' : '08:00', holiday ? null : evening ? '22:00' : day === 4 ? '16:00' : '16:30', holiday ? 0 : 30, holiday ? 'holiday' : 'work', holiday ? 'Holiday' : evening ? 'Evening' : day === 4 ? 'Friday' : 'Day shift', evening ? 'violet' : 'blue', '', holiday ? '' : i === 0 && day === 2 ? 'Engraving' : department, holiday ? '' : warehouse, holiday ? null : ['12:00', '12:30', '13:00'][i % 3]);
  }
}
for (const [name, start, end, colour] of [['Day shift', '08:00', '16:30', 'blue'], ['Friday', '08:00', '16:00', 'blue'], ['Evening', '14:00', '22:00', 'violet']]) {
  app.db.prepare('INSERT INTO templates (id, name, start_time, end_time, break_minutes, kind, colour, break_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), name, start, end, 30, 'work', colour, name === 'Evening' ? '18:00' : '12:00');
}
return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const app = createDemoRota();
const loc = app.db.prepare('SELECT * FROM locations').get();
const port = Number(process.env.PORT || 3000);
app.server.listen(port, '0.0.0.0', () => {
  console.log(`Review app: http://localhost:${port}`);
  console.log('Manager password: preview-only-password');
  console.log(`Colleague view: http://localhost:${port}/rota/${loc.share_token}`);
  console.log('All 10 colleagues and shift times are fictional examples. The demo rota stays private until you publish it. A fresh normal start adds 10 clearly marked example profiles without shifts; edit or archive them and add the rest.');
});
process.on('SIGTERM', () => app.close().then(() => process.exit()));
process.on('SIGINT', () => app.close().then(() => process.exit()));
}
