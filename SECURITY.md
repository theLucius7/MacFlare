# Security policy

Security investigations use the current implementation on the default branch as their baseline. Include the affected version or commit in reports. This project does not promise maintenance periods for historical versions or response deadlines. Fixes prioritize one-way reporting, controlled collection, and short-lived snapshots.

## Reporting a vulnerability

GitHub Private Vulnerability Reporting is enabled for this repository. Use [Report a vulnerability](https://github.com/xw7qwq/macflare/security/advisories/new). Do not publish valid tokens, personal snapshots, or complete exploitable details in public issues. If the private reporting entry is temporarily unavailable, open an issue without sensitive details to request a private contact channel from a maintainer.

Describe the affected version or commit, trigger conditions, minimal reproduction, impact, and suggested mitigations. Use test credentials and synthetic status data rather than real secrets. Test only deployments you own or are authorized to test; do not scan other users' status endpoints.

## Responding to a leak

1. Use the uninstall script to stop local background reporting. Do not select the cleanup option if you need to retain the configuration.
2. Reset the Worker's `INGEST_TOKEN` and update the local private configuration file. Use a random token of at least 32 characters; `openssl rand -hex 32` is recommended.
3. The old snapshot expires according to the deployment's server TTL. If necessary, delete `now` from the relevant KV namespace. This cannot remove copies saved by third parties.
4. Investigate leaks in the repository, CI logs, and local logs. Revoke tokens that have entered Git history; deleting the file alone is insufficient.
5. Verify that anonymous `/api/update` requests return 401, the new token can write, and the old token cannot write before enabling background scheduling again.

Cloudflare account API tokens and MacFlare ingest tokens are independent. If account credentials were leaked, also revoke them in Cloudflare and review account changes.

## Security design conventions

- Store ingest credentials in a Cloudflare secret and a local file with restricted permissions, never in the repository, URLs, frontend, or plist.
- The public API intentionally exposes status. CORS is not authentication, and TTL does not prevent scraping or retract already published information.
- Encode external strings for their output context: escape SVG text and use `textContent` in web clients.
- The server controls expiration and accepts only protocol-approved fields. Client timestamps cannot extend server freshness.
- Do not present failed collection as successful or require macOS system protections to be disabled to obtain metrics.

See the [privacy and threat model](docs/privacy.md) for the complete boundaries.
