# Factory AI Handoff

## Product

Azure-hosted autonomous coding factory with one CEO interface, deterministic CTO orchestration, isolated role agents, durable queues/state, curated skills/MCP, GitHub checkpoints, approval gates, CLI dashboard, and hourly reports.

## Azure resources

- Resource group: configured by `FACTORY_RESOURCE_GROUP`
- VM: configured by `FACTORY_VM`
- Service Bus: configured by `FACTORY_SERVICE_BUS`
- Key Vault: configured by `FACTORY_KEY_VAULT`
- Queues: `control-events`, `agent-tasks`, `release-tasks`

Infrastructure is reproducible from `infra/main.bicep`. Runtime is installed from a pinned Git commit. See `ARCHITECTURE.md`, `RUNBOOK.md`, and `SECURITY.md` before changing production behavior.

Global API keys belong in Key Vault, never repository `.env` files. Use `bin/factory secret` commands; temporary operator IP access is removed automatically after each command.

For GitHub Enterprise Cloud, keep the `github.com` host. Run `bin/factory github connect ORG` with an organization-authorized `gh` session, then explicitly transfer repositories with `bin/factory github transfer OWNER/REPO ORG`.

## Known platform limitation

Private-repository branch protection and auto-merge depend on the GitHub account or organization plan. Factory AI leaves approved PRs open whenever repository policy does not permit auto-merge.
