# Factory AI

<div align="center">

**Securely deploy your own autonomous software-engineering factory on Azure.**

One CEO interface delegates to a deterministic CTO that coordinates isolated coding, testing, security, and release agents across Azure AI and Bedrock—then delivers verified GitHub pull requests with durable memory, recovery, and cost visibility.

[![CI](https://github.com/itsvedantkumar/factory-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/itsvedantkumar/factory-ai/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/factory-ai.svg?logo=npm)](https://www.npmjs.com/package/factory-ai)
[![npm downloads](https://img.shields.io/npm/dm/factory-ai.svg)](https://www.npmjs.com/package/factory-ai)
[![Node 20](https://img.shields.io/badge/node-20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Azure](https://img.shields.io/badge/runtime-Azure-0078D4?logo=microsoftazure)](https://azure.microsoft.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

## Why Factory AI?

Most coding-agent setups are interactive sessions pretending to be infrastructure. Factory AI is an actual delivery system:

- Objectives survive terminal closures, model interruptions, VM reboots, and worker crashes.
- The orchestrator cannot edit code, execute shell commands, access model credentials, or publish releases.
- Every task runs in a bounded, disposable container and isolated Git branch.
- Tester, reviewer, and security agents must approve before the trusted release bot opens a PR.
- Project memory, queue state, costs, logs, and hourly progress remain visible from one CLI.

## Quick Start

Requirements: Node.js 22, [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), [GitHub CLI](https://cli.github.com/), `az login`, and `gh auth login`.

```bash
npm install -g factory-ai
factory setup
```

The numbered, line-oriented wizard emits each question once and safely resumes saved onboarding answers after interruption. A GitHub organization is not required; personal repositories work by default.

1. Select Azure AI Foundry, AWS Bedrock, or hybrid routing.
2. Select infrastructure region and optional GitHub Enterprise organization.
3. Enter provider credentials through hidden prompts.
4. Let the installer create Azure infrastructure, Key Vault secrets, model routing, and supervised services.
5. Start shipping.

```bash
factory workspace import ~/Projects/my-app --name my-app
factory submit my-app "/goal ship authenticated health checks"
factory ui
```

## Operator Experience

```text
╔═ FACTORY AI ════════════════════════════════════════════════╗
  Worker active · queue 0 · DLQ 0 · Azure MTD INR 16,068.56
  Objectives complete:12 running:2 failed:1

  [running] Add authenticated health checks
    succeeded  scout     GPT-5.4 nano  · inspect conventions
    running    builder   GPT-5.5       · implement contract
    blocked    tester    GPT-5.4       · verify behavior
    blocked    reviewer  GPT-5.6       · review correctness
    blocked    security  GPT-5.6       · assess boundaries
    blocked    release   GPT-5.6       · publish reviewed PR
╚══════════════════════════════════════════════════════════════╝
```

| Command | Purpose |
| --- | --- |
| `factory setup` | Interactive cloud/provider installation |
| `factory ui` | Full-screen interactive admin console |
| `factory workspace import PATH\|OWNER/REPO` | Import or clone a repository into the persistent workspace catalog |
| `factory workspace list` | List named workspaces, local paths, branches, and repositories |
| `factory workspace show NAME` | Inspect one workspace |
| `factory workspace remove NAME` | Remove a catalog entry without deleting repository files |
| `factory workspace sync enable NAME` | Opt into automatic two-way committed-change sync |
| `factory workspace sync now NAME` | Push local commits or fast-forward from GitHub immediately |
| `factory workspace sync status` | Show scheduler and per-workspace synchronization state |
| `factory submit WORKSPACE "OBJECTIVE"` | Send one CEO objective using a workspace name; owner/repo remains supported |
| `factory update check` | Compare the installed CLI with the latest stable npm release |
| `factory update now` | Run verified Azure updater immediately and update the local CLI |
| `factory update status` | Show automatic-update timer and deployed runtime version |
| `factory update enable\|disable` | Control the six-hour verified automatic-update timer |
| `factory issue OWNER/REPO NUMBER` | Turn a GitHub issue into a tracked objective |
| `factory telegram configure` | Configure allowlisted Telegram remote intake |
| `factory dashboard` | Objectives, agents, models, queue, DLQ, and Azure cost |
| `factory init PATH` | Create `AGENTS.md` and durable repo-local project context without overwriting existing files |
| `factory models show` | Show effective role-to-model routes |
| `factory models set ROLE PROVIDER/MODEL` | Validate and atomically switch a role to a new model |
| `factory models reset ROLE` | Restore a role to the versioned default |
| `factory configure models` | Interactively change model routing after setup |
| `factory acp REQUEST.json` | Submit a strictly validated optional ACP objective |
| `factory extension verify MANIFEST ARTIFACT PUBLIC_KEY` | Verify a signed extension manifest and immutable artifact digest |
| `factory doctor` | Services, storage, memory, and host health |
| `factory queue` | Queue and dead-letter depth |
| `factory logs` | Consolidated service logs |
| `factory report` | Latest hourly executive report |
| `factory pause` / `resume` | Pause or resume execution safely |
| `factory shutdown` / `start` | Disable or re-enable the complete runtime; Azure resources remain allocated |
| `factory secret set NAME` | Store a credential in global Key Vault |
| `factory github connect ORG` | Connect GitHub Enterprise credentials |

Inside `factory ui`, type slash commands directly: `/workspace`, `/workspace NAME`, `/workspace add OWNER/REPO`, `/objective`, `/agent`, `/diff`, `/copy`, `/commands`, `/refresh`, `/help`, or `/quit`. Autocomplete includes live workspace, objective, and agent identifiers. The sidebar remains optional visual context, and keyboard shortcuts continue to work. Warm starts render the last account-bound snapshot immediately while a parallel refresh runs.

Two-way workspace sync is explicit and non-destructive. Enabling it installs a per-user launchd or systemd timer that runs every minute. Clean default branches fast-forward from GitHub or push ordinary local commits without force. Dirty worktrees, detached heads, changed origins, non-default branches, divergence, conflicts, and rejected pushes are marked blocked for manual resolution; Factory never resets or overwrites them.

## Architecture

```mermaid
flowchart TD
    CEO[CEO CLI] --> CQ[Control Queue]
    CQ --> CTO[Deterministic CTO Control Plane]
    CTO --> AQ[Agent Task Queue]
    AQ --> P[Planner Container]
    AQ --> S[Scout Container]
    AQ --> B[Builder Container]
    AQ --> T[Tester Container]
    AQ --> V[Reviewer and Security Containers]
    P & S & B & T & V --> CQ
    CTO -->|approval gate passed| RQ[Release Queue]
    RQ --> RB[Trusted Release Bot]
    RB --> PR[GitHub Pull Request]
    KV[Azure Key Vault] --> B
    SB[(Retained State Disk)] --> CTO
    MEM[Unified Project Memory] --> P
```

The CTO is deliberately capability-free. It stores state, validates DAGs, dispatches tasks, and enforces gates. Model calls, Git workspaces, shell tools, MCP servers, and release credentials live behind separate trust boundaries.

See [ARCHITECTURE.md](ARCHITECTURE.md) for details.

## Model Routing

Defaults are evidence-based and role-specific:

| Role | Default | Rationale |
| --- | --- | --- |
| Scout | GPT-5.4 nano | Low-cost search and repository inspection |
| Simple builder task | Kimi K2.7-Code | Economy coding path, independently reviewed |
| Complex/unspecified builder task | GPT-5.5 | Faster benchmarked implementation default |
| Tester | GPT-5.4 | Independent behavioral verification |
| Planner, debugger, reviewer, security, release | GPT-5.6 | Higher-judgment work |

Any role can be overridden with an Azure deployment or `bedrock/MODEL_ID`. Bedrock uses the Converse tool API behind the same sandbox and approval gates.

## Token and Cost Efficiency

Factory AI minimizes tokens before relying on cheaper models:

- GPT-5.4 nano scouts, Kimi handles explicitly simple coding, GPT-5.5 handles complex coding, and GPT-5.6 is reserved for high-judgment roles.
- Stable guardrail/skill prompt prefixes improve provider prompt-cache reuse.
- Every role has explicit step and output-token budgets.
- File reads are line-ranged and bounded; listings, commands, MCP output, memory, and scanner evidence are truncated with continuation hints.
- Read-only roles do not receive write-tool schemas.
- Planner memory is compact, repository-scoped, and limited to recent verified events.
- Ollama generates local embeddings and Qdrant retrieves only top-ranked code chunks, avoiding embedding API charges and whole-repository prompts.
- Dashboard and TUI track input, cached-input, and output tokens by model.
- The planner is instructed to produce the smallest valid DAG, avoiding duplicate agents.

## Reliability

- Azure Service Bus peek-lock delivery, duplicate detection, retries, and dead letters
- systemd restart supervision and reboot recovery
- Atomic objective state on a retained Premium SSD
- One self-contained clone and branch per task
- Continuous trusted Git checkpoint pushes
- Bounded model steps, execution time, output, CPU, memory, and PIDs
- Permanent failures become explicit objective results instead of stale tasks
- Hourly durable executive reports

The production smoke suite has verified worker `SIGKILL`, message redelivery, reboot persistence, gated PR publication, and content-filter failure handling.

## Memory and Skills

Every repository gets two memory layers:

- Deterministic project events injected into future planner context
- Pinned MCP knowledge-graph memory on retained storage

Built-in progressive skills include `/goal`, `/loop`, project context, systematic debugging, TDD, verification, security review, dependency security, browser verification, release discipline, and token efficiency. Context7 and Playwright MCPs are pinned and role-scoped.

Use `factory init PATH` to create a safe root `AGENTS.md` plus `.agent-factory/` project, architecture, commands, decisions, risks, and handoff files without overwriting existing context. The runtime discovers repository `AGENTS.md` instructions for planners and workers. Active Azure and Bedrock conversations compact automatically after their configured token threshold while preserving bounded recent tool evidence.

`factory workspace import` performs this initialization automatically and persists the repository URL, local path, workspace name, and base branch in `~/.config/factory-ai/workspaces.json`. GitHub references are cloned into `~/Factory Workspaces/`; local repositories remain in place.

## Credentials

Credentials never belong in repository `.env` files. Store them globally:

```bash
factory secret set SERVICE-API-KEY
factory secret list
factory secret copy SERVICE-API-KEY
```

Values are held in Azure Key Vault, loaded into trusted process memory, and passed only to role-required containers. Secret values are never displayed by the CLI.

## GitHub Enterprise

GitHub Enterprise Cloud continues to use `github.com`:

```bash
gh auth refresh -h github.com -s admin:org,repo,workflow,read:org
factory github status
factory github connect YOUR_ORG
factory github transfer OWNER/REPO YOUR_ORG
```

Organization rulesets can then enforce private-repo status checks, reviews, and auto-merge.

## Telegram Remote Control

Create a bot with `@BotFather`, obtain your numeric chat ID, then run:

```bash
factory telegram configure
```

Only explicitly allowlisted chat IDs are accepted. Supported commands:

```text
/submit OWNER/REPO objective
/goal OWNER/REPO objective
/loop OWNER/REPO objective
/status
/help
```

Set a default repository with `/repo OWNER/REPO`, then send plain-text instructions without a command. `/recent` lists recent objectives and `/objective ID` shows task-level detail. Factory AI automatically pushes deduplicated status, active-agent, completion, PR, failure, and blocker updates to the originating chat.

Telegram cannot run shell commands, read secrets, modify release policy, or bypass review gates. Durable update offsets, repository preferences, and objective subscriptions survive restarts.

## Verified Automatic Updates

The VM checks npm stable releases every six hours with a randomized delay. Updates are accepted only when:

- The release remains within the installed major version.
- npm `gitHead` resolves to the exact GitHub commit.
- The commit has successful CI.
- A fresh isolated clone passes install, syntax, lint, tests, dependency audit, Bicep, shell validation, and Gitleaks.

The updater records the installed version on retained storage and restores the previous commit if deployment fails. Major upgrades always require explicit operator action.

## Security

- No VM public IP or inbound network path
- Stable outbound-only NAT
- Managed identity and RBAC
- Subnet-restricted Key Vault
- Trusted Launch, Secure Boot, and vTPM
- Read-only worker image, dropped capabilities, `no-new-privileges`, and no Docker socket
- GitHub publication isolated from model-controlled containers
- Pinned dependencies, MCPs, skills, and runtime revisions
- CI, Dependabot, npm audit, Trivy vulnerability/secret/misconfiguration scans

Read [SECURITY.md](SECURITY.md) before adding tools, providers, or permissions.

## Development

```bash
git clone https://github.com/itsvedantkumar/factory-ai.git
cd factory-ai
npm ci
npm run check
npm run lint
npm test
npm audit --audit-level=high
az bicep build --file infra/main.bicep --stdout >/dev/null
bash -n bootstrap/setup.sh bootstrap/deploy-runtime.sh bin/factory
npm pack --dry-run
```

## Documentation

| Document | Purpose |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Runtime, boundaries, and data flow |
| [RUNBOOK.md](RUNBOOK.md) | Operations, recovery, and cost control |
| [SECURITY.md](SECURITY.md) | Security policy and extension rules |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development and verification contract |
| [HANDOFF.md](HANDOFF.md) | Team/friend transfer context |
| [docs/COMPARISON.md](docs/COMPARISON.md) | Honest comparison with paid alternatives |
| [docs/HARNESS_PARITY.md](docs/HARNESS_PARITY.md) | Feature parity across modern agent harnesses |
| [ROADMAP.md](ROADMAP.md) | Planned platform and ecosystem work |
| [GOVERNANCE.md](GOVERNANCE.md) | Decision and release governance |
| [SUPPORT.md](SUPPORT.md) | Community support process |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Community standards |

## Current Limitations

- Azure Cost Management data is authoritative but delayed.
- Private-repo auto-merge requires an eligible GitHub Team/Enterprise organization policy.
- Kimi is used only for explicitly simple coding tasks until broader evaluations justify expansion.
- npm releases are verified and published with provenance through GitHub Actions.

## License

[MIT](LICENSE)
