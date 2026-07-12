# Azure Agent Factory

Private Azure Linux host for a durable, bounded CTO and isolated custom Azure Responses API workers.

## One-command install

Requirements: Node 20, Azure CLI, GitHub CLI, and authenticated `az login` / `gh auth login` sessions.

```bash
npm install -g github:itsvedantkumar/agent-factory
factory setup
```

The arrow-key wizard selects Azure Foundry, AWS Bedrock, or both; creates Azure infrastructure; prompts for credentials without printing them; stores credentials in Key Vault; optionally connects a GitHub Enterprise organization; configures role-level models; and deploys a pinned runtime revision. Nothing requires hand-editing JSON.

For development from source:

```bash
git clone https://github.com/itsvedantkumar/agent-factory.git
cd agent-factory
npm ci
bin/factory setup
```

## Runtime

`agent-factory-ceo` validates and sends one objective to Azure Service Bus. The CTO runs GPT-5.6, creates a validated DAG, and dispatches ready tasks with deterministic message IDs. Task handlers emit separate, strictly validated result messages before the CTO advances the graph. A single worker process uses peek-lock settlement, automatic lock renewal, explicit retries/dead-lettering, and at most three concurrent handlers.

Roles and routing:

| Role | Model |
| --- | --- |
| scout | `azureai-textved/factory-gpt-5-4-nano` |
| tester | `azureai-responses/gpt-5.4` |
| builder | `azureai-textved/factory-kimi-k2-7-code` |
| planner, debugger, reviewer, security, release | `azureai-textved/gpt-5.6-sol` |

Any role can be overridden during setup with a `bedrock/MODEL_ID` route. Bedrock uses the Converse tool API behind the same filesystem, command, MCP, timeout, and release gates.

Each objective has durable JSON state in `/opt/agent-factory/state/<objective-id>`. Each task gets a branch and self-contained Git clone under `/opt/agent-factory/workspaces/<objective-id>`. Agents commit milestone checkpoints; the trusted runtime periodically pushes only the explicit task-branch refspec and always pushes a final checkpoint. A release is withheld unless tester, reviewer, and security roles explicitly approve. The terminal release branch integrates their dependency commits, creates or updates the PR, waits for required checks, and enables GitHub auto-merge only when checks pass and repository policy allows auto-merge. It never pushes the base branch.

Capabilities are selected per task from `config/capabilities.json`. Entries require a version, role allowlist, and absolute local skill path or MCP executable. Context7, Playwright, and official knowledge-graph memory MCPs are pinned and role-scoped. Agents cannot run `gh`, push Git refs, add MCP definitions, or install global tools; trusted runtime code performs branch pushes and releases.

## Security model

- no public IP on the VM and no inbound network access
- explicit NAT Gateway provides stable outbound internet access
- SSH key authentication only
- Azure Run Command for initial administration
- system-assigned managed identity reads model credentials from Key Vault
- Azure Service Bus persists tasks, retries interrupted work, and dead-letters repeated failures
- credentials never enter Bicep, cloud-init, deployment history, static environment files, or Terraform state
- Trusted Launch, Secure Boot, vTPM, automatic patching, fail2ban, and unattended upgrades

## Capacity

Default VM: `Standard_D8as_v5`, 8 vCPUs, 32 GB RAM, 256 GB Premium SSD.

The runtime enforces a maximum of three concurrent handlers.

## VM Bootstrap

For a fresh subscription or friend handoff:

```bash
git clone https://github.com/itsvedantkumar/agent-factory.git
cd agent-factory
bin/factory setup
bin/factory github status
```

The setup script expects this repository to be staged at `/opt/agent-factory/app`. It verifies Key Vault access with the VM managed identity. On every worker start, the Node SDK retrieves secrets into process memory; secret values are never written to the service environment file or command output. Existing Key Vault secret names default to:

- `azure-primary-api-key`
- `azure-primary-base-url`
- `azure-small-api-key`
- `azure-small-base-url`
- `github-token`

Names can be overridden with the corresponding `*_SECRET` environment variables in `bootstrap/setup.sh`. Run on the VM after staging the application:

```bash
sudo KEY_VAULT_NAME='<vault-name>' \
  SERVICE_BUS_NAMESPACE='af-4jelq52xdxoty' \
  SERVICE_BUS_QUEUE='code-tasks' \
  bash /opt/agent-factory/app/bootstrap/setup.sh
```

The script installs Node 20, Azure CLI, `gh`, production npm dependencies, a root-owned environment file, and `agent-factory-worker.service`. It is intended to be rerunnable. Verify on Ubuntu with:

