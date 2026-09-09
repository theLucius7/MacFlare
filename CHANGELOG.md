# Changelog

This file records implemented changes that have not yet been assigned to a formal release. `Unreleased` is not a published version; maintainers will add confirmed versions and dates when releasing.

## Unreleased

### Added

- Native Bash/JXA collection for Apple Music, foreground and running GUI apps, battery, and system load, with independent privacy controls, sensitive-app filtering, and user LaunchAgent installation and removal.
- buffered collection and v2 sliding windows: a baseline, ordered changes, sessions, and explicit observation gaps, uploaded every 300 seconds in one KV write. Windows span up to 900 seconds, with limits of 512 KiB, 2,048 events, and 128 gaps. Privacy changes clear the pending queue and start a new session.
- Authenticated `POST /api/batch` and public `GET /api/timeline`. Windows expire at their end plus 600 seconds; the existing status and badge APIs project server time minus 420 seconds and return offline without valid coverage.
- Public music, foreground-app, running-app, and device endpoints alongside `/api/now`, `/api/badge.svg`, and `/api/health`. Legacy root routes remain available without redirects; v1 snapshots retain server-controlled TTLs and their original expiration deadlines.
- Native Apple artwork lookup and bounded caching on the Mac, with paired optional artwork/track URLs included in ordinary uploads. The Worker does not query Apple; the page retains a browser fallback for missing matches.
- A native PNG app-icon catalog with localized aliases, static links, and `/api/icons` image routes supporting HEAD, conditional requests, and one-hour caching without KV access. The exporter supports 128 mappings and user application directories; optional macOSicons synchronization skips native entries and keeps provider caches out of Git.
- A same-domain VitePress status page, documentation, OpenAPI contract, and searchable icon catalog, plus Worker/native checks, CI, contribution and security guidance, issue/PR templates, and dependency updates.
- Task-based documentation navigation and `check:repo` for required files, package/lockfile consistency, tracked local-state paths, and Markdown file links. Site validation also checks local HTML anchors; `.nvmrc` shares the Node.js 22 CI baseline, with package metadata and text/binary Git attributes.

### Changed

- Expand the native icon catalog from 45 to 108 entries with 63 additional installed apps, including VidHub. Existing icon IDs and links remain stable; Apple TV uses the existing `tv` icon, and VidHub recognizes both `VidHub` and `MediaCenter` names.
- Extend native icon export to application-root property lists and installed iOS app wrappers. Wrapped apps are identified through their direct application bundle and prefer its declared PNG icon resources, converted with native macOS tools. The outer app's NSWorkspace icon is a fallback when declared resources are unavailable; no network searches or fabricated bundle identifiers are used.

- New installations default to buffered, with about 288 scheduled KV writes per day. Existing profiles are preserved: eco remains 120-second uploads with a 180-second TTL, and realtime remains 30-second uploads with a 60-second TTL. Migrate explicitly with `--profile buffered` after deploying the compatible Worker.
- Ordinary private checkpoints combine writes at roughly 10-second intervals; quiet coverage is saved about every 30 seconds. Observed app and Music changes enter memory immediately, and safety boundaries save immediately. A crash can lose roughly the latest 10 seconds of unsaved ordinary events; checkpoint files can lag the current window.
- Hardware remains sampled every 30 seconds. Battery events follow integer percentage or power-state changes. System load is recorded at the larger of a 0.20 absolute or 5% relative change; smaller real changes are recorded by the next successful sample after 120 seconds since the last recorded system value. Transitions to or from `null` are recorded immediately.
- The home page fetches a window every 60 seconds, handles warmup and gaps, retains valid coverage during transient failures, and rejects older windows. Ordinary app, music, and running-list display changes are coalesced over 2 seconds without changing the original API timeline. Privacy masking, clearing, unavailable states, removed apps, and new sessions clear old displays immediately; same-track artwork can update immediately.
- README and repository navigation provide a shorter English entry point, with detailed operational behavior in the documentation site. This changelog consolidates implemented behavior in English without introducing release claims.

### Fixed

- Reject fully transparent icon resources and render the native Workspace image representation before fallback conversion, so applications such as Books retain their visible icon.
- Preserve known playing/paused Music state when the current track or an individual metadata field cannot be read; unavailable metadata independently becomes `null`.
- Reject `--once` and default single-push commands in buffered configurations so an accidental v1 upload does not replace the public timeline.
- Align repository links, CI badges, clone examples, editing links, and security entry points with `xw7qwq/macflare`.
- Repair six documentation anchor references containing Chinese punctuation, preserve the installed profile in domain-change examples, and document separate timeline-retention and playback cutoffs. Security guidance covers both ingestion routes and the separate local token file.

See the [roadmap](docs/roadmap.md) for planned work and the [commit history](https://github.com/xw7qwq/macflare/commits/main/) for individual changes.
