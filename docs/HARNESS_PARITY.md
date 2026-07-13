# Agent Harness Capability Matrix

This matrix tracks capabilities documented by OpenAI Agents SDK, Claude Agent SDK, Factory Droid, Pi, LangGraph, Codex, and GitHub Copilot cloud agent.

| Harness capability | Factory AI status | Implementation |
| --- | --- | --- |
| Model/tool loop | Complete | Azure Responses and Bedrock Converse adapters |
| Typed tools and output validation | Complete | JSON Schema tools and strict Zod results |
| Sandboxed shell/filesystem | Complete | Role-scoped read-only mounts, bounded tools, credential-free commands, and pre-push secret gates |
| Multi-agent orchestration | Complete | Deterministic DAG, role agents, queues, release groups roadmap |
| Handoffs | Complete | Typed task packets, dependency evidence, durable results |
| MCP | Complete | Pinned role-scoped stdio servers with bounded output |
| Skills | Complete | Progressive role-scoped Agent Skills |
| Sessions and durable state | Complete | Service Bus, retained state, project memory, durable worktrees, redelivery recovery context, and Git checkpoints |
| Context management | Complete | Automatic provider compaction, hierarchical `AGENTS.md`, token-budgeted repository maps, local semantic retrieval, bounded memory/tools, and role budgets |
| Prompt caching | Complete | Stable prefixes, provider caching, cached-token telemetry |
| Input/output/tool guardrails | Complete | Validation, path confinement, command and release policy |
| Retries and failure normalization | Complete | Backoff, redelivery, DLQ, durable failure results, heartbeat health, and stale-container watchdog |
| Human approval | Partial | GitHub/release gates; mid-task approval UI remains planned |
| Lifecycle hooks | Partial | Typed built-in scanner, policy, notification, snapshot, and durable approval hooks; additional hook points remain staged |
| Tracing and usage | Complete | Privacy-allowlisted OpenTelemetry GenAI records, model/task usage, and structured logs |
| Streaming events | Partial | Durable per-agent model/tool/heartbeat events in Telegram and both TUIs; push stream planned |
| Safe takeover | Planned | Lease/fencing design documented in roadmap |
| Evaluation and promotion | Partial | Promptfoo contracts plus pinned Inspect AI and Harbor adapters; historical promotion runs remain scheduled work |
| Signed extension marketplace | Partial | Strict Ed25519 manifest and artifact verification; catalog distribution remains planned |
| Multi-repository release groups | Planned | V2 schemas and release-unit design defined |
| VMSS autoscaling | Planned | Queue-driven Flexible VMSS design defined |

Factory AI should only mark a capability complete after executable tests and production evidence exist.
