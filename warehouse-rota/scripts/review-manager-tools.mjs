// Desktop and phone checks use 60 fictional colleagues in an isolated database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRotaServer, monday, today, addDays } from '../server.mjs';

const require = createRequire(import.meta.url), { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), review = path.join(root, 'review');
mkdirSync(review, { recursive: true });
const directory = mkdtempSync(path.join(tmpdir(), 'rota-manager-review-'));
const app = createRotaServer({ dataDir: directory, password: 'manager-review-password', seedExamples: false });
const week = monday(today()), loc = app.db.prepare('SELECT * FROM locations').get(), errors = [];
const weekly = days => ({ days: Array.from({ length: 7 }, (_, i) => days[i] || { mode: 'unavailable' }) });
const people = [['avery', 'Avery Example', 'Picking'], ['blake', 'Blake Example', 'Engraving'], ['casey', 'Casey Example', 'Packing'], ['drew', 'Drew Example', 'Picking'], ['ellis', 'Ellis Example', 'Packing'], ['frankie', 'Frankie Example', 'Engraving'], ['georgie', 'Georgie Example', 'Picking'], ['harper', 'Harper Example', 'Packing']];
for (let i = people.length; i < 60; i++) people.push([`example-${i}`, `Team Example ${String(i + 1).padStart(2, '0')}`, ['Picking','Engraving','Packing'][i % 3]]);
people.forEach(([id, name, department], i) => app.db.prepare('INSERT INTO people (id,name,team,location_id,row_order,default_department,availability) VALUES (?,?,?,?,?,?,?)').run(id, name, department, loc.id, i, department, JSON.stringify(id === 'frankie' ? weekly({}) : id === 'georgie' ? weekly({ 0: { mode: 'all_day' } }) : null)));
const shift = (id, personId, date, department, warehouse, kind = 'work', start = '08:00', end = '16:30', breakMinutes = 30, breakStart = '12:00', holidayMinutes = null, approved = 1) => {
  app.db.prepare('INSERT INTO shifts (id,person_id,location_id,date,start_time,end_time,break_minutes,break_start,kind,label,colour,note,department,warehouse,holiday_minutes,holiday_approved) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, personId, loc.id, date, ['work','training'].includes(kind) ? start : null, ['work','training'].includes(kind) ? end : null, ['work','training'].includes(kind) ? breakMinutes : 0, ['work','training'].includes(kind) ? breakStart : null, kind, kind === 'work' ? 'B2B' : kind === 'training' ? 'Training' : kind[0].toUpperCase() + kind.slice(1), ({Picking:'blue',Engraving:'violet',Packing:'teal'})[department] || 'blue', 'Private example note', department, warehouse, holidayMinutes, approved);
};
shift('avery-engraving','avery',week,'Engraving','Warehouse 2','work','08:00','12:00',0,null);
shift('avery-packing','avery',week,'Packing','Warehouse 1','training','12:00','16:30');
shift('blake-work','blake',week,'Picking','Warehouse 1'); shift('casey-work','casey',week,'Packing','Warehouse 2'); shift('georgie-work','georgie',week,'Picking','Warehouse 1');
shift('drew-sick','drew',week,'Picking','','sick'); shift('ellis-holiday','ellis',week,'Packing','','holiday',null,null,0,null,240);
shift('ellis-future','ellis',addDays(week,7),'Packing','','holiday'); shift('ellis-pending','ellis',addDays(week,8),'Packing','','holiday',null,null,0,null,120,0);
for (const [id,status] of [['blake','no_show'],['casey','checked_in']]) app.db.prepare('INSERT INTO attendance (person_id,location_id,date,status,marked_at) VALUES (?,?,?,?,?)').run(id,loc.id,week,status,new Date().toISOString());
await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.ROTA_REVIEW_CHROMIUM || '/workspace/scratch/13965183c3f3/browser-runtime/chromium', args: ['--no-sandbox','--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage({ viewport: { width:1440,height:1100 },locale:'en-GB' }); page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base); await page.getByLabel('Manager password').fill('manager-review-password'); await page.getByRole('button',{name:'Sign in',exact:true}).click(); await page.locator('.colleague-row').first().waitFor();
  const heights = await page.locator('.colleague-row:not(:has([data-drop-person="avery"]))').evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().height)); assert.ok(Math.max(...heights)<55);
  await page.locator('[data-action="view-day"]').click(); await page.locator('.day-tab[data-day="0"]').click();
  const status = key => page.locator(`.day-dashboard [data-status="${key}"] strong`);
  assert.equal(await status('scheduled').textContent(),'4'); assert.equal(await status('no_show').textContent(),'1'); assert.equal(await status('holiday').textContent(),'1'); assert.equal(await status('sick').textContent(),'1'); assert.equal(await status('unavailable').textContent(),'1');
  const engraving = page.locator('.day-department[data-department="Engraving"]');
  assert.equal(await engraving.locator('.day-person').count(),1); assert.match(await engraving.locator('.day-department-heading').textContent(),/WH1 0 · WH2 1/);
  assert.equal(await engraving.locator('.day-person[data-person="avery"] .person-role').textContent(),'Engraving');
  assert.equal(await page.locator('.day-department[data-department="Packing"] .day-person').count(),2); assert.match(await page.locator('.day-department[data-department="Picking"] .day-department-heading').textContent(),/1 on · 2 scheduled/);
  await page.locator('#team-filter').selectOption('Engraving'); assert.equal(await page.locator('.day-department').count(),1); assert.equal(await status('scheduled').textContent(),'4'); await page.locator('#team-filter').selectOption('');
  await engraving.locator('[data-action="arrival"]').click(); await page.locator('#arrival-time').fill('08:20'); await page.getByRole('button',{name:'Save arrival',exact:true}).click(); await page.locator('#modal').waitFor({state:'hidden'});
  assert.equal(await status('late').textContent(),'1'); assert.equal(await status('checked_in').textContent(),'2'); assert.equal(await page.locator('.day-person[data-person="avery"] .attendance-button.late').count(),2);
  await page.locator('.day-dashboard [data-status="late"]').click(); assert.match(await page.locator('#modal').textContent(),/Avery Example.*08:20.*20m late/); await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.locator('#toast').evaluate(el=>el.style.visibility='hidden'); await page.screenshot({path:path.join(review,'warehouse-rota-manager-day-preview.png'),fullPage:true}); await page.locator('#toast').evaluate(el=>el.style.visibility='');
  const count = () => app.db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n, before = count();
  await page.locator('[data-action="copy-day"]').click(); await page.getByRole('button',{name:'Preview copy',exact:true}).click(); await page.locator('#copy-day-save:not([disabled])').waitFor(); assert.match(await page.locator('#copy-day-preview').textContent(),/4 shifts to copy.*Georgie Example.*Outside saved availability/s); assert.equal(count(),before);
  await page.screenshot({path:path.join(review,'warehouse-rota-copy-day-preview.png')});
  // Cancelling a preview makes no change. A stale preview cannot be committed.
  await page.getByRole('button',{name:'Cancel',exact:true}).click(); assert.equal(count(),before);
  await page.locator('[data-action="copy-day"]').click(); await page.getByRole('button',{name:'Preview copy',exact:true}).click(); await page.locator('#copy-day-save:not([disabled])').waitFor();
  const rev = app.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value;
  assert.equal((await page.request.post(base+'/api/day-plans',{headers:{'X-Rota-Request':'1','If-Match':rev},data:{location_id:loc.id,date:addDays(week,1),requirement_hours:80}})).status(),200);
  const stale = page.waitForResponse(r=>r.url().endsWith('/api/days/copy')); await page.getByRole('button',{name:'Copy shifts to draft',exact:true}).click(); assert.equal((await stale).status(),409); assert.equal(count(),before);
  await page.getByRole('button',{name:'Preview copy',exact:true}).click(); await page.locator('#copy-day-save:not([disabled])').waitFor(); await page.getByRole('button',{name:'Copy shifts to draft',exact:true}).click(); await page.locator('#modal').waitFor({state:'hidden'}); assert.equal(count(),before+4);
  await page.locator('.day-tab[data-day="1"]').click(); assert.equal(await status('no_show').textContent(),'0'); assert.equal(await status('checked_in').textContent(),'0'); assert.equal(await page.locator('.day-list .shift-card').count(),4);
  const copied = app.db.prepare('SELECT * FROM shifts WHERE person_id=? AND date=? ORDER BY start_time').all('avery',addDays(week,1)); assert.equal(copied[0].label,'B2B'); assert.equal(copied[0].warehouse,'Warehouse 2'); assert.equal(copied[1].break_start,'12:00');
  await page.locator('.day-tab[data-day="0"]').click(); await page.locator('.day-dashboard [data-status="holiday"]').click(); await page.locator('#modal [data-action="profile"][data-person="ellis"]').click(); await page.locator('#holiday-settings').waitFor();
  assert.match(await page.locator('#profile-holiday').textContent(),/No entitlement is assumed/); await page.locator('#holiday-settings').click();
  await page.locator('#holiday-day-hours').fill('8'); await page.locator('#holiday-allowance-days').fill('20'); await page.locator('#holiday-carry-days').fill('2'); await page.locator('.holiday-opening summary').click(); await page.locator('#holiday-opening-days').fill('1'); await page.locator('#holiday-tracking-start').fill(week);
  await page.getByRole('button',{name:'Save allowance',exact:true}).click(); await page.locator('.holiday-totals').waitFor();
  assert.match(await page.locator('.holiday-totals').textContent(),/176h22 days.*12h1.5 days.*8h1 days.*156h19.5 days/s); assert.match(await page.locator('#profile-holiday').textContent(),/2h pending approval/);
  await page.locator('#profile-holiday').scrollIntoViewIfNeeded(); await page.screenshot({path:path.join(review,'warehouse-rota-holiday-profile-preview.png')});
  await page.locator('.holiday-bookings summary').click(); await page.locator('[data-edit-holiday="ellis-future"]').click(); await page.locator('#shift-holiday-hours').fill('4'); await page.getByRole('button',{name:'Save changes',exact:true}).click(); await page.locator('#modal').waitFor({state:'hidden'});
  assert.equal(app.db.prepare("SELECT holiday_minutes FROM shifts WHERE id='ellis-future'").get().holiday_minutes,240);
  await page.locator('.day-dashboard [data-status="holiday"]').click(); await page.locator('#modal [data-person="ellis"]').click(); await page.locator('.holiday-totals').waitFor(); assert.match(await page.locator('.holiday-totals').textContent(),/4h0.5 days.*160h20 days/s);
  await page.locator('#holiday-new-year').click(); assert.equal(await page.locator('#holiday-year-start').inputValue(),`${Number(today().slice(0,4))+1}-01-01`); await page.locator('#holiday-back').click(); await page.locator('.holiday-totals').waitFor();
  for(const width of [390,320]) {
    await page.setViewportSize({width,height:844}); assert.equal(await page.locator('#modal').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
    await page.locator('#holiday-settings').click(); assert.equal(await page.locator('#modal').evaluate(el=>el.scrollWidth>el.clientWidth+1),false); await page.locator('#holiday-back').click(); await page.locator('.holiday-totals').waitFor();
    await page.getByRole('button',{name:'Done',exact:true}).click(); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    assert.equal(await page.locator('.day-dashboard .day-status').count(),8); await page.locator('[data-action="copy-day"]').click(); await page.getByRole('button',{name:'Preview copy',exact:true}).click(); await page.locator('#copy-day-preview h3').waitFor(); assert.equal(await page.locator('#modal').evaluate(el=>el.scrollWidth>el.clientWidth+1),false); await page.getByRole('button',{name:'Cancel',exact:true}).click();
    if(width===390) { await page.locator('#toast').evaluate(el=>el.style.visibility='hidden'); await page.screenshot({path:path.join(review,'warehouse-rota-manager-phone-preview.png'),fullPage:true}); await page.locator('#toast').evaluate(el=>el.style.visibility=''); }
    await page.locator('.day-dashboard [data-status="holiday"]').click(); await page.locator('#modal [data-person="ellis"]').click(); await page.locator('.holiday-totals').waitFor();
  }
  await page.getByRole('button',{name:'Done',exact:true}).click(); await page.locator('[data-action="publish"]').click(); await page.getByRole('button',{name:'Publish rota',exact:true}).click(); await page.locator('#modal').waitFor({state:'hidden'});
  const publicPage=await browser.newPage({viewport:{width:390,height:844}}); publicPage.on('pageerror',e=>errors.push(e.message)); await publicPage.goto(base+'/rota/'+loc.share_token+'?week='+week); await publicPage.locator('.day-view').waitFor();
  assert.equal(await publicPage.locator('.day-dashboard,.profile-holiday,[data-action="copy-day"],[data-action="arrival"]').count(),0); assert.equal(await publicPage.locator('.day-department').count(),4);
  const shared=await (await publicPage.request.get(base+'/api/public/'+loc.share_token+'?week='+week)).json(); assert.equal(shared.attendance,undefined); for(const s of shared.shifts){assert.equal(s.holiday_minutes,undefined);assert.equal(s.holiday_approved,undefined);} assert.deepEqual(errors,[]);
  console.log(JSON.stringify({fictionalColleagues:60,assignedDepartmentGroups:true,warehouseCounts:true,dashboardUniqueCounts:true,arrivalRecorded:true,copyPreviewAndCancel:true,staleCopyRejected:true,holidayBalances:true,partialHolidayHours:true,phoneWidths:[390,320],weeklySingleShiftRowMax:Math.max(...heights),privateManagerData:true,browserErrors:0}));
} finally { await browser.close(); await app.close(); rmSync(directory,{recursive:true,force:true}); }
