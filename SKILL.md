---
name: justcalendar-cli
description: Use this skill when a user needs to install, authenticate, or operate the Just Calendar CLI against https://justcalendar.ai, including generating an agent token in the web UI and performing calendar/day-data management from terminal commands.
---

# JustCalendar CLI Skill

## Purpose

This skill provides complete operational guidance for `justcalendar-cli`, a Node.js CLI that manages Just Calendar data in Google Drive through:

1. Backend-issued Google Drive access tokens from `https://justcalendar.ai`
2. Direct Google Drive API reads/writes for calendar data files

Use this skill for setup, login, troubleshooting, and day-to-day CLI operations.

## When To Use This Skill

Use this skill when user asks to:

- Install or update `justcalendar-cli`
- Login with a token generated in Just Calendar web interface
- Add, list, rename, remove, or select calendars
- Set/get/delete day values from calendars
- Run bulk data operations from terminal
- Troubleshoot token/auth/permission errors

## Prerequisites

- Node.js `>=18`
- `npm`
- Access to `https://justcalendar.ai`
- A Google Drive-connected session in the web app (required to generate token and use Drive-backed operations)

## Installation

From local project path:

```bash
cd ~/justcalendar-cli
npm install
npm install -g .
justcalendar --help
```

If installing from GitHub:

```bash
git clone git@github.com:AndredAlmeida/justcalendar-cli.git
cd justcalendar-cli
npm install
npm install -g .
justcalendar --help
```

## Authentication Workflow (Web -> CLI)

### Step 1: Generate token on website

1. Open `https://justcalendar.ai`
2. Login/connect Google Drive in the app
3. Click **Connect to your Agent** (OpenClaw button)
4. Click **Generate New Token**
5. Copy token immediately

Important:

- Token is shown once
- Generating a new token invalidates the previous token
- If popup says token already exists but hidden, generate a new one to get a visible token

### Step 2: Login CLI with token

```bash
justcalendar login --token <YOUR_TOKEN> --url https://justcalendar.ai
```

Verify:

```bash
justcalendar status
```

Expected status includes backend URL, token state, and current calendars (if authenticated).

## CLI Data Model Notes

- Calendar selector can be **calendar id** or **calendar name**
- Date format is strict `YYYY-MM-DD`
- Data is stored under `JustCalendar.ai` folder in Google Drive
- Main config file: `justcalendar.json`
- Calendar data files: `<account-id>_<calendar-id>.json`
- CLI local config: `~/.justcalendar-cli/config.json`

## Command Reference

### Session / Auth

```bash
justcalendar login --token <TOKEN> --url https://justcalendar.ai
justcalendar logout
justcalendar status
```

### Calendars

```bash
justcalendar calendars list
justcalendar calendars add "Workout" --type score --color red --display heatmap --pinned
justcalendar calendars rename "Workout" "Workout Intensity"
justcalendar calendars remove "Workout Intensity"
justcalendar calendars select "Energy Tracker"
```

Calendar type options:

- `signal-3`
- `score`
- `check`
- `notes`

Color options:

- `green`, `red`, `orange`, `yellow`, `cyan`, `blue`

Score display options (for `score` type):

- `number`, `heatmap`, `number-heatmap`

### Day Data - Set

Single set:

```bash
justcalendar data set "Energy Tracker" 2026-03-01 green
```

Bulk set (multiple `<date> <value>` pairs in one call):

```bash
justcalendar data set "Energy Tracker" 2026-03-01 green 2026-03-02 yellow 2026-03-03 red
```

### Day Data - Delete

Single delete:

```bash
justcalendar data delete "TODOs" 2026-03-01
```

Bulk delete (multiple dates in one call):

```bash
justcalendar data delete "TODOs" 2026-03-01 2026-03-02 2026-03-03
```

### Day Data - Get

Single get:

```bash
justcalendar data get "Sleep" 2026-03-01
```

Bulk get (multiple dates in one call):

```bash
justcalendar data get "Sleep" 2026-03-01 2026-03-02 2026-03-03
```

## Value Rules By Calendar Type

### `signal-3`

Accepted values for `data set`:

- `red`
- `yellow`
- `green`
- `x`
- `clear` / `unset` / `none` (removes value)

### `score`

Accepted values:

- Integers from `-1` to `10`
- `-1` means unset/remove

### `check`

Accepted truthy values:

- `true`, `1`, `yes`, `on`, `checked`

Falsy/unset values:

- `false`, `0`, `no`, `off`, `unchecked`, `clear`, `unset`, `none`

### `notes`

Accepted:

- Any non-empty text string (quote if spaces)

Unset:

- Empty/blank value (or use `data delete`)

## Recommended Operating Sequence

1. Check connectivity:

```bash
justcalendar status
```

2. List calendars:

```bash
justcalendar calendars list
```

3. Apply desired calendar/data changes

4. Re-check specific days:

```bash
justcalendar data get "<Calendar>" <date1> <date2> ...
```

## Troubleshooting

### `Not logged in. Run: justcalendar login ...`

- Run login again with valid token

### `invalid_agent_token` / `missing_agent_token`

- Generate new token in web app popup
- Re-run:

```bash
justcalendar login --token <NEW_TOKEN> --url https://justcalendar.ai
```

### `missing_drive_scope`

- In web app, reconnect Google Drive and approve Drive access (`drive.file`)
- Generate new agent token
- Login again in CLI

### `token_refresh_failed` / `not_connected`

- Drive session on server is expired/disconnected
- Reconnect Google Drive on website, generate new token, and login again

### Date format errors

- Use exact `YYYY-MM-DD`
- Ensure calendar date is valid (for example, `2026-02-30` is invalid)

### Ambiguous calendar name

- Use calendar id from:

```bash
justcalendar calendars list
```

## Safety / Behavior Notes

- `calendars remove` is destructive for that calendar and its associated data file
- Bulk `data set`/`data delete` operations issue a single final write per command invocation
- Keep agent tokens secret; treat like credentials
- Rotate token by generating a new one (old token is invalidated)

## Quick Start Example

```bash
justcalendar login --token jca_... --url https://justcalendar.ai
justcalendar calendars list
justcalendar calendars add "Hydration" --type check --color cyan
justcalendar data set "Hydration" 2026-03-01 true 2026-03-02 true 2026-03-03 false
justcalendar data get "Hydration" 2026-03-01 2026-03-02 2026-03-03
```
