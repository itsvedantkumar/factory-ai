# Factory AI Usage Ledger

Factory AI writes provider-reported completed-task usage using the strict,
content-free `factory.usage.v1` schema. Records never contain prompts,
responses, source code, repositories, commands, user identities, or secrets.

Default local path:

```text
~/.local/share/factory-ai/usage/*.jsonl
```

Commands:

```bash
factory usage sync
factory usage report
factory usage report --json
factory usage export
```

Each JSONL record contains a stable record ID, timestamp, Factory source,
objective/session and task IDs, role, provider, model, and provider-reported
input, output, cache-read, and optional cache-write token counts.
