# Operator Runbook

## Daily commands

```bash
bin/factory setup
bin/factory github status
bin/factory github connect YOUR_ENTERPRISE_ORG
bin/factory workspace import /path/to/new-project --name project
bin/factory submit project "/loop ship the objective"
bin/factory secret list
bin/factory secret set SERVICE-NAME-API-KEY
bin/factory secret copy SERVICE-NAME-API-KEY
bin/factory telegram configure
bin/factory telegram status
bin/factory dashboard
bin/factory queue
bin/factory logs
bin/factory report
bin/factory doctor
bin/factory pause
bin/factory resume
```

Fresh install:

```bash
npm install -g factory-ai
factory setup
factory setup --status
```

Override defaults with `FACTORY_RESOURCE_GROUP`, `FACTORY_VM`, and `FACTORY_SERVICE_BUS`.

Verified stable updates run every six hours through `factory-ai-update.timer`. Inspect with `systemctl status factory-ai-update.timer` and `journalctl -u factory-ai-update.service`. Automatic major-version upgrades are intentionally blocked.

## Recovery

If a worker dies, systemd restarts it and Service Bus redelivers after lock expiry. Do not manually duplicate the task. Check `dashboard`, then `logs`, then queue dead-letter counts. Preserve objective state before purging dead letters.

Deploy only a full commit SHA through `bootstrap/deploy-runtime.sh`. Setup builds an immutable local worker image and restarts supervised services. State lives at `/opt/agent-factory/state` on the retained data disk.

Interrupted setup retains answers in `~/.config/factory-ai/setup-state.json`; rerun `factory setup` to resume, `factory setup --deploy` after a foundation-only setup, or `factory setup --reset` to answer onboarding again. If setup is killed before cleanup, verify its recorded process is gone before manually removing the `~/.config/factory-ai/setup.lock` symlink.

For a stuck planning or approved objective, do not submit a duplicate. Inspect control logs and allow Service Bus to redeliver the original objective or approval decision; dispatch uses deterministic message IDs. For dead-lettered messages, preserve `/opt/agent-factory/state/<objective-id>` before replay or removal.

`factory shutdown` disables the full runtime and timers. `factory start` restores them. These commands do not delete Azure resources. For complete decommissioning, first retain or export `/opt/agent-factory/state`, then delete the dedicated resource group explicitly with Azure tooling after confirming its contents.

## Cost control

Pause workers before deallocating the VM. Deallocation stops compute but not disk, NAT, Service Bus, Key Vault, or model charges. Resume and run `doctor` after startup.
