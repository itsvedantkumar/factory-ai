---
name: autonomous-loop
description: Runs /loop objectives through plan, act, verify, reflect, and retry cycles. Use for autonomous delivery and root-cause repair.
metadata:
  version: "1.0.0"
---

# Autonomous Loop

Plan the smallest dependency graph, execute through isolated agents, verify against actual commands, and reflect on failures before retrying. Retries must change the hypothesis or action; never repeat an identical failed attempt. Persist checkpoints after meaningful progress. Stop only for an external blocker, exhausted bounded retries, or verified completion.