```bash
sudo systemd-analyze verify /etc/systemd/system/agent-factory-worker.service
sudo systemctl status agent-factory-worker.service
sudo journalctl -u agent-factory-worker.service -f
```

To stage a pinned source revision and run setup through Azure Run Command, execute this operator command from the repository root. This installs the runtime only; it does not deploy or modify Bicep resources:

```bash
az vm run-command invoke --resource-group '<resource-group>' --name '<vm-name>' \
  --command-id RunShellScript --scripts @bootstrap/deploy-runtime.sh \
  --parameters \
    KEY_VAULT_NAME='<vault-name>' \
    SERVICE_BUS_NAMESPACE='af-4jelq52xdxoty' \
    SERVICE_BUS_QUEUE='code-tasks' \
    SOURCE_REPOSITORY='OWNER/agent-factory' \
    SOURCE_REF='<40-character-commit-sha>'
```

## CEO CLI

Recommended operator interface:

```bash
bin/factory submit OWNER/REPO "/loop ship this objective"
bin/factory dashboard
bin/factory queue
bin/factory doctor
```

Slash workflows available to the planner include `/goal` for rubric-driven outcomes and `/loop` for autonomous plan-act-verify-reflect delivery. Durable project knowledge is shared through the pinned MCP memory server on the retained data disk.

Run on the VM so `--wait` can read the local durable result. Without `--wait`, any identity with Service Bus Data Sender access can enqueue when the same environment configuration is present.

```bash
sudo systemd-run --wait --pipe --collect --uid=factory --gid=factory \
  --property=EnvironmentFile=/etc/agent-factory.env \
  --property=Environment=HOME=/opt/agent-factory/state/home \
  --property=WorkingDirectory=/opt/agent-factory/app \
  /usr/bin/node /opt/agent-factory/app/src/ceo.js \
  --repo https://github.com/OWNER/REPOSITORY.git \
  --base main --wait \
  "Ship the CEO objective with tests and a review-ready pull request"
```

## Development

```bash
npm ci
npm run check
npm run lint
npm test
npm audit --audit-level=high
az bicep build --file infra/main.bicep --stdout >/dev/null
bash -n bootstrap/setup.sh
```

## Infrastructure

Deployment remains an explicit operator action with `infra/main.bicep`; this runtime does not deploy. The queue definition uses duplicate detection, a seven-day duplicate history, five-minute locks, eight deliveries, and dead-lettering. Applying the Bicep is required to update an already-deployed queue to the seven-day history window.

If infrastructure deployment is intentionally required later, preview first, then deploy explicitly:

```bash
az deployment group what-if --resource-group '<resource-group>' --template-file infra/main.bicep --parameters adminSshKey='<public-key>' operatorObjectId='<object-id>'
az deployment group create --resource-group '<resource-group>' --template-file infra/main.bicep --parameters adminSshKey='<public-key>' operatorObjectId='<object-id>'
```

## Cost Notes

Azure charges accrue for the `Standard_D8as_v5` VM and Premium SSD while allocated, plus NAT Gateway hourly/data processing, Standard Service Bus operations, Key Vault operations, outbound bandwidth, Azure OpenAI tokens, and any GitHub plan usage. Model tokens usually dominate variable workload cost. Set Azure budgets and alerts, monitor token and queue metrics, and deallocate the VM only when queued work is drained; deallocation stops compute charges but also stops processing.

`bin/factory dashboard` and hourly reports show actual Azure resource-group month-to-date cost. Cost Management data can be delayed.

## Operational Limits

- `--wait` polls VM-local state; there is no external result API.
- Objective state and unified memory live on a retained Premium data disk. Task workspaces remain disposable and GitHub is their durable checkpoint.
- Concurrent branches are merged only when a downstream task starts. Merge conflicts retry and ultimately dead-letter for operator intervention.
- A PR requires the Key Vault GitHub token to have repository push and pull-request permissions.
- The GitHub token should be a fine-grained token restricted to intended repositories; branch protection and required GitHub reviews remain the final authority.
- Required checks that stay pending consume the release timeout and then appear as blockers; rerun or resubmit after correcting CI.
- Azure Responses API and tool calling must be smoke-tested against both target model deployments before enabling production objectives.

## Documentation

- Architecture and trust boundaries: `ARCHITECTURE.md`
- Operations and recovery: `RUNBOOK.md`
- Security policy: `SECURITY.md`
- Contributor setup: `CONTRIBUTING.md`
- Friend/team handoff: `HANDOFF.md`
