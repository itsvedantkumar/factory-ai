# Governance

Factory AI uses maintainer-led governance.

## Roles

- Contributors propose issues, documentation, tests, and code changes.
- Maintainers triage work, review changes, manage releases, and enforce security boundaries.
- The lead maintainer resolves decisions that lack consensus and owns release signing and trust-root changes.

## Decisions

Routine changes use pull-request review. Architecture, security-floor, extension trust, credential handling, and backward-incompatible changes require a written decision in the pull request and explicit maintainer approval.

## Releases

Releases follow semantic versioning. Every release must pass CI, tests, dependency audit, Gitleaks, Trivy, package inspection, and release-note review.

## Security Floor

Repository policy may tighten but never weaken container isolation, capability-free orchestration, secret boundaries, release gates, or least-privilege credentials.
