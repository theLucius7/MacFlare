# Security policy

Security investigations use the current implementation on the default branch as their baseline. Include the affected version or commit in reports. This project does not promise maintenance periods for historical versions or response deadlines. Fixes prioritize one-way reporting, controlled collection, and bounded retention of snapshots and buffered windows.

## Reporting a vulnerability

GitHub Private Vulnerability Reporting is enabled for this repository. Use [Report a vulnerability](https://github.com/xw7qwq/macflare/security/advisories/new). Do not publish valid tokens, personal snapshots, or complete exploitable details in public issues. If the private reporting entry is temporarily unavailable, open an issue without sensitive details to request a private contact channel from a maintainer.

Describe the affected version or commit, trigger conditions, minimal reproduction, impact, and suggested mitigations. Use test credentials and synthetic status data rather than real secrets. Test only deployments you own or are authorized to test; do not scan other users' status endpoints.

## Responding to a leak

1. Stop manually started `--watch` processes in their terminals, then run `scripts/uninstall.sh` from the repository as your desktop user, without `sudo`. It unloads `com.macflare.agent` from launchd and removes installed Agent code, the buffered checkpoint, artwork cache, and window lock. It retains `config.json`, `token`, and `last-result.json`; `--purge` also removes those files. Killing only the buffered process is insufficient because launchd can restart it.
2. Rotate the affected deployment's `INGEST_TOKEN` with `npx wrangler secret put INGEST_TOKEN`. If you deployed with a separate Wrangler configuration, pass that same `--config` path. Use a new cryptographically random token of at least 32 characters, and keep it out of shell arguments, URLs, screenshots, and logs. The local secret is the separate file `~/Library/Application Support/MacFlare/token`, not a field in `config.json`.
3. Save the new token in a private file with mode `600`, then run `scripts/install.sh --token-file "/private/path/to/new-ingest-token" --no-start`, replacing the example path. This installs the matching token and code while leaving launchd stopped. Omitted endpoint, profile, and privacy settings are retained from the existing configuration. If you purged it, supply the endpoint and desired profile again. Keep the token file private or remove the temporary source after installation.
4. Remove the `now` key from the affected Workers KV namespace if the published data itself must be cleared. KV propagation and cached reads can delay removal. Otherwise, v1 snapshots expire according to the configured server TTL; a v2 buffered window has a fixed API cutoff at `window_end + 600 seconds`, which retrying the same batch cannot extend. The oldest observation in a full 15-minute window can therefore remain publicly available for about 25 minutes after collection. Removal and expiry cannot retract copies saved by third parties.
5. Investigate repository history, CI logs, local logs, and any other exposed copies. Revoke leaked credentials even if their files or commits have been removed. On a deployment you own, verify with synthetic payloads that unauthenticated and old-token requests to both `/api/batch` and `/api/update` return `401`, and that the new token can write. Once the cause is resolved, run `scripts/install.sh` to resume the retained configuration, or leave launchd stopped if reporting should remain disabled.

Cloudflare account API tokens, MacFlare ingest tokens, and any optional icon-provider API keys are independent credentials. Revoke each credential that was exposed. If Cloudflare account credentials were leaked, revoke them in Cloudflare and review account changes before trusting the deployment again. Replacing only `INGEST_TOKEN` does not secure a compromised Cloudflare account.

## Data and trust boundaries

The Agent pushes to the configured Worker; there is no public route that executes a command on the Mac. Both ingestion routes require the bearer token and validate a restricted schema. A leaked ingest token still permits an attacker to overwrite public status and consume deployment resources.

Public status routes are intentionally unauthenticated. In buffered mode, `/api/timeline` exposes the retained window, including observations newer than the page's seven-minute playback position. The playback delay is not access control. The v1-compatible status routes project that window at the delayed position and stop reporting online when coverage ends or the playhead enters a gap. CORS, expiration, and UI smoothing do not prevent scraping or guarantee immediate removal of previously published data.

Local privacy controls filter observations before upload. Changes clear the buffered history and pending work locally, but cannot unsend a completed request or remove third-party copies. The private `window-cache.json` can contain recent app and Music history; its file is not a remotely expiring KV object. An abrupt stop may leave it on disk until cleanup or a later run, so treat backups and copies as personal data. The uninstall script removes both window and artwork caches.

When Music artwork lookup is enabled, the Mac can send song and artist queries to Apple. Visitors also load Apple artwork, and older or unmatched snapshots may trigger a browser search. See the [privacy and threat model](docs/privacy.md) for these external requests and the limits of app filtering.

## Security design conventions

- Store ingest credentials in a Cloudflare secret and the separate local `token` file with mode `600`, within the private MacFlare directory with mode `700`. Never put credentials in the repository, URLs, frontend, or plist.
- Encode external strings for their output context: escape SVG text and use `textContent` in web clients.
- The server controls expiration and accepts only protocol-approved fields. Preserve timestamp validation, payload bounds, and absolute v2 expiry when modifying the protocol. A retry must not refresh an old batch's retention deadline.
- Do not present failed collection as successful or require macOS system protections to be disabled to obtain metrics.

See the [privacy and threat model](docs/privacy.md) for the complete boundaries.
