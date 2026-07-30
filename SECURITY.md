# Security Policy

FeedPulse is an open-source project maintained by one person. This document
describes what is actually supported and what response you can realistically
expect — not an enterprise SLA.

## Supported versions

No versioned release has been tagged yet. The only supported code is the current
`main` branch.

| Version             | Supported |
| ------------------- | --------- |
| `main` (unreleased) | Yes       |
| Any earlier commit  | No        |

Fixes are applied to `main` only. There are no backport branches, and there is no
patch stream for older commits — if you are running a pinned commit, upgrading to
`main` is the remediation path.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:

1. Go to <https://github.com/FullFran/feedpulse/security/advisories/new>.
2. Describe the issue, the affected component, and how to reproduce it.

If private reporting is unavailable to you, email **franfi17sw@gmail.com** with
`FeedPulse security` in the subject line.

A useful report contains:

- The affected file, endpoint or configuration.
- Reproduction steps, ideally against a local `docker compose` stack.
- The impact you believe it has (data exposure, privilege escalation, denial of service).
- The commit SHA you tested.

## What to expect

- **Acknowledgement within 7 days.** If you have not heard back after 7 days, please send a follow-up — assume the message was missed, not ignored.
- **An assessment within 30 days**, stating whether the report is accepted, already known, or considered out of scope, with reasoning.
- **Disclosure by agreement.** Once a fix lands on `main`, the advisory is published and you are credited unless you ask not to be. Please hold public disclosure until the fix is merged.
- There is no bug bounty. This is unpaid work on a personal project.

## Scope

In scope:

- The API, scheduler and worker runtimes under `src/`.
- SQL migrations under `db/migrations/`.
- The container image built from `Dockerfile`.
- The operator dashboard under `public/dashboard/`.

Out of scope:

- Vulnerabilities that require an already-compromised database or Redis instance.
- Anything reachable only when `ENABLE_AUTH=false`. That setting resolves every request to a shared `legacy` tenant and exists for local development only; the environment schema refuses to boot with `NODE_ENV=production` and `ENABLE_AUTH=false`.
- Findings in third-party dependencies with no exploitable path through this codebase. Report those upstream; Dependabot already tracks them here.
- Denial of service that only reproduces with inbound rate limiting turned off (`RATE_LIMIT_MAX_REQUESTS=0` or `RATE_LIMIT_WRITE_MAX_REQUESTS=0`, which the guard treats as "no limit").

## Known limitations

These are deliberate, documented gaps rather than undiscovered bugs. Reporting
them is welcome only if you have a concrete exploitation path beyond what is
described here.

- **DNS rebinding is not mitigated.** `src/shared/http/url-safety.ts` validates the hostname literal of every outbound URL and `src/shared/http/safe-fetch.ts` revalidates each redirect hop, but a hostname that resolves to a public address at validation time and a private one at connect time is not blocked. Closing that window requires pinning the connection to the validated IP, which Node's global `fetch` cannot express. It is tracked as follow-up work.
- **Legacy secret ciphertext.** Tenant secrets written before `db/migrations/0021_tenant_secrets_key_version.sql` are stored under an unsalted `sha256(TENANT_SECRETS_MASTER_KEY)` key with no additional authenticated data. Version 1 decryption is retained only so those rows remain readable; new writes use scrypt with the tenant id as AAD.

## Security tooling in the repository

- CodeQL static analysis (`javascript-typescript`) on push, pull request and a weekly schedule, in `.github/workflows/codeql.yml`.
- A dependency audit job in the same workflow: production dependencies are a gate, the full tree is informational.
- Dependabot updates for the `npm`, `github-actions` and `docker` ecosystems, in `.github/dependabot.yml`.
- `npm audit` is expected to report zero vulnerabilities on `main`.
