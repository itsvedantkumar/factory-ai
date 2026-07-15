# Changelog

All notable changes follow semantic versioning and the Keep a Changelog structure.

## [Unreleased]

## [2.8.0] - 2026-07-15

### Added

- Added workspace-scoped quick prompts, persisted separately from delivery objectives and rendered in the Session view.
- Added automatic prompt routing: delivery requests become objectives while questions and inspections become quick actions; `objective:`, `goal:`, `prompt:`, and `ask:` provide explicit overrides.
- Added `/run` for explicit local workspace commands and `/preview` for local development servers with detected preview URLs.
- Added multiline prompts with `Alt+Enter` and a three-line prompt composer.

### Changed

- Plain text in the TUI is now a prompt instead of an implicit Factory CLI command. Existing administrative commands remain available with `factory ...` or slash commands.
- Objectives remain a dedicated delivery section and no longer need to be selected before asking Factory AI a question.
- Refresh sources are time-bounded and usage synchronization no longer blocks dashboard refresh.
- Long workspace imports, updates, runs, and previews stream in an interruptible terminal process.

### Security

- Quick prompts execute in isolated read-only repository clones and never publish branches.
- Run and preview commands require confirmation and execute in a capability-dropped local Docker sandbox on an internal network. A secret-filtered repository snapshot is copied from a read-only host mount into an ephemeral volume; host credentials, environment, source paths, and Docker sockets are not exposed to executed code.
- Local sandbox commands use structured argv and package-operation allowlists; shell execution, package publishing, credential operations, global installs, and Git pushes are rejected.
- Quick-action state retains at most 500 terminal actions for 30 days; active work is never pruned.
- Shutdown, update, workspace removal, and secret deletion require explicit confirmation in the TUI.

### Fixed

- Displayed workspace and dashboard warnings instead of silently rendering empty state.
- Distinguished failed command output from successful command output.
- Prevented duplicate Enter submissions while a command is active.
- Prevented failed diff retrieval text from being copied as source code.
- Routed keyboard workspace switching through the same context-reset path as picker selection.

## [2.7.3] - 2026-07-15

### Added

- Added native local TUI session and command logs at `~/.local/share/factory-ai/logs/YYYY-MM-DD.jsonl`, explicitly attributed with `client: "Factory AI"`, `source: "factory-ai"`, and `service: "factory-ui"`.
- Added pinned pnpm and Yarn clients plus Python, make, g++, and pkg-config to worker sandboxes for monorepos and native Node dependencies.
- Allowed builders and debuggers to run repository-local pnpm/Yarn workflows while preserving read-only tester restrictions.

### Privacy

- Local logs record only safe event names and top-level command names; they never record prompts, command arguments, responses, source code, or secrets.

## [2.7.2] - 2026-07-15

### Fixed

- Provisioned the durable VM usage directory and granted the snapshot service its narrowly scoped write permission so `factory.usage.v1` publication works on deployed hosts.

## [2.7.1] - 2026-07-15

### Fixed

- Made provider-usage event persistence fail closed so disk/activity failures cannot silently undercount billed requests.
- Added regression coverage for creating objectives directly from `/objective` and `/new`.

## [2.7.0] - 2026-07-15

### Added

- Added the strict privacy-safe `factory.usage.v1` ledger for provider-reported completed-task token usage.
- Added `factory usage sync`, `factory usage report [--json]`, and `factory usage export` with the local ledger at `~/.local/share/factory-ai/usage/usage.jsonl`.
- Added automatic local usage synchronization during TUI refreshes so usage dashboards can identify Factory AI as its own source.

## [2.6.1] - 2026-07-15

### Fixed

- Recovered tool/model errors are cleared when an agent and container complete successfully, so succeeded agents no longer appear failed after workspace switching.
- Genuine failed/retrying/stale tasks use durable result errors, while historical tool failures remain available only in the activity timeline.
- Structured operator logs now include configured `factory` and stable `service` fields, and text dashboards use the configured Factory name.

## [2.6.0] - 2026-07-15

### Added

- Added OpenCode-style slash commands as the primary TUI navigation: `/workspace`, `/workspace add`, `/objective`, `/agent`, `/diff`, `/activity`, `/copy`, `/commands`, `/refresh`, `/help`, and `/quit`.
- Added dynamic slash autocomplete for live workspace names, objective IDs, and agent IDs/roles.

### Changed

- Updated empty states, help, placeholder text, and sidebar hints to teach command-line navigation while retaining the sidebar as optional visual context.

## [2.5.0] - 2026-07-15

