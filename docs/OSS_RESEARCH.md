# Open-Source Harness Research

Research snapshot: July 2026. Factory AI should reuse protocols and proven patterns, not import large overlapping runtimes without a clear boundary.

| Project | License | Useful pattern | Decision |
|---|---|---|---|
| [OpenAI Codex](https://github.com/openai/codex) | Apache-2.0 | Hierarchical `AGENTS.md`, sandbox approvals, local/remote compaction | Adapt instruction and compaction semantics |
| [Pi](https://github.com/earendil-works/pi) | MIT | Turn-safe compaction, recent-token tail, append-only session tree | Adapt compaction and session checkpoints |
| [Aider](https://github.com/Aider-AI/aider) | Apache-2.0 | Token-budgeted tree-sitter repository maps and lint/test loops | Adapt repository maps; do not embed the CLI |
| [OpenHands Agent SDK](https://github.com/OpenHands/software-agent-sdk) | MIT | Runtime/workspace/frontend separation and remote agent server | Adapt SDK boundaries; exclude mixed-license enterprise code |
| [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) | MIT | Minimal linear shell-agent baseline and trajectories | Adopt as an evaluation baseline, not production runtime |
| [Cline](https://github.com/cline/cline) | Apache-2.0 | Plan/act separation, approval gates, worktree checkpoints, hooks | Adapt checkpoints and lifecycle hooks |
| [Goose](https://github.com/aaif-goose/goose) | Apache-2.0 | MCP/ACP interoperability and extension packaging | Adapt protocol packaging |
| [Temporal](https://github.com/temporalio/temporal) | MIT | Durable workflows, signals, cancellation, timers, retries | Evaluate for outer orchestration; keep model/tool calls in activities |
| [LangGraph](https://github.com/langchain-ai/langgraph) | MIT | Checkpoints, interrupts, resumable state graphs | Adapt state/interrupt model; avoid core framework coupling |
| [Mem0](https://github.com/mem0ai/mem0) | Apache-2.0 | Provenanced session/agent memory and hybrid retrieval | Evaluate behind retention and consent policy |
| [Graphiti](https://github.com/getzep/graphiti) | Apache-2.0 | Temporal facts, validity windows, episode provenance | Defer until organizational memory justifies graph infrastructure |
| [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai) | Apache-2.0 | Vendor-neutral model, agent, tool, and MCP telemetry | Adopt behind a versioned internal event schema |
| [promptfoo](https://github.com/promptfoo/promptfoo) | MIT | Declarative prompt/model matrices and red-team CI | Adopt for prompt and policy regression gates |
| [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai) | MIT | Reproducible datasets, sandboxes, solvers, and scorers | Adopt for research-grade evaluations |
| [Harbor](https://github.com/harbor-framework/harbor) | Apache-2.0 | Common coding-agent adapters and benchmark environments | Adopt as an external benchmark harness with pinned images |

## Incorporated Now

- Hierarchical, bounded `AGENTS.md` discovery with explicit untrusted-guidance boundaries.
- Automatic Azure and Bedrock context compaction retaining immutable objective context and recent tool evidence.
- Durable worktree recovery context across worker/container failure.
- Parallel execution for model-requested read-only tool batches.
- Role-scoped read-only filesystems and deterministic pre-push secret scanning.

## Next Candidates

1. Aider-style symbol repository maps to improve context quality without larger prompts.
2. OpenTelemetry GenAI spans correlated with objective, task, container, model, and tool IDs.
3. Promptfoo plus Inspect AI evaluation gates, with Harbor for cross-harness comparisons.
4. Typed lifecycle hooks and bounded approval interrupts inspired by Cline and LangGraph.
5. Temporal evaluation for multi-repository release groups and long-running schedules.
