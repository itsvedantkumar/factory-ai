# Handoff

## Product

Azure-hosted autonomous coding factory with one CEO interface, deterministic CTO orchestration, isolated role agents, durable queues/state, curated skills/MCP, GitHub checkpoints, approval gates, CLI dashboard, and hourly reports.

## Azure resources

- Resource group: `rg-vedant-3569`
- VM: `agent-factory-vm`
- Service Bus: `af-4jelq52xdxoty`
- Key Vault: `af4jelq52xdxoty`
- Queues: `control-events`, `agent-tasks`, `release-tasks`

Infrastructure is reproducible from `infra/main.bicep`. Runtime is installed from a pinned Git commit. See `ARCHITECTURE.md`, `RUNBOOK.md`, and `SECURITY.md` before changing production behavior.

## Known platform limitation

GitHub refuses branch protection and auto-merge for private repositories on the current account plan. The factory therefore leaves approved PRs open. Upgrade the plan or use eligible repositories to enable policy-controlled auto-merge.
