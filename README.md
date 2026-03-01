# justcalendar-cli

CLI for managing Just Calendar data stored in Google Drive.

## Install

```bash
npm install -g .
```

From this folder:

```bash
cd ~/justcalendar-cli
npm install
npm install -g .
```

## Login

Generate a token in the website Agent Connection popup, then login:

```bash
justcalendar login --token jca_... --url https://justcalendar.ai
```

The CLI stores its local config in:

- `~/.justcalendar-cli/config.json`

## Commands

```bash
justcalendar status
justcalendar calendars list
justcalendar calendars add "Workout" --type score --color red --display heatmap
justcalendar calendars rename "Workout" "Workout Intensity"
justcalendar calendars remove "Workout Intensity"
justcalendar calendars select "Energy Tracker"
justcalendar data set "Energy Tracker" 2026-03-01 green
justcalendar data set "Sleep" 2026-03-01 8
justcalendar data set "Pills" 2026-03-01 true
justcalendar data set "TODOs" 2026-03-01 "Buy vitamins"
justcalendar data delete "TODOs" 2026-03-01
justcalendar data get "Sleep" 2026-03-01
```

## How auth works

- CLI sends the agent token to backend endpoint: `POST /api/auth/google/agent-token/access-token`.
- Backend validates token via stored HMAC(pepper+token).
- Backend returns a Google Drive access token.
- CLI caches it locally until near expiry.
- CLI then talks directly to Google Drive API for read/write/delete operations.

