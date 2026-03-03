# justcalendar

`justcalendar` is a CLI for the calendar website [https://justcalendar.ai](https://justcalendar.ai).
It lets you manage calendars and day data from the terminal using your Just Calendar Google Drive connection.

## Install globally

Install from npm:

```bash
npm install -g justcalendar
```

## Run from this repository (development)

From the repository folder:

```bash
cd ~/justcalendar-cli
npm install
npm link
```

This links your local source as a global `justcalendar` command.

## Login

1. Open [https://justcalendar.ai](https://justcalendar.ai).
2. Open **Connect to your Agent**.
3. Generate a token.
4. Login in the CLI:

```bash
justcalendar login --token jca_... --url https://justcalendar.ai
```

The CLI stores local config at:

- `~/.justcalendar-cli/config.json`

## Command reference

### Check status

Shows current login/session details.

```bash
justcalendar status
```

### List calendars

Lists calendars from your connected account.

```bash
justcalendar calendars list
```

### Add a calendar

Creates a new calendar.

```bash
justcalendar calendars add "Workout" --type score --color red --display heatmap
```

### Rename a calendar

Renames an existing calendar.

```bash
justcalendar calendars rename "Workout" "Workout Intensity"
```

### Remove a calendar

Deletes a calendar.

```bash
justcalendar calendars remove "Workout Intensity"
```

### Select the active calendar

Sets which calendar is currently active.

```bash
justcalendar calendars select "Energy Tracker"
```

### Set day values

Set one day:

```bash
justcalendar data set "Energy Tracker" 2026-03-01 green
```

Set multiple days in one command:

```bash
justcalendar data set "Energy Tracker" 2026-03-01 green 2026-03-02 yellow 2026-03-03 red
```

Other calendar types:

```bash
justcalendar data set "Sleep" 2026-03-01 8
justcalendar data set "Pills" 2026-03-01 true
justcalendar data set "TODOs" 2026-03-01 "Buy vitamins"
```

### Delete day values

Delete one day:

```bash
justcalendar data delete "TODOs" 2026-03-01
```

Delete multiple days in one command:

```bash
justcalendar data delete "TODOs" 2026-03-01 2026-03-02 2026-03-03
```

### Get day values

Get one day:

```bash
justcalendar data get "Sleep" 2026-03-01
```

Get multiple days in one command:

```bash
justcalendar data get "Sleep" 2026-03-01 2026-03-02 2026-03-03
```

## How authentication works

- CLI sends your agent token to backend endpoint: `POST /api/auth/google/agent-token/access-token`.
- Backend validates the token using stored `HMAC(pepper+token)`.
- Backend returns a Google Drive access token.
- CLI caches the access token locally until near expiry.
- CLI reads/writes data directly with the Google Drive API.