### Added

- Added a responsive beginner help overlay with a numbered workspace-to-agent workflow and globally available F1 shortcut.
- Added `Ctrl+Y` clipboard copying for sanitized visible agent patches.
- Added an account-isolated 24-hour warm snapshot cache for immediate TUI rendering.

### Changed

- Parallelized dashboard, logs, catalog, and sync-status refreshes and aligned automatic polling with the one-minute server snapshot cadence.
- Factory-generated project context is tracked with a strict local marker and excluded per generated file, while user-owned context and linked worktrees remain untouched.

### Fixed

- Eliminated the self-inflicted uncommitted-workspace sync error caused by generated `AGENTS.md` and `.agent-factory` files.

## [2.4.2] - 2026-07-15

### Added

- Added a staged CLI progress bar for workspace resolution/cloning, project-context initialization, and readiness while preserving JSON on stdout.

## [2.4.1] - 2026-07-14

### Security

- Moved agent Git and untracked-file inspection fully into a networkless read-only container with no Factory environment and transient Docker-group access.
- Encrypted every diff with a random one-time AES-GCM key before private Blob transport; retained Blob versions contain ciphertext only.
- Added strict metadata validation, resource limits, stale-request rejection, and safe untracked-file handling.

## [2.4.0] - 2026-07-14

### Added

- Added `Ctrl+D` agent code inspection in the TUI for live staged, unstaged, untracked, or latest-checkpoint patches; `Ctrl+A` returns to activity.
- Added `factory agent diff OBJECTIVE_ID TASK_ID` for bounded operator-side patch inspection.

### Security

- Diff generation runs inside a networkless, read-only, capability-dropped, resource-limited container without Factory credentials.
- Agent patches exclude credential file classes, redact common secret formats and terminal controls, use monotonic request IDs, and cross Azure only as one-time AES-GCM encrypted private blobs.

## [2.3.3] - 2026-07-14

### Added

- Added a visible `+ Add workspace...` action and `a` shortcut to the `Ctrl+W` workspace picker, including its empty state.

## [2.3.2] - 2026-07-14

### Fixed

- Routed tester verification through the authenticated primary Azure resource's `gpt-5.4` deployment, removing the stale duplicate GPT-5.4 credential path.
- Excluded infrastructure storage directories from objective-state discovery so dashboard snapshots no longer report irrelevant permission warnings.
- Correctly reports upgraded installations without setup-state files as legacy-ready instead of incomplete.

## [2.3.1] - 2026-07-14

### Fixed

- Replaced repaint-based onboarding with deterministic line prompts so every question appears exactly once, including through the TUI.
- Added durable staged setup resume, reset/deploy/status controls, atomic locking/config writes, authoritative version provenance, credential validation, live provider probes, and complete runtime readiness gating.
- Fixed planner, approved-task, terminal approval, blocked release, successful release, and failure redelivery paths so transient queue or state-write failures cannot strand objectives.
- Fixed names and purposes containing spaces by replacing shell environment expansion with a strict environment-file runner.
- Added atomic managed workspace imports, authoritative default-branch discovery, deterministic objective submission IDs, unattended approval expiration, symmetric shutdown/start, and local/Azure update rollback checks.

### Security

- Key Vault secret values are transferred through mode-0600 temporary files instead of process arguments.
- Runtime environment files are atomically installed as `root:factory` mode `0640`; model-route updates preserve those permissions.

## [2.3.0] - 2026-07-14

### Added

- Added explicit per-workspace two-way GitHub synchronization with one-minute launchd/systemd scheduling, immediate sync, status, and TUI controls.
- Added privacy-filtered bounded per-agent activity timelines to operator snapshots.
- Added an OpenCode-style session stream, agent roster, and stable workspace, objective, and agent picker dialogs.

### Security

- Sync never force-pushes or resets and blocks dirty, detached, divergent, origin-changed, path-changed, ignored-path collision, and executable local Git-configuration states.
- Scheduler activation and consent are rollback-safe, use trusted absolute executables, suppress unbounded logs, and preserve prior scheduler state on failed updates.
- Activity exports use strict field allowlists, bounded tail reads, per-agent limits, and a global dashboard event budget.

## [2.2.1] - 2026-07-14

### Added

- Added contextual command and workspace autocomplete with inline suggestions and keyboard acceptance.
- Added mouse and keyboard workspace selection, clickable tabs and agents, and detailed per-agent activity inspection.

### Changed

- Reorganized `factory help` into a concise, grouped command reference with descriptions and TUI controls.

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
