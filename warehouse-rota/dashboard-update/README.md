# Connect the existing warehouse dashboard

The rota is still a review build. This file explains the dashboard change to apply when you are ready; it has not been deployed.

1. Copy `add-rota-integration.mjs` into your existing dashboard project, alongside its `server.mjs`.
2. Run `node add-rota-integration.mjs`. It adds `GET /api/rota-leaderboard`, writes a backup and preserves the current dashboard views and history. It stops without changing the file if the expected structure differs. Re-running it does not add duplicate code.
3. Add `ROTA_API_KEY` to that dashboard's Render environment. Choose a private key containing at least 16 characters. Keep this out of GitHub.
4. Commit the modified `server.mjs` to the dashboard repository when you are ready for that update. Keep the existing dashboard disk, data and Hutch settings.
5. In the rota, open **Settings → Dashboard connection**. Enter the actual dashboard's HTTPS `onrender.com` URL and the same integration key.
6. Open a colleague profile. Names match exactly, ignoring case and extra spaces. Set **Dashboard leaderboard name** when their name differs between systems. Duplicate dashboard names are flagged rather than guessed.

The export includes all Picking and Packing colleagues, including zero totals supplied for those roles. It does not truncate the list to the existing top eight. It reads only the leaderboard, with one request per five minutes shared across profiles. It does not run the dashboard's order counts or cycle-time backfill.

Totals, rank, average per hour and peak hour use the dashboard's values and date. The existing source does not provide an Engraving leaderboard. Missing activity is displayed as unavailable, not zero. A dashboard with the older `/api/dashboard` endpoint can provide its limited top-eight data until the export is installed.

The rota performs these requests on its server, keeping the integration key out of the colleague page. Performance profiles are manager-only. The live connection needs your actual dashboard URL and key; no URL has been guessed or activated in this review build.
