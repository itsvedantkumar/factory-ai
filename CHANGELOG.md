# Changelog

All notable changes follow semantic versioning and the Keep a Changelog structure.

## [Unreleased]

## [2.2.0] - 2026-07-14

### Changed

- Replaced the custom terminal interaction layer with the proven MIT-licensed OpenCode Go TUI architecture: a 70/30 split pane, persistent Bubbles textarea, viewport, and modal-first command routing.
- Added an OpenCode-style command palette, real cursor editing and paste support, command history, responsive narrow-terminal behavior, and workspace-aware action prefills.
- Added third-party attribution while retaining Factory's command validation and Azure control-plane boundaries.

## [2.1.0] - 2026-07-13

### Changed

- Redesigned the native TUI around a persistent workspace selector with workspace-scoped Dashboard, Objectives, and Agents pages.
- Consolidated secrets, logs, models, runtime, and capabilities under Settings.
- Added dedicated bounded command-console and always-visible command-line panes with scrollback, clear controls, history, inline errors, and selected-workspace submit shortcuts.

## [2.0.0] - 2026-07-13

### Changed

- Replaced the JavaScript fallback TUI with one native Go operator console featuring an OpenCode-style command bar, command history, inline output/errors, and shortcuts for submissions, workspace imports, secrets, approvals, pause/resume, and help.
- Removed the `factory-ui` JavaScript binary and `neo-blessed` dependency; `factory ui` now fails closed if its verified attested native binary is unavailable.

## [1.6.1] - 2026-07-13

### Added

- `factory update check|now|status|enable|disable` for local version checks, immediate verified Azure/local updates, and explicit six-hour timer control.

## [1.6.0] - 2026-07-13

### Added

- Persistent Conductor-style workspace catalog with local/GitHub imports, managed clones, stable names, default branches, project initialization, CLI commands, direct Service Bus submission, and a native workspace view.

## [1.5.3] - 2026-07-13

### Fixed

- Validate npm's actual attestation URL and SLSA predicate metadata fields during verified automatic updates.

## [1.5.2] - 2026-07-13

### Fixed

- Parse runtime environment files with an allowlist so factory names and purposes containing spaces do not break verified automatic updates.

## [1.5.1] - 2026-07-13

### Fixed

- Exclude unfinished tasks from stale-agent health after their objective reaches a terminal state.

## [1.5.0] - 2026-07-13

### Added

- Cross-platform Bubble Tea/Lip Gloss operator client with direct Azure Blob snapshots, verified release binaries, scrolling, and native command execution.
- Automatic Azure and Bedrock context compaction with immutable objective retention and recent tool evidence.
- Hierarchical `AGENTS.md` discovery, preconfigured project instructions, and bounded `.agent-factory` context.
- Durable worktree crash recovery, parallel read-only tool batches, live activity timelines, retry/error telemetry, and stale-agent watchdog recovery.
- Post-setup `factory models show|set|reset` and `factory configure models` workflows with validated routes, atomic runtime rollback, and update-safe persistence.
- Open-source harness adoption research and executable Go CI gates.
- Token-budgeted repository maps, safe OpenTelemetry GenAI records, Promptfoo/Inspect/Harbor evaluation contracts, typed lifecycle hooks, durable approval interrupts, optional ACP intake, and signed extension verification.

### Security

- Read-only role filesystems and command policy, deterministic pre-push Gitleaks enforcement, typed scanner release blockers, terminal-safe Go rendering, and structured allowlisted operator logs.
- Repository-scoped MCP memory; legacy unscoped memory is retained as `legacy-unscoped-knowledge-graph.jsonl` instead of being mixed into new repositories.
- Model credentials now enter agent containers through a consumed stdin envelope rather than environment variables; a persistent Docker firewall blocks cloud metadata access.
- Release publishing now binds tags to package versions, requires full gates and npm provenance, and attests immutable Go binaries.

## [1.4.0] - 2026-07-13

### Added

- Free local semantic code retrieval with pinned Ollama embeddings and retained Qdrant vectors.
- Commit-aware indexing, bounded chunking, top-k context injection, and failure fallback.
- Modern agent-harness capability matrix and explicit completion criteria.

## [1.3.0] - 2026-07-13

### Added

- RBAC-protected Azure Blob dashboard snapshots for lock-free multi-operator TUI access.
- One-minute snapshot timer and direct local Azure-identity reads.
- Factory AI process, container, journal, Azure, Bedrock, MCP, Git, and PR identity metadata.

## [1.2.1] - 2026-07-13

### Fixed

- Make updater installation idempotent when the staged application already occupies the final runtime path.

## [1.2.0] - 2026-07-13

### Added

- Telegram natural-language objectives, default repositories, objective lookup, and automatic progress/completion notifications.
- Six-hour verified stable updates with CI/security gates, durable version records, major-version blocking, and rollback.

## [1.1.0] - 2026-07-13

### Added

- GPT-5.5 as the benchmarked default implementation model, with Kimi retained for explicitly simple tasks.
- Per-role step/output budgets and per-model input/cache/output token telemetry.
- Cache-friendly prompt ordering and compact deterministic memory.
- Bounded line-range reads, listings, command output, MCP output, and scanner evidence.

## [1.0.2] - 2026-07-13

### Fixed

- Compress large Azure dashboard payloads so the interactive TUI remains reliable as objective history grows.

## [1.0.1] - 2026-07-13

### Fixed

- Resolve npm global CLI symlinks before loading bundled TUI, setup, infrastructure, deployment, and project-template files.

## [1.0.0] - 2026-07-12

### Added

- Deterministic CTO control plane and isolated role workers.
- Azure Service Bus durability, retained memory/state, Key Vault, and cost dashboard.
- GPT-5.4 nano, GPT-5.4, GPT-5.6, Kimi, and Bedrock routing.
- Gated GitHub delivery, MCP/skills, project memory, CI, security scans, and one-command setup.
