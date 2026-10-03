# Warehouse rota update

This update uses the supplied rota reference: slim rows (around 51 px), smaller single-line names, flat shift entries and thin department colour stripes. WH1/WH2 and break times remain visible. It also includes the previous removal of "Default department" labels and manager colleague deletion. The page now requests versioned CSS and JavaScript to refresh browser copies after deployment.

The latest supplied screenshot still shows the earlier layout: "DEFAULT DEPARTMENT: PICKING", a separate "Shift" line and large coloured cards. Those elements are absent from the compact layout. Updating the files and deploying the new commit is necessary; a browser refresh alone cannot replace older deployed files.

1. Extract warehouse-rota-update.zip.
2. In the existing DoWarehouse/warehouse-rota GitHub repository, open the warehouse-rota folder.
3. Replace the existing files at the paths in the table below. Use the extracted files, with public and test kept as subfolders.
4. Commit all uploaded files together.
5. In the existing dylan-oaks-warehouse-rota service in Render, use Manual Deploy > Deploy latest commit if deployment does not start automatically. Wait until that deploy succeeds, then reopen the rota. Restart service keeps the currently deployed commit, so it will not apply newer GitHub files.

All paths below are relative to the GitHub repository root:

| Extracted file | Existing GitHub path to replace |
| --- | --- |
| warehouse-rota/public/index.html | warehouse-rota/public/index.html |
| warehouse-rota/public/app.js | warehouse-rota/public/app.js |
| warehouse-rota/public/styles.css | warehouse-rota/public/styles.css |
| warehouse-rota/server.mjs | warehouse-rota/server.mjs |
| warehouse-rota/test/deletion.test.mjs | warehouse-rota/test/deletion.test.mjs |
| warehouse-rota/README.md | warehouse-rota/README.md |
| warehouse-rota/UPDATE-INSTRUCTIONS.md | warehouse-rota/UPDATE-INSTRUCTIONS.md |

The three files under public must all be replaced. They belong directly inside the existing warehouse-rota/public folder.

To verify the update, the department heading should say "PICKING", with no "DEFAULT DEPARTMENT" prefix. Shifts should show small black times, a thin department-colour line, WH1/WH2 and compact break details. If the earlier heading remains, check that the successful Render deploy uses your new GitHub commit. As a technical check, View Page Source should contain compact-20261003 and the versioned /styles.css and /app.js URLs.

Render deployment reference: https://render.com/docs/deploys#manual-deploys

Keep the existing Render configuration, ADMIN_PASSWORD, DATA_DIR and persistent disk. The update ZIP contains no database or credentials, does not change the database schema and does not reset colleagues, saved shifts, publications or the QR link.

To delete: open Colleagues, select the colleague, then Delete colleague and confirm. Delete is also available in Edit colleague. It removes the colleague and all their draft shifts across every week. Published copies remain unchanged until you republish affected weeks. Clearing Active colleague in the edit form archives them while retaining their draft history.

Validation: 27 automated tests passed, including authentication, stale-change protection, deletion across weeks, preserving other colleagues and published snapshots, republishing and restart persistence. Browser checks passed for confirmation/cancellation, desktop and phone layouts and 200% text size.

The new layout was checked with 65 colleagues, a long Unicode name, shared phone views, keyboard shift actions and 200% text size. Timed and untimed breaks remain compact at desktop and narrower widths. The grid uses "Break 30m · unset" for a break whose start is unset; its full description remains in the shift tooltip and editor. Full names and roles are available in tooltips and colleague profiles.
