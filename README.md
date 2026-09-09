# MacFlare

**Publish your Mac's status with native macOS tools and a Cloudflare Worker.**

[![CI](https://github.com/xw7qwq/macflare/actions/workflows/ci.yml/badge.svg)](https://github.com/xw7qwq/macflare/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Live demo](https://macflare.lucius7.dev/) · [Documentation guide](https://macflare.lucius7.dev/guide) · [Quick start](https://macflare.lucius7.dev/getting-started) · [API reference](https://macflare.lucius7.dev/api) · [Changelog](CHANGELOG.md)

MacFlare supplies music, app, battery, and system status for blogs, Now Pages, and GitHub READMEs. The Mac pushes data out; the public API cannot execute commands on it or request local data.

The Agent uses native Bash, `osascript` (JXA), `curl`, `pmset`, and `launchd`. **No extra runtime or third-party player is required for collection.** Node.js 22+ is only needed for development, deployment, and documentation builds.

## What it includes

- Apple Music state, title, artist, and optional matched Apple artwork; unavailable permissions degrade independently.
- App names with 45 repository-hosted native icons, plus optional macOSicons supplementation. Window titles, document paths, and process arguments are not collected.
- Independent privacy switches, sensitive-app blocking, and a user LaunchAgent with install, update, and uninstall scripts.
- Authenticated uploads, public JSON and SVG APIs, and a status page with documentation on the same Worker. No GitHub Pages deployment is needed.

**Status is public, including short-term activity in buffered mode.** A 15-minute window expires 10 minutes after its end: early events may remain available for about 25 minutes. Local checkpoints can lag, and third parties can retain public data. Review [privacy and retention](https://macflare.lucius7.dev/privacy) before installing.

## Quick start

Use your own Cloudflare account and deployment for each Mac. The [live demo](https://macflare.lucius7.dev/) shows the maintainer's status and is not a shared upload service.

### 1. Deploy the site and API

```sh
git clone https://github.com/xw7qwq/macflare.git
cd macflare
npm ci
npx wrangler login
npx wrangler kv namespace create STATUS_KV
```

Replace the placeholder namespace ID in [wrangler.jsonc](wrangler.jsonc) with the returned ID. Keep the `STATUS_KV` binding name and default settings. Generate a separate ingest token and save it securely:

```sh
openssl rand -hex 32
npx wrangler secret put INGEST_TOKEN
npm run deploy
```

Paste this token into `secret put` and reuse it for the Mac installation. Keep it separate from Cloudflare management credentials and out of Git. [Other authentication methods and domains](https://macflare.lucius7.dev/deployment).

### 2. Preview and install the Agent

Replace `YOUR_HOST` below with the host from your deployment's HTTPS URL, without `/api` or another path:

```sh
/bin/bash agent/macflare.sh --print
/bin/bash scripts/install.sh --endpoint https://YOUR_HOST --profile buffered
curl -sS https://YOUR_HOST/api/timeline
```

Review the preview, then enter the ingest token when prompted. The preview can query Apple but does not upload to the Worker. Music automation may require permission for **bash**. [Adjust privacy and permissions](https://macflare.lucius7.dev/configuration) before starting.

Normal playback begins about **7 minutes after startup**; before the first batch, the page may show no valid window. Verify `batch_seq` and `window_end` advance over two upload cycles. Sampling and network delays can miss changes or pause playback.

## Update profiles

| Profile | Upload interval | Data and display | Scheduled KV writes/day |
| --- | --- | --- | --- |
| **buffered — new-install default** | 300 seconds | 900-second window; normally 420-second delayed playback | About 288 |
| eco | 120 seconds | One snapshot; 180-second TTL | About 720 |
| realtime | 30 seconds | One snapshot; 60-second TTL | About 2,880 |

buffered saves 60% of eco's scheduled writes. Each batch writes one KV key; startup, retries, and other account activity count separately. The page fetches every **60 seconds**, replays locally, and coalesces ordinary display changes over 2 seconds. APIs retain their original timeline semantics.

Native collection uses notifications, a 2-second Music fallback, and 30-second hardware sampling. Windows are bounded to 512 KiB, 2,048 events, and 128 gaps. See [window design and recovery](https://macflare.lucius7.dev/buffering) and [quotas](https://macflare.lucius7.dev/quotas) for detailed policies.

Existing installations retain their profile. **Deploy the Worker before running `scripts/install.sh --profile buffered`**. v1 remains supported; buffered rejects `--once`, so use `--print` or `--observe 30` for inspection. [Migration guide](https://macflare.lucius7.dev/deployment#升级滑动窗口模式).

## API and integrations

Public reads need no token. Each state request reads KV once; request one timeline or complete slice instead of polling all categories together.

| GET route | Returns |
| --- | --- |
| `/api/timeline` | Complete window, events, gaps, and playback policy |
| `/api/now` | Complete status slice; buffered uses server time minus 420 seconds |
| `/api/music` | Playback state, title, artist, and nullable artwork/track URLs |
| `/api/apps/active` | Foreground app name and icon URLs |
| `/api/apps/running` | Running app objects; `null` when not collected |
| `/api/device` | Battery and system load |
| `/api/icons`, `/api/icons/{id}.png` | Native icon catalog and PNGs; no KV access |
| `/api/badge.svg` | SVG status badge for a README |

Prefer static `/app-icons/{id}.png` images to avoid Worker execution. State APIs return `{"status":"offline"}` without a valid record; buffered slices also do so without playback coverage, including warmup or gaps.

[API contract](https://macflare.lucius7.dev/api) · [OpenAPI 3.1](https://macflare.lucius7.dev/openapi.yaml) · [Blog and README examples](https://macflare.lucius7.dev/integrations) · [Icon catalog](https://macflare.lucius7.dev/app-icons) · [Troubleshooting](https://macflare.lucius7.dev/troubleshooting)

## Repository guide

| Location | Responsibility |
| --- | --- |
| [agent/](agent/) | Native collection, private configuration example, and macOS checks |
| [worker/](worker/) | HTTP routing, validation, authentication, and KV access |
| [shared/](shared/) | Window replay, presentation, artwork, and icon helpers |
| [docs/](docs/) | VitePress site, API specification, and published static icons |
| [scripts/](scripts/) | Installation, removal, icon maintenance, and site checks |
| [config/](config/) | Fixed app-icon mappings |
| [test/](test/) and [.github/](.github/) | Automated tests, CI, dependency updates, and contribution templates |

## Contributing and license

The site documentation is in Chinese; repository guidance and new issues/PRs use English. Follow [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through [SECURITY.md](SECURITY.md).

```sh
npm ci
npm test
npm run check
```

Agent changes also require relevant macOS validation; these commands do not verify permissions or production connectivity. See [documentation maintenance](https://macflare.lucius7.dev/documentation) and the [roadmap](https://macflare.lucius7.dev/roadmap).

Code uses the [MIT License](LICENSE). App icons belong to their respective authors and are not covered by that license; optional third-party assets have their own terms. MacFlare is independent of Apple and Cloudflare.
