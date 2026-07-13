const APPROVAL_ROLES = new Set(["tester", "reviewer", "security"]);

export function evaluateReleaseGate(tasks, results, facts = {}) {
  const blockers = [];
  for (const task of tasks.filter((candidate) => APPROVAL_ROLES.has(candidate.role))) {
    const result = results[task.id];
    if (result?.status !== "succeeded" || result.approval !== "approved") blockers.push(`${task.role} ${task.id}: ${result?.approval ?? result?.status ?? "missing"}`);
    for (const scan of result?.scannerEvidence ?? []) if (scan.status !== "passed") blockers.push(`${task.role} ${task.id}: ${scan.scanner} ${scan.status}`);
  }
  const approvals = facts.approvals ?? blockers.length === 0;
  return { approved: approvals, blockers, autoMerge: approvals && facts.policyAllows === true && facts.checksPass === true };
}
