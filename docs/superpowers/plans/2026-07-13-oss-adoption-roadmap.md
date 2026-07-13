# Open-Source Harness Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt proven open-source harness patterns that measurably improve Factory AI without replacing its deterministic control plane, isolation boundaries, or Azure-native durability.

**Architecture:** Keep Factory AI's Node runtime, Service Bus orchestration, isolated containers, Zod contracts, and trusted release service. Adapt small protocol and algorithmic patterns behind Factory-owned interfaces; run large evaluation products externally rather than embedding their runtimes.

**Tech Stack:** Node.js 20, Azure Service Bus, OpenTelemetry GenAI conventions, Qdrant/Ollama, promptfoo, Inspect AI, Harbor, Bubble Tea, Docker.

---

## Decision Summary

| Source | Decision | Scope |
|---|---|---|
| Codex | Adapt, no dependency | Instruction precedence, approval semantics, compaction tests |
| Pi | Adapt, no dependency | Turn-safe compaction, cumulative checkpoint summaries |
| Aider | Adapt algorithm | Token-budgeted symbol repository maps |
| OpenTelemetry GenAI | Adopt | Internal spans/events with prompt and secret capture disabled |
| promptfoo | Adopt as pinned CI tool | Fast prompt, policy, routing, and red-team regression gates |
| Inspect AI | Adopt externally | Reproducible safety and capability evaluations |
| Harbor | Adopt externally | Cross-agent coding benchmarks with pinned images |
| mini-SWE-agent | Adopt externally | Minimal baseline for measuring Factory overhead and quality |
| Cline | Adapt, no dependency | Typed lifecycle hooks, approval interrupts, worktree checkpoints |
| LangGraph | Adapt semantics only | Durable interrupt and resume state model |
| Goose | Adapt protocol patterns only | Future ACP interoperability and extension packaging |
| OpenHands SDK | Study interfaces only | Runtime/workspace/client boundaries; no production import |
| Temporal | Evaluate later | Outer multi-repository workflows only if Service Bus limits are proven |
| Mem0 | Defer | Memory extraction is unnecessary until provenance/retention policy exists |
| Graphiti | Defer | Graph infrastructure is unjustified without organizational-memory demand |

## Explicit Non-Adoptions

- Do not replace the control plane with LangGraph, Temporal, OpenHands, Cline, Goose, Aider, or SWE-agent.
- Do not embed Aider or OpenHands as subprocess coding agents.
- Do not add Mem0 or Graphiti until deletion, provenance, tenant isolation, and stale-fact invalidation are implemented.
- Do not adopt Continue because its repository is no longer actively maintained.
- Do not adopt classic SWE-agent; use mini-SWE-agent only as an external baseline.
- Do not import OpenHands mixed-license enterprise code.
- Do not allow arbitrary shell lifecycle hooks. Hooks remain typed, pinned, role-scoped operations.
- Do not send prompts, source code, tool output, secrets, or model responses to telemetry by default.

## Adoption Gates

Every adoption must satisfy all of these before production enablement:

1. License is MIT, Apache-2.0, or separately approved and recorded.
2. Dependency is pinned in the lockfile or immutable container digest.
3. No new credential crosses the control-plane or agent-container trust boundary.
4. Feature has focused unit tests, failure tests, and one production-like integration test.
5. Evaluation shows either at least 10% higher accepted-task success or 15% lower median input tokens without quality loss.
6. Median task latency may not regress by more than 10% unless accepted-task success improves by at least 15%.
7. Rollback is a configuration switch or removal of an isolated adapter, not a state migration.

## Phase 1: Aider-Style Repository Maps

**Why first:** This offers the highest likely quality/token improvement and does not alter orchestration.

**Files:**
- Create: `src/repo-map.js`
- Create: `test/repo-map.test.js`
- Modify: `src/agent-executor.js`
- Modify: `src/retriever.js`
- Modify: `src/config.js`
- Modify: `docs/HARNESS_PARITY.md`

