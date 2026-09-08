# MacFlare

**Push your Mac's current status to Cloudflare using native macOS tools.**

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
| Native background service | An installable, updatable, and removable LaunchAgent that runs after user login |
| Edge API | Bearer-authenticated writes, full snapshots and music/app/device queries, SVG badges, and automatic expiration |
| Integrated documentation | A live snapshot on the home page, static documentation, and API routes under `/api/*` |

The Mac uses native `curl` to query Apple's public catalog. Reliably matched artwork and track URLs are sent as optional `music` fields in the existing snapshot, without additional KV writes. The Worker validates and returns the reported data; it does not query Apple. The home page prefers reported artwork and falls back to browser lookup when a valid URL is missing. It shows a placeholder without a reliable match and removes artwork when playback stops or the snapshot expires. [Artwork privacy and caching](docs/privacy.md#首页歌曲封面)

App icons prefer PNGs exported from installed apps and published with a finite catalog in the repository. `GET /api/icons` returns the catalog, and `/api/icons/<id>.png` can be used directly as an image URL. The home page uses static `/app-icons/<id>.png` paths that do not execute the Worker. Native icons need no third-party key, have no 30-day expiration limit, and do not depend on the Mac being online or on KV. macOSicons remains an optional supplement synchronized before deployment; its response cache separately follows the 30-day limit. [Export, integration, and copyright](docs/app-icons.md)

## Update profiles and free quotas

| Profile | Reporting interval | Worker TTL | Scheduled writes per full day |
| --- | --- | --- | --- |
| **eco (default for new installations)** | 120 seconds | 180 seconds | About 720 |
| realtime | 30 seconds | 60 seconds | About 2,880 |

eco uses **75%** fewer writes than realtime, leaving about 280 writes within the free KV allowance of 1,000 writes per day. Manual pushes, login startup, tests, and other projects on the same account count separately; this is not enforced quota protection. Older configurations without `profile` retain realtime, so upgrades require an explicit switch. [Quotas and switching profiles](docs/quotas.md)

Freshness and quota savings involve a tradeoff: eco can take about 3 minutes to report an offline state. KV is eventually consistent, so reads across edge locations may briefly show an older value or an offline state. [Architectural limits](docs/architecture.md)

## Quick start

### 1. Deploy your own Worker

```sh
git clone https://github.com/xw7qwq/macflare.git
cd macflare
npm ci
npx wrangler login
npx wrangler kv namespace create STATUS_KV
```

Put the returned namespace ID in `kv_namespaces` in `wrangler.jsonc`, keeping the default `STATUS_TTL_SECONDS: "180"`. Generate a separate ingest token, save it in a password manager, then set the secret and deploy:

```sh
openssl rand -hex 32
npx wrangler secret put INGEST_TOKEN
npm run deploy
```

`secret put` prompts for the token; `deploy` builds and publishes the site and API together. See the [deployment guide](docs/deployment.md) for existing Cloudflare API tokens, custom domains, and permissions. Keep Cloudflare management credentials separate from `INGEST_TOKEN`.

### 2. Preview and install on your Mac

```sh
/bin/bash agent/macflare.sh --print
/bin/bash scripts/install.sh --endpoint https://<worker>.<subdomain>.workers.dev --profile eco
```

Replace the address with **your own deployment's root domain**, without `/api`, and enter the same ingest token when prompted. Allow Music automation in macOS; the background host may appear as **bash**. Verify the background cycle even after a successful preview. [Configuration and permissions](docs/configuration.md)

### 3. Read the status

```sh
curl -sS https://<worker>.<subdomain>.workers.dev/api/now
```

The response contains structured status while online, or `{"status":"offline"}` when no fresh snapshot is available. Reads require no token; websites must not hold the ingest secret. [Blog and README integration examples](docs/integrations.md)

| Query | Route | Main content while online |
| --- | --- | --- |
| Full status, recommended for combined views | `/api/now` | One complete snapshot; existing fields remain, with optional paired artwork/track URLs for music |
| Music | `/api/music` | Playback state, title, artist, and nullable Apple artwork/track URLs |
| Foreground app | `/api/apps/active` | App name, static icon URL, and image API URL |
| Running apps | `/api/apps/running` | An array of app objects; `null` when not collected |
| Device | `/api/device` | Battery information and system load |

Each status GET reads KV once. When you need several categories, request `/api/now` once instead of polling every category endpoint in parallel. The music endpoint returns URLs reported by the Mac, or `null` when an older Agent does not report them. The home page makes no additional `/api/music` call. [Common curl and image examples](docs/integrations.md#按需选择接口)

When updating an existing deployment, **deploy the Worker with optional music URL support before reinstalling the Mac Agent**; an older Worker rejects the new fields. See the [deployment guide](docs/deployment.md#升级音乐封面上报) for the upgrade steps.

## Live instance

Maintainer instance: [Status and docs](https://macflare.lucius7.dev/) · [JSON](https://macflare.lucius7.dev/api/now) · [SVG badge](https://macflare.lucius7.dev/api/badge.svg). These addresses expose the maintainer's public status and are not a shared ingest service for other devices.

## Documentation and contributions

- [Quick start](docs/getting-started.md), [Deployment and domains](docs/deployment.md), [Local configuration](docs/configuration.md)
- [HTTP API](docs/api.md), [OpenAPI 3.1](docs/openapi.yaml), [Integration examples](docs/integrations.md), [App icons](docs/app-icons.md)
- [Free quotas](docs/quotas.md), [Architecture](docs/architecture.md), [Privacy](docs/privacy.md), [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md), [Code of conduct](CODE_OF_CONDUCT.md), [Roadmap](docs/roadmap.md)

```sh
npm ci
npm test
npm run check
```

CI validates the Worker, native macOS scripts, documentation build, and deployment preflight. Documentation and the API are published together by the Cloudflare Worker, without GitHub Pages. [Documentation maintenance](docs/documentation.md)

Code is licensed under the [MIT License](LICENSE). App icons belong to their respective software authors and are not covered by the MIT license. MacFlare is an independent open-source project with no affiliation to Apple or Cloudflare.
