# Warehouse rota update

This update uses the supplied rota reference: slim rows (around 51 px), smaller single-line names, flat shift entries and thin department colour stripes. WH1/WH2 and break times remain visible. It also includes the previous removal of "Default department" labels and manager colleague deletion.

1. Extract warehouse-rota-update.zip.
2. In the existing DoWarehouse/warehouse-rota GitHub repository, open the warehouse-rota folder.
3. Upload the contents of this update's warehouse-rota folder into that existing folder, replacing matching files. Keep the public and test subfolders in the same structure.
4. Commit all uploaded files together.
5. Redeploy the existing dylan-oaks-warehouse-rota service in Render if deployment does not start automatically.

Keep the existing Render configuration, ADMIN_PASSWORD, DATA_DIR and persistent disk. The update ZIP contains no database or credentials, does not change the database schema and does not reset colleagues, saved shifts, publications or the QR link.

To delete: open Colleagues, select the colleague, then Delete colleague and confirm. Delete is also available in Edit colleague. It removes the colleague and all their draft shifts across every week. Published copies remain unchanged until you republish affected weeks. Clearing Active colleague in the edit form archives them while retaining their draft history.

Validation: 27 automated tests passed, including authentication, stale-change protection, deletion across weeks, preserving other colleagues and published snapshots, republishing and restart persistence. Browser checks passed for confirmation/cancellation, desktop and phone layouts and 200% text size.

The new layout was checked with 65 colleagues, a long Unicode name, shared phone views, keyboard shift actions and 200% text size. Full names and roles are available in tooltips and colleague profiles.
