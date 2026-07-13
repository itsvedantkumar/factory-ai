# Harbor Adapter

The shared datasets in `evals/datasets/` are the source of truth for a future containerized Harbor benchmark. Harbor is intentionally not enabled yet: each task still needs a deterministic environment, an `instruction.md`, a test/reward adapter, and a container image pinned by an observed registry digest.

## Required Mapping

Create one Harbor task per JSONL record:

- `metadata.case_id` becomes the task ID.
- `vars.instruction` and `vars.input` become the task instruction.
- The sole `equals` assertion value becomes the expected reward label.
- The reward is `1` only when trimmed, lowercased agent output exactly matches that label.
- Do not place model credentials, repository credentials, or production data in task images or datasets.

## Enablement Gate

Before adding Harbor execution to CI:

1. Pin the Harbor CLI/package to an exact released version.
2. Build each environment reproducibly and resolve its registry-provided OCI digest with `docker buildx imagetools inspect <image>:<version>`.
3. Reference the observed digest as `<image>:<version>@sha256:<digest>`; never guess or copy an unverified digest.
4. Run tasks in an isolated evaluation environment with synthetic data and evaluation-only credentials.
5. Keep scheduled CI offline unless a separately reviewed workflow explicitly opts into model access.

The Inspect compose service demonstrates the expected baseline: read-only source mount, dropped capabilities, `no-new-privileges`, pinned package version, and a registry-observed image digest.
