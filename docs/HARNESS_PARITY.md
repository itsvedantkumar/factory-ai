# Agent Harness Capability Matrix

This matrix tracks capabilities documented by OpenAI Agents SDK, Claude Agent SDK, Factory Droid, Pi, LangGraph, Codex, and GitHub Copilot cloud agent.

| Harness capability | Factory AI status | Implementation |
| --- | --- | --- |
| Model/tool loop | Complete | Azure Responses and Bedrock Converse adapters |
| Typed tools and output validation | Complete | JSON Schema tools and strict Zod results |
| Sandboxed shell/filesystem | Complete | Bounded read-only containers and allowlisted commands |
| Multi-agent orchestration | Complete | Deterministic DAG, role agents, queues, release groups roadmap |
| Handoffs | Complete | Typed task packets, dependency evidence, durable results |
| MCP | Complete | Pinned role-scoped stdio servers with bounded output |
| Skills | Complete | Progressive role-scoped Agent Skills |
| Sessions and durable state | Complete | Service Bus, retained state, project memory, Git checkpoints |
| Context management | Complete | Local semantic retrieval, bounded memory/tools, role budgets |
| Prompt caching | Complete | Stable prefixes, provider caching, cached-token telemetry |
| Input/output/tool guardrails | Complete | Validation, path confinement, command and release policy |
| Retries and failure normalization | Complete | Backoff, redelivery, DLQ, durable failure results |
| Human approval | Partial | GitHub/release gates; mid-task approval UI remains planned |
| Lifecycle hooks | Partial | Built-in scanners/checkpoints/reports; user hook API remains planned |
| Tracing and usage | Partial | Model/task usage and structured logs; OpenTelemetry spans planned |
| Streaming events | Partial | Telegram/TUI polling; event stream planned |
| Safe takeover | Planned | Lease/fencing design documented in roadmap |
| Evaluation and promotion | Planned | Evaluation Lab architecture defined |
| Signed extension marketplace | Planned | Manifest/signature/policy design defined |
| Multi-repository release groups | Planned | V2 schemas and release-unit design defined |
| VMSS autoscaling | Planned | Queue-driven Flexible VMSS design defined |

Factory AI should only mark a capability complete after executable tests and production evidence exist.
