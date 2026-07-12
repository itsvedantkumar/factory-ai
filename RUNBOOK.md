# Operator Runbook

## Daily commands

```bash
bin/factory setup
bin/factory github status
bin/factory github connect YOUR_ENTERPRISE_ORG
bin/factory submit OWNER/REPO "/loop ship the objective"
bin/factory init /path/to/new-project
bin/factory secret list
bin/factory secret set SERVICE-NAME-API-KEY
bin/factory secret copy SERVICE-NAME-API-KEY
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
npm install -g github:itsvedantkumar/agent-factory
factory setup
```

Override defaults with `FACTORY_RESOURCE_GROUP`, `FACTORY_VM`, and `FACTORY_SERVICE_BUS`.

## Recovery

If a worker dies, systemd restarts it and Service Bus redelivers after lock expiry. Do not manually duplicate the task. Check `dashboard`, then `logs`, then queue dead-letter counts. Preserve objective state before purging dead letters.

Deploy only a full commit SHA through `bootstrap/deploy-runtime.sh`. Setup builds an immutable local worker image and restarts supervised services. State lives at `/opt/agent-factory/state` on the retained data disk.

## Cost control

Pause workers before deallocating the VM. Deallocation stops compute but not disk, NAT, Service Bus, Key Vault, or model charges. Resume and run `doctor` after startup.
