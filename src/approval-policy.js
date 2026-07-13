export const approvalPolicies = Object.freeze([
  "network_expansion",
  "new_dependencies",
  "infrastructure_changes",
  "secret_metadata_changes",
  "external_side_effects",
]);

export function evaluateApprovalPolicy(signals = {}) {
  const policies = approvalPolicies.filter((policy) => signals[policy] === true);
  return { required: policies.length > 0, policies };
}
