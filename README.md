# Parlay Club

Weekly W/L tracker for the five-man college football + NFL pool. Static site on GitHub Pages, results stored as `results.json` in this repo.

**Live dashboard:** https://sammarrellajr.github.io/parlay-club/
**Admin (Sam only):** https://sammarrellajr.github.io/parlay-club/admin.html

- `index.html` - public dashboard: group record, per-person College and NFL records, standings, week-by-week picks
- `admin.html` - entry screen: tap W or L for each guy, save, edit any past week
- `results.json` - the data
- `app.js` / `styles.css` - shared logic and styling

## Weekly routine

1. Open the admin page
2. Dates default to the most recent Sat/Sun and the label auto-fills as `9/5-9/6 Weekend`
3. Tap W or L next to each name for College and NFL. Pick text is optional
4. Save week

To fix a mistake, scroll to **Logged weeks**, hit **Edit**, change it, save. Every save is a commit, so the full history is recoverable under the Commits tab.

## Admin token

The admin page writes to this repo through the GitHub API and needs a fine-grained personal access token:

1. github.com/settings/personal-access-tokens/new
2. Name: `parlay-club`, Expiration: 1 year
3. Repository access: **Only select repositories** > `parlay-club`
4. Permissions > Repository permissions > **Contents** > **Read and write**
5. Generate, copy, paste into the admin page once

The token is stored in that browser only. Do not share it or the admin URL with the group.

## Notes

- The dashboard reads from raw.githubusercontent and usually refreshes within a minute or two of a save. Hit Refresh if it looks stale.
- To add or remove a player, edit the `players` array in `results.json` directly on GitHub. Existing weeks keep their data.
- To start a new season, rename `results.json` (for example to `results-2026.json`) and commit a fresh empty one.
- The site auto-detects the repo from the Pages URL. If the repo is renamed or moved to a custom domain, fill in `owner` and `repo` at the top of `app.js`.
