# Contributing

Fixes, compatibility reports, and documentation improvements are welcome. Follow the [code of conduct](CODE_OF_CONDUCT.md) in discussions. Use the repository's issue templates for bug reports and feature requests; report vulnerabilities through the private channel in the [security policy](SECURITY.md).

For issue reports, include the macOS version, MacFlare version or commit, profile (`buffered`, `eco`, or `realtime`), execution method (terminal or launchd), redacted errors, and reproduction steps. Distinguish local collection, upload, and delayed page playback when reporting stale status. Do not include real tokens, personal listening history, app lists, or unredacted configuration. For feature requests, first explain the problem and whether the proposal expands the public data exposed.

## Local development

1. Fork and clone the repository, then create a work branch from `main`.
2. Install Node.js 22 or newer, as required by `package.json`, and run `npm ci`. Node.js is for development, tests, and documentation builds; do not add it to the Mac Agent runtime.
3. For Worker development, copy `.dev.vars.example` to `.dev.vars`, set a synthetic test token, and run `npm run dev`. For documentation editing, use `npm run docs:dev`. Neither workflow requires production credentials.
4. Validate changes according to the table below. Changes to native collection, TCC, or launchd also require verification on a real Mac.
5. Explain the before-and-after behavior with nonsensitive examples, and update the API, configuration, or troubleshooting documentation as needed.

Run the platform-independent suite from the repository root:

```sh
npm test
npm run check
```

`npm run check` checks repository conventions, builds the documentation, checks the generated site and Worker syntax, and performs a Wrangler deployment dry run. It does not publish a Worker. Use a separate test deployment if a change needs verification against real Workers KV; the unit tests cannot establish consistency across Cloudflare's network.

For a quick repository-only check, run `npm run check:repo`. It uses Node.js and Git to check required files, package/lockfile consistency, tracked credential or build-cache files, and local Markdown file links. It does not need Cloudflare credentials, make network requests, build the site, or collect device status. It does not validate every public link or replace a full schema review.

On macOS, run the same native checks as the `macos-agent` CI job:

```sh
/bin/bash -n agent/macflare.sh
/bin/bash -n scripts/install.sh
/bin/bash -n scripts/uninstall.sh
node --check agent/runtime.js
node --check agent/window-runtime.js
python3 agent/tests/native-smoke.py
python3 agent/tests/window-native.py
```

The native tests require Python 3 and Node.js in the development environment. They use temporary configuration, synthetic notifications, and loopback HTTP servers. They do not install a LaunchAgent, request Music consent, or upload device status to a public Worker. The smoke suite includes a short local observation with Music disabled; the window suite covers notification bursts, checkpoint cadence, slow uploads, locks, privacy resets, sleep, and collector failure. Python is not part of the installed Agent runtime.

| Change scope | Relevant validation |
| --- | --- |
| Worker, protocol, or dependencies | `npm test`, `npm run check`; explain effects on authentication, fields, and expiration |
| Mac Agent, installation, or scheduling | Run the native checks above, including both Python suites; add targeted manual and launchd results when needed |
| Buffered protocol or playback | Run `npm test` and both native suites for cross-runtime changes; cover rapid transitions, gaps, restarts, bounds, and absolute expiry |
| Music or system permissions | Verify manual and background reads separately; success in one execution mode does not establish success in the other |
| App-icon export or catalog | Run `python3 -B scripts/tests/test_export_app_icons.py`, `npm test`, and `npm run check`; for exporter changes, verify selected installed apps on macOS and inspect the exported images |
| Documentation or repository templates | `npm run check`; check examples against the current code. Documentation-only changes do not require unrelated application or native tests to be repeated |

Record the commands run and their results, and identify environments you could not cover. Use synthetic data or disable sensitive collection during tests. Do not modify someone else's production deployment for validation. `--print` emits personal status even though it does not upload; do not attach its unredacted output. `--observe SECONDS` reports counts without Worker uploads, but enabled Music collection may still query Apple for artwork.

