# Security Policy

Report vulnerabilities privately to the repository owner. Do not open public issues containing credentials, exploit details, or customer repository data.

Never commit secrets. Azure model and GitHub credentials belong in Key Vault. The control service must remain capability-free. New MCP servers, skills, dependencies, commands, and network access require pinning, role scoping, tests, and review. Agent containers must not receive GitHub credentials or the Docker socket.

Before release run `npm audit --audit-level=high`, tests, lint, Bicep compilation, shell syntax checks, secret scanning, and container scanning. Rotate credentials after confirmed disclosure.
