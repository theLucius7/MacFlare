# Contributing

Fixes, compatibility reports, and documentation improvements are welcome. Follow the [code of conduct](CODE_OF_CONDUCT.md) in discussions. Use the repository's issue templates for bug reports and feature requests; report vulnerabilities through the private channel in the [security policy](SECURITY.md).

For issue reports, include the macOS version, MacFlare version or commit, execution method (terminal or launchd), redacted errors, and reproduction steps. Do not include real tokens, personal listening history, app lists, or unredacted configuration. For feature requests, first explain the problem and whether the proposal expands the public data exposed.

## Local development

1. Fork and clone the repository, then create a work branch from `main`.
2. Install the Node.js version required by `package.json` and run `npm ci`. Node.js is for Worker development and testing only; do not add it to the Mac Agent runtime.
3. Copy `.dev.vars.example` to `.dev.vars`, use a test token, and run `npm run dev`.
4. Validate changes according to the table below. Changes to native collection, TCC, or launchd also require verification on a real Mac.
5. Explain the before-and-after behavior with nonsensitive examples, and update the API, configuration, or troubleshooting documentation as needed.

The native macOS smoke checks use Python 3 in the development environment: `python3 agent/tests/native-smoke.py`. They use temporary configuration and a loopback server, disable Music, and do not install a LaunchAgent. Python is not part of the actual Agent runtime.

| Change scope | Relevant validation |
| --- | --- |
| Worker, protocol, or dependencies | `npm test`, `npm run check`; explain effects on authentication, fields, and expiration |
| Mac Agent, installation, or scheduling | Run `/bin/bash -n` on changed scripts and the native smoke checks; add results from a real Mac when needed |
| Music or system permissions | Verify manual and background reads separately; success in one execution mode does not establish success in the other |
| Documentation or repository templates | Check links and examples against the current code; documentation-only changes do not require unrelated application tests to be repeated |

Record the commands run and their results, and identify environments you could not cover. Use synthetic data or disable sensitive collection during tests. Do not modify someone else's production deployment for validation.

## Implementation conventions

- Keep Mac scripts compatible with the system `/bin/bash` and use only built-in macOS tools. Do not hide new Homebrew, Node.js, Python, or jq dependencies in the installation flow.
- Quote paths and arguments, and support user paths containing spaces. Do not use `eval` or execute remote configuration.
- Use system JSON serialization for strings instead of assembling JSON by concatenating quotes. Never interpret track or app names as shell code.
- Degrade gracefully when an individual collector fails. Network calls must have timeouts, must not retry indefinitely, and must not write tokens to command logs.
- Validate incoming Worker fields explicitly and use server-controlled expiration and server time. Do not store unfiltered requests in public KV.
- Explain the purpose, default behavior, and privacy impact of new public fields. Avoid persistent identifiers and unrelated telemetry.

Tests should cover boundary behavior: authentication, invalid input, expiration, data cleanup, escaping, and graceful failure. Unit tests replace KV with memory and cannot establish consistency across Cloudflare's network. Passing Linux tests does not establish native macOS behavior.

## Pull requests

`main` is the only long-lived development branch. Create work branches from the latest `main`, using short names such as `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, or `chore/<topic>`. Dependabot keeps its generated branch names.

Use English for contribution guidance and new issue and PR titles and descriptions, following the [shared organization guidelines](https://github.com/xw7qwq/.github/blob/main/CONTRIBUTING.md). Preserve technical identifiers and relevant original-language evidence when needed.

Use the PR template to describe the problem, trigger, resulting behavior, and validation performed, and link existing issues. Include migration notes for protocol or configuration changes. Explain additions or removals of public data when changing collection scope, and compatibility and usage effects when changing scheduling, TTL, or dependencies. Keep naming or formatting PRs focused, without unrelated refactoring.

Before merging, resolve conflicts and review comments, and confirm that both `worker` and `macos-agent` checks pass on the current PR head. Prefer squash merging with a title describing the actual change, such as `fix: preserve partial Music metadata`. Delete merged work branches afterward. Inspect unique commits on unmerged branches before removing them; do not delete branches based only on age or name. Do not force-push `main` or bypass failing checks to finish maintenance.

Record user-visible behavior changes under `Unreleased` in the [CHANGELOG](CHANGELOG.md). Record only implemented behavior, without presenting plans as released features. Maintainers confirm formal versions when releasing them.

Application checks require no Cloudflare or device access secrets. Users perform their own initial deployment and permission acceptance checks; submitting a PR does not authorize deployment to someone else's Cloudflare account.

This project uses the [MIT License](LICENSE). By contributing, you confirm that you have the right to submit the material and agree to distribute it under the same license. Do not submit code or assets without the necessary rights.