## Runtime and protocol boundaries

The installed Agent uses system Bash, JXA through `osascript`, native macOS frameworks and command-line tools, and `launchd`. The default `buffered` profile runs `--watch`, retains observed app and Music transitions in a bounded 15-minute window, and sends one v2 batch to `/api/batch` every five minutes. Snapshot profiles (`eco` and `realtime`) use `--once` and v1 `/api/update`. Preserve both paths when changing shared collectors or validation.

Read the [buffering design](docs/buffering.md), [API contract](docs/api.md), and [privacy boundaries](docs/privacy.md) before changing collection or scheduling. Keep collection, checkpoint writes, uploads, and page rendering separate: fewer disk writes or display updates must not silently discard observed app or Music transitions. Hardware sampling and load thresholds intentionally reduce noise. A restored checkpoint, failed upload, or delayed KV read must not extend the public expiry or invent continuous coverage through sleep or collection failures.

The public timeline contains the retained batch. The page's seven-minute playback delay is a display policy, not an embargo on newer observations. Test privacy changes against retained history, pending work, and public output, not just the next collected snapshot.

## Implementation conventions

- Keep Mac scripts compatible with the system `/bin/bash` and use only built-in macOS tools. Do not hide new Homebrew, Node.js, Python, or jq dependencies in the installation flow.
- Quote paths and arguments, and support user paths containing spaces. Do not use `eval` or execute remote configuration.
- Use system JSON serialization for strings instead of assembling JSON by concatenating quotes. Never interpret track or app names as shell code.
- Degrade gracefully when an individual collector fails. Network calls must have timeouts, must not retry indefinitely, and must not write tokens to command logs.
- Validate incoming Worker fields explicitly and use server-controlled expiration and server time. Keep batch size and event bounds explicit, and preserve v2 absolute expiry across retries. Do not store unfiltered requests in public KV.
- Explain the purpose, default behavior, and privacy impact of new public fields. Avoid persistent identifiers and unrelated telemetry.

Tests should cover boundary behavior: authentication, invalid input, expiration, data cleanup, escaping, and graceful failure. Passing Linux tests does not establish native macOS behavior; passing native fixtures does not establish Music permissions in a user's launchd execution context.

## Pull requests

`main` is the only long-lived development branch. Create work branches from the latest `main`, using short names such as `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, or `chore/<topic>`. Dependabot keeps its generated branch names.

Use English for contribution guidance and new issue and PR titles, descriptions, and commit messages, following the [shared organization guidelines](https://github.com/xw7qwq/.github/blob/main/CONTRIBUTING.md). Keep existing localized user documentation coherent, and preserve technical identifiers and relevant original-language evidence when needed.

Use the PR template to describe the problem, trigger, resulting behavior, and validation performed, and link existing issues. Include migration notes for protocol or configuration changes and screenshots with synthetic data for visible interface changes. Explain additions or removals of public data when changing collection scope, and compatibility and usage effects when changing scheduling, retention, or dependencies. Keep naming or formatting PRs focused, without unrelated refactoring.

Before merging, resolve conflicts and review comments, and confirm that both `worker` and `macos-agent` checks pass on the current PR head. Prefer squash merging with a title describing the actual change, such as `fix: preserve partial Music metadata`. Delete merged work branches afterward. Inspect unique commits on unmerged branches before removing them; do not delete branches based only on age or name. Do not force-push `main` or bypass failing checks to finish maintenance.

Record user-visible behavior changes under `Unreleased` in the [CHANGELOG](CHANGELOG.md). Record only implemented behavior, without presenting plans as released features. Maintainers confirm formal versions when releasing them.

Application checks require no Cloudflare or device access secrets. Users perform their own initial deployment and permission acceptance checks; submitting a PR does not authorize deployment to someone else's Cloudflare account.

This project uses the [MIT License](LICENSE). By contributing, you confirm that you have the right to submit the material and agree to distribute it under the same license. Do not submit code or assets without the necessary rights.
