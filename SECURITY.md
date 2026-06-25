# Security Policy

## Supported versions

pervigil is pre-1.0 and follows [semantic versioning](https://semver.org).
Security fixes land on the latest released minor — please upgrade to the most
recent `0.x` release before reporting.

| Version      | Supported |
| ------------ | --------- |
| latest `0.x` | ✅        |
| older        | ❌        |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue or PR.

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/rejifald/pervigil/security/advisories/new)**
(repo **Security** tab → _"Report a vulnerability"_).

Expect an initial response within a few days. Once a fix is ready it will be
released and the advisory published with credit, unless you prefer to remain
anonymous.

## Scope notes

pervigil has **zero runtime dependencies** and ships no native addons — it
invokes the operating system's own sleep-inhibitor mechanism (`caffeinate`,
`systemd-inhibit`, or PowerShell's `SetThreadExecutionState`). Reports about how
those OS processes are spawned, or about the integrity of the published package,
are especially welcome.

Releases from `v0.5.0` onward are published from CI via npm Trusted Publishing
(OIDC) with build provenance attestation. Verify a downloaded copy with:

```sh
npm audit signatures
```
