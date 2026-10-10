# Connect employee history to the existing dashboard

This update puts Picking and Packing readings in individual manager colleague profiles. It keeps the shared rota and weekly grid free of leaderboard information. These files are prepared for your GitHub and Render services; they have not been deployed or connected from this workspace.

## 1. Update the rota

In the existing DoWarehouse/warehouse-rota repository, replace these five files inside the original warehouse-rota folder:

| Supplied file | Existing GitHub destination |
| --- | --- |
| index.html | warehouse-rota/public/index.html |
| app.js | warehouse-rota/public/app.js |
| styles.css | warehouse-rota/public/styles.css |
| server.mjs | warehouse-rota/server.mjs |
| dashboard.mjs | warehouse-rota/lib/dashboard.mjs |

Select individual files inside the extracted upload groups. Upload them into the matching existing GitHub folders. Keep the rota Render Root Directory as warehouse-rota. Deploy the latest commit in dylan-oaks-warehouse-rota after all five files are committed. Keep the existing password, disk and data settings.

## 2. Update the dashboard repository

Open the GitHub repository for your existing warehouse dashboard. Find its existing server.mjs. Upload ONLY add-rota-integration.mjs into that same folder. Commit it to the branch your dashboard service uses. The rota server.mjs belongs to the rota repository.

The helper was checked against your supplied dylan-oaks-warehouse-dashboard-v6-overnight-backfill source. It refuses to change a server whose expected structure differs. It also supports upgrading the earlier supplied integration and repeat builds without duplicate code.

## 3. Set the dashboard integration key in Render

Open your existing DASHBOARD service in Render, then Environment > Add Environment Variable:

- Key: ROTA_API_KEY
- Value: a new private random key, preferably 32 or more characters (minimum 16).

Keep the key out of GitHub and chat. Copy it privately so you can paste the same value into the rota connection form. You can use Save only while setting up the build command; the next deploy will apply it.

## 4. Run the helper during the dashboard build

In the DASHBOARD service, open Settings and edit Build Command. Append:

```
&& node add-rota-integration.mjs
```

For example, an existing npm ci command becomes:

```
npm ci && node add-rota-integration.mjs
```

Preserve any other existing build steps. The command runs in the dashboard's configured root directory, so the helper must sit beside server.mjs there. Keep its existing Start Command, Hutch environment variables and persistent disk.

Use Manual Deploy > Deploy latest commit. The build should report “Added employee history integration” or that it is already installed. If it reports that the dashboard structure differs, it has not overwritten the server; use that service's current server.mjs to prepare a compatible patch.

An alternative local workflow is to run node add-rota-integration.mjs beside the existing dashboard server and commit its modified server.mjs. In that workflow the appended Render build command is unnecessary.

## 5. Save the connection in the rota

Open your rota and sign in. Choose Settings > Dashboard connection:

1. Dashboard URL: the HTTPS onrender.com address of your DASHBOARD service.
2. Integration key: exactly the ROTA_API_KEY value saved on that dashboard.
3. Save connection.

Use the dashboard address, not the rota address. Optional existing DASHBOARD_URL and DASHBOARD_API_KEY rota environment variables override the saved form; update those if you previously configured them.

## 6. View a colleague's previous work

Open Colleagues and select a person, or click their name in the weekly grid. Choose Performance date. A completed shift in the displayed week also has View recorded performance. The initial date is the latest completed shift in that rota week, or today if the week has none.

Names match exactly, ignoring case and extra spaces. Open Edit colleague and set Dashboard name if the two systems use different names. Duplicate dashboard names are flagged rather than assigned to a person.

Only that colleague's Picking and Packing figures are displayed, with weekly totals, averages and anonymous team comparisons in their profile. The date detail also shows the peak hour. Colleagues using the shared QR cannot access profiles or the integration key.

## How historical readings work

The dashboard saves snapshots every five minutes in live mode. The update preserves all supplied Picking and Packing colleagues in FUTURE snapshots, including zero totals explicitly supplied for those roles. It reuses the dashboard's existing reads. Reading an earlier date uses saved snapshots and does not fetch today's data or start order-count or cycle-time jobs.

Older snapshots held selected top-eight lists. The update can read those earlier records, but marks them as partial. It cannot restore colleagues or activity that the dashboard never saved. An empty record is shown as unavailable, never silently converted to zero. Historical data depends on the dashboard's existing history files remaining on its persistent disk.

Readings cover a calendar day. They are linked to a chosen shift date; multiple shifts or an overnight shift are not measured separately. The current source supplies Picking and Packing, with no Engraving performance. The capture time is shown because a final saved snapshot may precede the end of a day.

Protected full history stays on the dashboard server and its key-protected export. The existing public dashboard and public history retain their previous selected-colleague fields. Rota requests are cached per date and connection for five minutes.

## Missing rota shifts

The updated desktop opens Week view. Other weeks open Day view on their first scheduled day, and an empty day explains whether another day has shifts. This does not change any saved assignments.

If the current live rota still counts people but does not display their shifts, choose the affected week and view, then Settings > Download shift display report. This report includes build versions, assignment identifiers, per-day matching counts and rendered shift details. It excludes manager notes, passwords and the dashboard key. It gives the evidence needed to diagnose a live issue that does not occur with the supplied local data.

Render references:
https://render.com/docs/configure-environment-variables
https://render.com/docs/deploys#manual-deploys
https://render.com/docs/monorepo-support
