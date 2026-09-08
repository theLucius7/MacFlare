# MacFlare

**Capture Mac status changes with native macOS tools, upload them in batches, and replay them with a short delay.**

[![CI](https://github.com/xw7qwq/macflare/actions/workflows/ci.yml/badge.svg)](https://github.com/xw7qwq/macflare/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Status and docs](https://macflare.lucius7.dev/) · [Quick start](https://macflare.lucius7.dev/getting-started) · [API](https://macflare.lucius7.dev/api) · [Changelog](CHANGELOG.md) · [Security reports](SECURITY.md)

MacFlare provides Apple Music tracks, the foreground app, running GUI apps, battery information, and system load for personal blogs, Now Pages, and GitHub READMEs. The Mac only pushes data out; there is no public channel for executing commands on the Mac or fetching local data.

The Mac runtime uses only the system's Bash, `osascript`, `curl`, `pmset`, and `launchd`, **with no Node.js, Python, jq, Homebrew, pm2, or third-party player required**. Node.js 22+ is used only for development, cloud deployment, and documentation builds.

## Features

| Feature | Behavior |
| --- | --- |
| Apple Music | Playing, paused, or stopped state, track title, and artist; degrades independently when permission is unavailable |
| Home page artwork | Prefers Apple artwork looked up and reported by the Mac; retains the browser lookup fallback when a valid URL is missing |
| App status | Foreground app and GUI app list; does not collect window titles, paths, or process arguments |
| App icons | Native PNGs in the repository, a public image API, and direct static links; optional macOSicons supplementation and placeholders for unknown apps |
| Hardware status | Battery level, charging state, power source, and system load averages |
| Privacy controls | Sensitive-app blocking, additional blocklist entries, and independent collection switches |
| Native background service | A persistent native JXA collector managed by a user LaunchAgent; installable, updatable, and removable |
| Edge API | Bearer-authenticated batches, sliding timelines and music/app/device slices, SVG badges, and automatic expiration |
| Integrated documentation | Delayed playback with less frequent visual switching, static documentation, and API routes under `/api/*` |

The Mac uses native `curl` to query Apple's public catalog. Reliably matched artwork and track URLs are sent as optional `music` fields in the existing window or snapshot, without separate KV writes. The Worker validates and returns the reported data; it does not query Apple. The home page prefers reported artwork and falls back to browser lookup when a valid URL is missing. It shows a placeholder without a reliable match and removes artwork when the displayed playback state stops or its valid coverage ends. [Artwork privacy and caching](docs/privacy.md#首页歌曲封面)

App icons prefer PNGs exported from installed apps and published with a finite catalog in the repository. `GET /api/icons` returns the catalog, and `/api/icons/<id>.png` can be used directly as an image URL. The home page uses static `/app-icons/<id>.png` paths that do not execute the Worker. Native icons need no third-party key, have no 30-day expiration limit, and do not depend on the Mac being online or on KV. macOSicons remains an optional supplement synchronized before deployment; its response cache separately follows the 30-day limit. [Export, integration, and copyright](docs/app-icons.md)

## Update profiles and free quotas

| Profile | Collection and upload | Public display | Scheduled writes per full day |
| --- | --- | --- | --- |
| **buffered (default for new installations)** | Notifications first; Music fallback every 2 seconds, hardware every 30 seconds; upload the latest 900-second window every 300 seconds | Normally 420 seconds behind; short bursts are coalesced on the home page | About 288 |
| eco | Collect and upload a snapshot every 120 seconds | Snapshot with a 180-second TTL | About 720 |
| realtime | Collect and upload a snapshot every 30 seconds | Snapshot with a 60-second TTL | About 2,880 |

buffered uses **60% fewer scheduled writes than eco** and 90% fewer than realtime. App switches, track changes, and pauses are recorded locally as field changes, then sent together with a baseline and any observation gaps. Each batch writes one KV key. The home page fetches a window every minute and replays it in memory; individual display changes do not trigger network requests. App, music, and running-app displays normally switch at most once every 2 seconds, keeping only the latest candidate in a short burst. The timeline and status APIs do not apply this visual coalescing. The coalesced display is for rendering, not an exact snapshot of one replay timestamp. [Window timing and recovery](docs/buffering.md)

Observed app and Music changes enter the ordered in-memory window immediately. Ordinary private checkpoints combine writes over 10 seconds, with a 30-second coverage heartbeat when nothing changes; startup, sleep, privacy changes, and upload boundaries save immediately. A crash can lose roughly the latest 10 seconds of unsaved ordinary events. This is not a lossless power-failure log.

Hardware sampling remains every 30 seconds. Battery events use integer percentage or power-state changes. System load is recorded when any value changes by at least `max(0.20, 5% of the last recorded value)`; smaller real changes are recorded at the next successful sample once 120 seconds have elapsed since the last recorded system value. This normally takes about 2 minutes and can include another sampling interval or task delay. Transitions to or from `null` are recorded immediately. Tiny intermediate load fluctuations are not all retained.

Each local window spans up to 15 minutes of activity with private file permissions. A saved checkpoint can lag the in-memory window by roughly 10 seconds of changes or 30 seconds of quiet coverage, plus scheduling delays; its oldest data is not physically deleted at an exact 15-minute wall-clock age. Cloud data expires at the window's end plus 10 minutes, so the earliest event can remain available in that window for about 25 minutes. This is a short activity buffer, not a permanent history database. Privacy or blocklist changes clear the local queue and start a new session. The home page immediately clears old displays on masking, field clearing, stopped or unavailable music, removed running-app entries, gaps, offline states, or a new session instead of waiting for the ordinary 2-second visual cadence. Artwork added to the same track can appear immediately. [Privacy and retention](docs/privacy.md)

Normal first playback begins about 7 minutes after startup. Before the first batch arrives, the page may show no valid window; once it arrives, the page can show a warmup countdown. Notifications, sampling, connectivity, and KV propagation can delay or miss changes. Gaps are shown explicitly, and playback pauses or resumes according to available coverage; it does not fabricate unobserved activity.

Existing installations retain their profile and require an explicit `--profile buffered` migration. The 288-write figure is a scheduled estimate: startup, manual operations, retries, tests, and other projects on the account count separately. There is no account-wide quota enforcement or automatic plan upgrade. [Quotas and switching profiles](docs/quotas.md)

## Quick start

### 1. Deploy your own Worker

```sh
git clone https://github.com/xw7qwq/macflare.git
cd macflare
npm ci
npx wrangler login
npx wrangler kv namespace create STATUS_KV
```

Put the returned namespace ID in `kv_namespaces` in `wrangler.jsonc`, keeping the default `STATUS_TTL_SECONDS: "180"` for compatible eco snapshots. buffered uses its own fixed window expiration policy. Generate a separate ingest token, save it in a password manager, then set the secret and deploy:

```sh
openssl rand -hex 32
npx wrangler secret put INGEST_TOKEN
npm run deploy
```

`secret put` prompts for the token; `deploy` builds and publishes the site and API together. See the [deployment guide](docs/deployment.md) for existing Cloudflare API tokens, custom domains, and permissions. Keep Cloudflare management credentials separate from `INGEST_TOKEN`.

### 2. Preview and install on your Mac

```sh
/bin/bash agent/macflare.sh --print
/bin/bash scripts/install.sh --endpoint https://<worker>.<subdomain>.workers.dev --profile buffered
```

Replace the address with **your own deployment's root domain**, without `/api`, and enter the same ingest token when prompted. Allow Music automation in macOS; the background host may appear as **bash**. Verify the background cycle even after a successful preview. [Configuration and permissions](docs/configuration.md)

### 3. Read the status

```sh
curl -sS https://<worker>.<subdomain>.workers.dev/api/timeline
```

The response contains a replayable window when available, or `{"status":"offline"}` without a valid record. The individual status endpoints may still be offline during warmup or observation gaps. Reads require no token; websites must not hold the ingest secret. [Blog and README integration examples](docs/integrations.md)

| Query | Route | Main content while online |
| --- | --- | --- |
| Continuous playback, recommended for dynamic views | `/api/timeline` | A complete window, events, gaps, and policy; fetch once every 60 seconds |
| One complete status slice | `/api/now` | buffered projects server time minus 420 seconds; older profiles return snapshots |
| Music | `/api/music` | Playback state, title, artist, and nullable Apple artwork/track URLs |
| Foreground app | `/api/apps/active` | App name, static icon URL, and image API URL |
| Running apps | `/api/apps/running` | An array of app objects; `null` when not collected |
| Device | `/api/device` | Battery information and system load |

Each status GET reads KV once. Dynamic views should fetch one `/api/timeline` per refresh; simple views can fetch `/api/now` once instead of polling every category endpoint in parallel. The music endpoint returns URLs reported by the Mac, or `null` when an older Agent does not report them. The home page makes no additional `/api/music` call. [Common curl and image examples](docs/integrations.md#按需选择接口)

When updating an existing deployment, **deploy the Worker with `/api/batch` support before running `scripts/install.sh --profile buffered`**. The new Worker continues to accept old snapshots. In buffered configurations, `--once` and the default single-push command are rejected to prevent an accidental v1 snapshot from replacing the timeline; use `--print` for a preview or `--observe 30` for temporary collection statistics. See the [deployment guide](docs/deployment.md#升级滑动窗口模式) for migration and verification.

## Live instance

Maintainer instance: [Status and docs](https://macflare.lucius7.dev/) · [Timeline JSON](https://macflare.lucius7.dev/api/timeline) · [SVG badge](https://macflare.lucius7.dev/api/badge.svg). These addresses expose the maintainer's public status and are not a shared ingest service for other devices.

## Documentation and contributions

The documentation site is currently in Chinese. Please use English for pull requests and follow the repository contribution guidelines.

- [Quick start](docs/getting-started.md), [Deployment and domains](docs/deployment.md), [Local configuration](docs/configuration.md)
- [HTTP API](docs/api.md), [OpenAPI 3.1](docs/openapi.yaml), [Integration examples](docs/integrations.md), [App icons](docs/app-icons.md)
- [Sliding windows and delayed playback](docs/buffering.md), [Free quotas](docs/quotas.md), [Architecture](docs/architecture.md), [Privacy](docs/privacy.md), [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md), [Code of conduct](CODE_OF_CONDUCT.md), [Roadmap](docs/roadmap.md)

```sh
npm ci
npm test
npm run check
```

CI validates the Worker, native macOS scripts, documentation build, and deployment preflight. Documentation and the API are published together by the Cloudflare Worker, without GitHub Pages. [Documentation maintenance](docs/documentation.md)

Code is licensed under the [MIT License](LICENSE). App icons belong to their respective software authors and are not covered by the MIT license. MacFlare is an independent open-source project with no affiliation to Apple or Cloudflare.
