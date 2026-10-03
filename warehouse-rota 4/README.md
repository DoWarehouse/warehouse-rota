# Dylan Oaks warehouse rota

Deployable Node.js app for GitHub and Render, including timed breaks, cover planning, colleague profiles and published PDF exports. Nothing has been deployed from this workspace.

The normal app starts with one **Warehouse** site and **10 clearly marked example colleagues**, with no shifts, patterns or publications. Edit those records and add the rest of your team. The optional local demo uses 10 fictional colleagues, three example patterns and a private draft of 49 shifts.

## What it does

- Compact weekly rota with fixed colleague names, department headings, search, department and warehouse filters and a day view for phones.
- Set Picking, Engraving or Packing as a colleague’s optional default department.
- Choose the department and Warehouse 1 or Warehouse 2 on each work or training shift. New shifts preselect the colleague’s default; a per-shift change does not change their default.
- Add colleagues individually or import a CSV, including 60+ colleagues at once.
- Delete a colleague from their profile or edit form, with a confirmation step. This removes their record and all draft shifts across every week. Published copies stay unchanged until affected weeks are republished. Archive a colleague instead when you want to retain draft history.
- Set up and edit standard shift patterns; enter manual shifts or adjust a pattern for an individual assignment.
- Set a break start and duration on each shift or pattern. Breaks without a start time remain visibly unconfirmed for cover planning.
- Use **Timeline** to see available staff, exact cover gaps and individual breaks for each department in each warehouse. Choose the day, time window and minimum cover per department. Picking is blue, Engraving purple and Packing teal throughout the rota, timeline and PDFs.
- Open manager-only colleague profiles with their weekly shifts and dashboard leaderboard information after configuring the connection.
- Select colleagues and days to assign shifts in bulk.
- Calculate scheduled hours, unpaid breaks, daily headcount and contracted-hours comparisons.
- Record work, training, holiday and unavailable days. Overlapping assignments are rejected, including shifts across midnight and different locations.
- Copy the previous week. Conflicting assignments and archived colleagues are skipped.
- Save drafts and publish each week when ready. Subsequent edits remain in draft until republished. Unpublish a week to remove public access while keeping the draft.
- Share one stable read-only link and QR code for the full warehouse rota. One QR covers Warehouse 1 and Warehouse 2 and works for each published week. Filters use the department and warehouse assigned to each shift.
- Share or download published PDFs grouped by **Warehouse**, **Department**, **A–Z full rota**, or **A–Z weekly overview**, with optional warehouse and department filters. Private draft changes are excluded.
- Export a rota to CSV, print it, and download a complete data backup.
- Add other sites with a separate rota and QR link. Retail-specific departments can be added in a future build.

## Review it locally first

Install Node.js 24 if it is not already on your computer. Extract this ZIP and open a terminal in the `warehouse-rota` folder.

```bash
npm ci
npm run demo
```

Open **http://localhost:3000**. The demo manager password is **preview-only-password**.

The demo creates a new temporary database each time and starts unpublished. Its shift times and patterns are never loaded by the normal production start command. Normal startup creates only the 10 starter colleagues. Stop the demo with **Ctrl+C**.

For a normal local installation, copy `.env.example` to `.env`, replace the manager password, then run:

```bash
npm ci
node --env-file=.env server.mjs
```

Render supplies environment variables directly and uses `npm start` without an `.env` file.

The QR code in the local demo points to your local computer. Download the live QR after deployment before printing it for colleagues.

## First setup with your own data

1. Open **Colleagues**, edit the 10 example records to your real names and add the rest of your team. Set default departments, roles and weekly contracted hours. Use 0 hours for people without fixed hours. Saving an edited example removes its example label.
2. For a larger list, click **Import CSV** and download the blank template. Save your Excel list as CSV with columns `Name`, `Default department`, `Role`, `Contract hours`. Only `Name` is required. Default department must be `Picking`, `Engraving` or `Packing`, or left blank. Older CSV headings `Department` and `Team` are also accepted for this field. Duplicate names at the selected location are skipped during import; manually add distinct colleagues who share a name.
3. Open **Shift patterns**. Add your usual start, finish, unpaid break duration and optional break start. You can have separate Friday, evening and weekend patterns.
4. Choose a week and click **Assign shifts**. Select colleagues, days and a shift pattern, or enter manual times. Choose Warehouse 1 or Warehouse 2. Use each colleague’s default department, or choose one department for all selected colleagues; if anyone has no default, choose a department before assigning work or training.
5. Click any shift to change or remove it. Clicking an empty day adds a shift for that colleague.
6. Review **Timeline** for cover during breaks, then click **Publish week**. Colleagues see that saved version. To update it, edit the draft and **Publish changes**.
7. Open **Share rota** to copy the shared link, open the colleague view, download the QR or print a QR notice.