- [ ] Write tests proving symbol extraction excludes generated/vendor paths, respects a strict character budget, and ranks files referenced by the objective above unrelated files.
- [ ] Implement a dependency-free first version using bounded `rg` symbol/reference extraction; do not add tree-sitter yet.
- [ ] Merge repository-map output with Qdrant results using deterministic deduplication by path and line range.
- [ ] Add `FACTORY_REPO_MAP_MAX_CHARACTERS`, default `8000`, validated between `2000` and `20000`.
- [ ] Inject the map into planner and worker prompts after immutable objective instructions and before semantic snippets.
- [ ] Run an A/B evaluation over at least 30 historical objectives and record success, input tokens, cache tokens, latency, and changed-file precision.
- [ ] Add tree-sitter only if the dependency-free map fails the adoption gates and a language-specific prototype passes them.

**Verification:** `node --test test/repo-map.test.js test/agent-executor.test.js test/retriever.test.js && npm run lint`

## Phase 2: OpenTelemetry GenAI Observability

**Why second:** Evaluation and safe takeover require correlated traces before adding more orchestration states.

**Files:**
- Create: `src/telemetry.js`
- Create: `test/telemetry.test.js`
- Modify: `src/azure-harness.js`
- Modify: `src/bedrock-harness.js`
- Modify: `src/container-runner.js`
- Modify: `src/control-service.js`
- Modify: `src/worker.js`
- Modify: `src/release-service.js`
- Modify: `bootstrap/setup.sh`
- Modify: `infra/main.bicep`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Define Factory's versioned internal event schema before importing an exporter.
- [ ] Propagate trace ID, objective ID, task ID, role, model route, attempt, tool call ID, and Service Bus message ID.
- [ ] Emit model, tool, queue, checkpoint, scanner, watchdog, and release spans using OpenTelemetry GenAI names where stable.
- [ ] Record token counts, duration, retries, cache hits, status class, and bounded error codes only.
- [ ] Add tests that reject prompt, response, source, command output, secret values, and repository URLs as span attributes.
- [ ] Export OTLP optionally; add Azure Monitor only as a deployment adapter, not a runtime dependency requirement.
- [ ] Keep JSONL activity as the durable local fallback when telemetry export is unavailable.

**Verification:** `node --test test/telemetry.test.js test/azure-harness.test.js test/bedrock-harness.test.js && npm audit --audit-level=high`

## Phase 3: Evaluation Lab

**Why third:** Model routing, compaction, repository maps, and future changes need objective promotion evidence.

