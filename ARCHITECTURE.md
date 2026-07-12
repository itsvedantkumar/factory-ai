# Architecture

The CEO submits one objective. A deterministic control service persists state and delegates planning to an isolated planner container. It validates the returned DAG, dispatches one container per task through Service Bus, records results, enforces tester/reviewer/security approval, and sends approved publication to a separate release service.

The control service has no model, shell, Git, workspace, Docker, Key Vault secret-loading, or release implementation. Agent containers have bounded CPU, memory, PIDs, steps, output, runtime, filesystem mounts, commands, skills, and MCP tools. GitHub credentials remain on trusted host services.

Durability comes from Service Bus peek-lock/redelivery, systemd supervision, a retained Premium SSD, atomic state writes, Git checkpoints, and GitHub pull requests. Benchmarked GPT-5.4 nano handles scouting, GPT-5.4 handles independent testing, Kimi K2.7-Code handles implementation, and GPT-5.6 handles planning, debugging, review, security, and release analysis.

Trust boundaries: CEO input and repository content are untrusted; capability definitions are pinned and allowlisted; agent containers cannot publish; the release bot cannot bypass approval gates; Azure credentials are loaded from Key Vault into process memory.
