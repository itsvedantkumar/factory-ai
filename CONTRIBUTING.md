# Contributing

Use a branch and pull request. Keep changes small, add a failing test first, and preserve trust boundaries. Run:

```bash
npm ci
npm run check
npm run lint
npm test
npm audit --audit-level=high
az bicep build --file infra/main.bicep --stdout >/dev/null
bash -n bootstrap/setup.sh bootstrap/deploy-runtime.sh bin/factory
```

Validate package distribution with `npm pack --dry-run` and a clean-prefix install whenever setup, dependencies, package metadata, or the `factory` executable changes.

Do not add unpinned dependencies, arbitrary MCP installation, direct base-branch pushes, secret values, or model-controlled release authority.