**Files:**
- Create: `evals/promptfoo.yaml`
- Create: `evals/datasets/routing.jsonl`
- Create: `evals/datasets/tool-policy.jsonl`
- Create: `evals/datasets/compaction.jsonl`
- Create: `evals/inspect/factory_eval.py`
- Create: `evals/inspect/compose.yml`
- Create: `evals/harbor/README.md`
- Create: `.github/workflows/evals.yml`
- Create: `docs/EVALUATIONS.md`
- Modify: `src/routing.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Pin promptfoo and build fast offline assertions for route selection, structured output, prompt injection, tool denial, secret handling, and compaction retention.
- [ ] Keep Inspect AI in a pinned Python container; do not add Python to the production image.
- [ ] Add repository-level tasks scored by tests, scanner results, minimal diff size, and release-gate outcome.
- [ ] Add mini-SWE-agent as the minimal baseline and Harbor adapters for Factory, Codex, OpenHands, and other available agents.
- [ ] Pin all benchmark images by digest and prohibit benchmark containers from receiving production credentials.
- [ ] Store evaluation manifests, model versions, prompts hashes, costs, and results as immutable release artifacts.
- [ ] Require evaluation improvement before changing default role routes; retain the previous routing table for rollback.
- [ ] Run fast promptfoo checks on pull requests and scheduled Inspect/Harbor suites outside the release critical path.

**Verification:** `npx --no-install promptfoo eval -c evals/promptfoo.yaml && docker compose -f evals/inspect/compose.yml run --rm inspect`

## Phase 4: Typed Hooks and Durable Approval Interrupts

**Why fourth:** This closes the largest parity gaps while preserving deterministic authority.

**Files:**
- Create: `src/hooks.js`
- Create: `src/approval-policy.js`
- Create: `test/hooks.test.js`
- Create: `test/approval-policy.test.js`
- Modify: `src/validation.js`
- Modify: `src/control-plane.js`
- Modify: `src/task-graph.js`
- Modify: `src/dashboard.js`
- Modify: `src/telegram.js`
- Modify: `src/operator.js`
- Modify: `cmd/factory-ui/main.go`

- [ ] Define typed hook points: before/after plan, before/after tool batch, before checkpoint, before release.
- [ ] Permit only built-in hook actions initially: scanner, policy check, notification, snapshot, and approval request.
- [ ] Add durable `approval_required`, `approved`, `denied`, and `expired` states with actor, reason, policy, and expiration.
- [ ] Add Service Bus messages for approval decisions with idempotent message IDs and monotonic state transitions.
- [ ] Require approval for network expansion, new dependencies, infrastructure changes, secret metadata changes, and external side effects.
- [ ] Add Telegram and TUI approve/deny controls without exposing prompt or secret content.
- [ ] Resume from the durable worktree checkpoint after approval; never replay already completed external side effects.
- [ ] Add race tests for approval versus timeout, watchdog, duplicate messages, cancellation, and late task results.

**Verification:** `node --test test/hooks.test.js test/approval-policy.test.js test/control-plane.test.js && go test ./cmd/...`

## Phase 5: ACP and Extension Packaging

**Decision:** Adapt Goose's protocol/package approach only after hooks and policy are stable.

**Files:**
- Create: `src/acp-adapter.js`
- Create: `src/extension-manifest.js`
- Create: `test/acp-adapter.test.js`
- Create: `test/extension-manifest.test.js`
- Modify: `config/capabilities.json`
- Modify: `SECURITY.md`

- [ ] Implement ACP as an optional edge adapter; never route ACP clients directly to Docker, Key Vault, GitHub credentials, or release operations.
- [ ] Define signed extension manifests containing name, version, digest, roles, tools, network destinations, and required secrets.
- [ ] Verify signatures and immutable digests before activation.
- [ ] Keep MCP as the internal tool protocol; ACP remains a client interoperability layer.
- [ ] Reject extensions requesting undeclared commands, mutable host mounts, Docker socket access, or arbitrary environment inheritance.

**Verification:** `node --test test/acp-adapter.test.js test/extension-manifest.test.js test/capabilities.test.js`

## Phase 6: Temporal Decision Gate

**Decision:** Do not adopt now. Run a time-boxed prototype only after multi-repository releases exist.

- [ ] Implement multi-repository release groups on the existing Service Bus/state-store architecture first.
- [ ] Collect three months of evidence for stuck workflows, timer complexity, replay defects, operator burden, and recovery time.
- [ ] Prototype one outer Temporal workflow containing only deterministic coordination; model calls, tools, Git, scanners, and releases remain activities.
- [ ] Reject Temporal if Service Bus meets recovery targets or Temporal adds more than one persistent platform dependency without reducing incident rate by 30%.
- [ ] Adopt Temporal only for release groups and long-running schedules; never replace the inner agent harness with Temporal workflow code.

## Deferred Memory Systems

Mem0 and Graphiti remain deferred until all conditions below are met:

- Repository and tenant namespaces are cryptographically separated.
- Every fact includes source commit, extraction model, confidence, timestamp, and invalidation key.
- Operators can inspect, correct, export, and delete facts.
- Retention and consent policies exist.
- Retrieval evaluation proves improvement beyond existing Qdrant plus deterministic project memory.

If those conditions are met, evaluate Mem0 first behind a `MemoryProvider` interface. Evaluate Graphiti only if temporal contradiction queries materially outperform flat provenanced facts.

## Final Rollout Order

1. Repository maps.
2. OpenTelemetry schema and export.
3. Promptfoo fast gates.
4. Inspect AI and Harbor scheduled evaluations.
5. Typed hooks and durable approvals.
6. ACP adapter and signed extensions.
7. Multi-repository releases on existing infrastructure.
8. Temporal prototype and decision.
9. Mem0/Graphiti only if memory governance and evaluation gates pass.