Keep Warehouse 1 and Warehouse 2 within the main Warehouse rota: choose them on shifts rather than adding them as separate sites. The QR is tied to the overall location, not a week. Colleagues can move between published weeks and find their name. When there is no published current week, opening the shared link chooses the next published week, or the most recent previous week. Dates are always displayed.

## Access

Managers use one password configured through `ADMIN_PASSWORD`. Sessions last 12 hours. Changing that environment variable and restarting the app invalidates existing sessions.

Colleagues have no accounts. Anyone with the shared link or QR can view the full published rota for that location. They cannot change shifts, see drafts, see manager notes, see contracted hours, access performance profiles, export manager data or access backups. They can download the published PDF. They see names, default departments, roles, shift times, breaks and scheduled totals.

**Reset shared link and QR code** invalidates the existing code. Use it only when you want to replace the link, then print and distribute the new QR.

## GitHub and Render setup — after review

### 1. Put the source on GitHub

1. Create a new **private** GitHub repository, for example `warehouse-rota`.
2. Upload the contents of the `warehouse-rota` folder into the repository root. `package.json`, `package-lock.json`, `server.mjs` and `render.yaml` must be at the top level. Include all source folders, especially `public`, `lib`, `assets`, `scripts` and `test`. The bundled fonts in `assets` are required for PDFs.
3. Include `.node-version`, `.gitignore` and `.env.example` when using Git. Never upload `node_modules`, an actual `.env`, a database or staff data.

If you use a terminal rather than GitHub's upload page:

