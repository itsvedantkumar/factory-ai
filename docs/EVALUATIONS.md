# Evaluation Lab

Factory AI maintains small, deterministic policy evaluations for model routing, tool authorization, and context compaction. The JSONL files under `evals/datasets/` are shared by Promptfoo and Inspect so both runners grade identical cases.

## Dataset Contract

Each line contains Promptfoo-compatible `vars`, one exact-match assertion, and metadata with a globally unique `case_id`. Outputs are normalized to trimmed lowercase labels. Add adversarial boundary cases rather than prose-quality cases; no production prompts, source code, credentials, customer data, or model responses belong in these datasets.

Validate without installing evaluation frameworks:

```sh
python3 evals/inspect/factory_eval.py --validate
python3 -m py_compile evals/inspect/factory_eval.py
```

## Promptfoo

Promptfoo is pinned at `0.121.18` in commands and CI. Use only evaluation-specific credentials and an OpenAI-compatible evaluation endpoint:

```sh
export OPENAI_API_KEY='<evaluation-only key>'
export OPENAI_BASE_URL='https://evaluation-endpoint.example/v1'
npx --yes promptfoo@0.121.18 eval --config evals/promptfoo.yaml --no-cache
```

Override the configured provider on the command line if the endpoint uses another Promptfoo provider. Never point this lab at a production endpoint or reuse production credentials. Results may contain model output; keep them out of Git and review retention before sharing.

## Inspect

Inspect AI is pinned at `0.3.246`. Run a specific task with an explicitly supplied evaluation credential:

```sh
docker compose -f evals/inspect/compose.yml run --rm \
  -e OPENAI_API_KEY='<evaluation-only key>' \
  inspect inspect eval evals/inspect/factory_eval.py@routing \
  --model openai/factory-eval --display plain
```

The compose image is pinned to the registry-observed multi-platform digest for `python:3.12.10-slim-bookworm`. When changing the Python version, resolve the replacement with `docker buildx imagetools inspect python:<version>` and commit the observed digest. If a registry digest cannot be obtained, do not enable or merge container execution with a tag-only image.

The container does not inherit host credentials. Its source mount is read-only; only the named pip-cache and Inspect-log volumes are writable. Inspect logs can contain model output and must be treated as sensitive evaluation artifacts.

## Harbor

`evals/harbor/README.md` defines the dataset mapping and hard enablement gate. Harbor execution remains disabled until task environments and package versions are reproducibly pinned and every image has a verified OCI digest.

## CI Boundary

`.github/workflows/evals.yml` runs only on `workflow_dispatch` and a weekly schedule. It has read-only repository permission, no GitHub environment, no OIDC permission, no secret references, no credential persistence, and no live model calls. CI validates structure and runner configuration only; live evaluations are intentionally operator-run with isolated evaluation credentials.