```bash
git init
git add .
git commit -m "Create warehouse rota"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

Replace `YOUR_GITHUB_REPOSITORY_URL` with the URL from your new repository.

### 2. Deploy with the supplied Render Blueprint

1. In Render, choose **New → Blueprint** and connect the GitHub repository.
2. Render reads `render.yaml`. It creates a separate Node web service and a **1 GB persistent disk** mounted at `/var/data`.
3. Enter a strong manager password, at least 12 characters, for `ADMIN_PASSWORD` when asked.
4. Review the service and disk prices shown by Render before creating the resources. This configuration uses a **paid web service**, because persistent disks require a paid service. It does not create a separate paid database.
5. Deploy, then open the service's `onrender.com` URL. Sign in with the password you chose.
6. Add your real colleagues and shift patterns, publish a week, and download the live warehouse QR.

Keep this service separate from your existing dashboard. The supplied name is `dylan-oaks-warehouse-rota`.

### Connect your existing leaderboard

Follow [dashboard-update/README.md](dashboard-update/README.md). The included patch adds a protected full Picking/Packing leaderboard endpoint to the existing dashboard. Apply it in the dashboard project, set `ROTA_API_KEY` there, then enter the actual dashboard URL and matching key in **Settings → Dashboard connection** in the rota. Optional `DASHBOARD_URL` and `DASHBOARD_API_KEY` environment variables override saved settings.

Names match exactly, ignoring case and extra spaces. Use **Dashboard leaderboard name** in a colleague record when names differ. Results are cached for five minutes. Profiles show totals, rank, average per hour and peak hour, and are manager-only. The current dashboard source has no Engraving leaderboard. Review screenshots use labelled example data; a live connection requires your dashboard URL and key.

### Manual Render setup alternative

| Setting | Value |
| --- | --- |
| Service type | Web Service |
| Runtime | Node |
| Root directory | Leave blank if app files are at the repository root |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check | `/health` |
| Node version | `24.19.0` |
| Instance | A paid instance supporting persistent disks |
| Disk mount path | `/var/data` |
| Disk size | 1 GB |
| `ADMIN_PASSWORD` | Your chosen password, at least 12 characters |
| `DATA_DIR` | `/var/data` |
| `NODE_ENV` | `production` |

Create the persistent disk **before using the app for real rotas**. Saved data is written to `DATA_DIR/rota.sqlite`; the default local folder is `data/`.

Official setup references: [Render persistent disks](https://render.com/docs/disks), [Blueprint specification](https://render.com/docs/blueprint-spec), [Node version settings](https://render.com/docs/node-version).

## Updates and data

Updating code in GitHub can trigger a Render redeploy. Colleagues, shifts, patterns, publications and the QR link remain on the persistent disk. Keep the same disk and `DATA_DIR`; an empty or different database produces a new link and empty data.

One app instance serves all managers and colleagues. Stale edits are rejected if another manager saves first, so the page can reload the latest rota before retrying.

The app checks for a new daily SQLite backup hourly and retains the latest seven daily backups under `DATA_DIR/backups`. **Settings → Download data backup** creates a fresh, consistent SQLite backup immediately. Keep a downloaded copy outside Render as well.

To restore a downloaded backup, stop the app completely, replace `DATA_DIR/rota.sqlite` with the backup, remove the old `rota.sqlite-wal` and `rota.sqlite-shm` files while the app is stopped, then restart. Keep a copy of the current database before restoring. Do not replace a database while the app is running.

Scheduled hours include work and training, less the entered unpaid breaks. Holiday and unavailable entries count as zero scheduled hours. Overnight shifts belong to their start date and show `+1` beside the finish time. Hours use clock duration and do not adjust for daylight-saving clock changes. The app does not calculate payroll, overtime pay or leave entitlement.

When upgrading the original review build, schema version 2 adds colleague defaults and per-shift assignments. Existing names, times, shifts, publications and QR tokens are retained. Recognised old team names become default departments. Existing warehouses are left unset for the manager to choose before republishing; previously published snapshots remain available. A migration backup is kept as `DATA_DIR/backups/rota-before-schema-2.sqlite` when colleague records already exist. Copying a week retains its saved departments and warehouses, including any assignments still awaiting review.

Schema version 3 adds break start times, leaderboard name mappings and example labels. Existing colleagues and rotas are retained; the 10 starters are seeded only into a fresh, empty installation. An existing populated database is backed up before migration as `DATA_DIR/backups/rota-before-schema-3.sqlite`.

The timeline subtracts one scheduled break per work/training shift and flags any break with an unset start. Coverage counts all staff, even when a name search filters the individual rows. Overnight carry-over is included. It is a planning view, not a record of attendance.

## Validation

```bash
npm run check
npm test
```

All 27 automated tests pass, including a 65-colleague/300-shift regression, timed and overnight breaks, exact cover gaps, unknown break starts, per-warehouse coverage, fresh 10-colleague startup, PDF privacy, dashboard matching, caching and duplicate names. Existing publishing, overlap, backup, migration and QR checks remain covered.

Browser checks passed for the 10-colleague demo: break edits, all six warehouse/department timelines, manual and bulk assignments, profile connection settings, four PDF layouts, draft privacy, publication and unpublishing, shared QR, phone layouts and 200% text scaling. No browser JavaScript errors were observed. Review images and four example published PDFs are in `review/`; all names, shift times and profile metrics there are fictional examples.

Optional browser tools are feature-detected and are not needed for normal use. Native WebMCP validation was unavailable in the test browser.

## Update the existing Render deployment

Use `warehouse-rota-update.zip` for the repository already deployed in this conversation. Extract it and upload the files from its `warehouse-rota` folder into the existing **warehouse-rota folder in GitHub**, replacing matching files. In particular, replace `warehouse-rota/public/index.html`, `warehouse-rota/public/app.js` and `warehouse-rota/public/styles.css` together. Commit the files together, then deploy that latest commit in the existing Render service. See `UPDATE-INSTRUCTIONS.md` for the exact destination of every file. The update contains the changed application files, the new deletion test and documentation; it does not replace your Render configuration or environment variables.

The page requests versioned CSS and JavaScript (`compact-20261003`) to refresh browser assets after deployment. A heading that still says "DEFAULT DEPARTMENT" identifies the earlier client version. In the compact version it says just the department name, and shifts use small black times with thin department-colour lines. Check the successful Render deploy's commit if the earlier layout remains; restarting the service keeps its currently deployed commit.

Keep the existing persistent disk, `DATA_DIR` and `ADMIN_PASSWORD`. This update does not change the database schema or reseed colleagues. Existing shifts, publications, dashboard settings and shared QR tokens are retained. The database is not included in either ZIP.

The weekly rota now uses the supplied reference style: flat shift entries, thin department colour stripes, small single-line names, restrained department headers and less space above the table. Typical weekly rows measure about 51 px instead of the original 159 px. Long names and roles retain their full text in tooltips and the colleague profile. Times, WH1/WH2 and breaks remain visible. Day rows remain around 70 px for phone readability. Exact height depends on text size and multiple shifts. The layout was checked with 65 colleagues, a long Unicode name, shared phone views, keyboard shift actions and 200% text size.
