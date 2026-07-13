#!/usr/bin/env bash
set -euo pipefail

exec 9>/var/lock/factory-ai-update.lock
flock -n 9 || { printf 'Factory AI update already running.\n'; exit 0; }

app=/opt/agent-factory/app
state=/opt/agent-factory/state
status=$(FACTORY_PACKAGE_FILE="$app/package.json" node "$app/src/updater.js")
available=$(jq -r .updateAvailable <<<"$status")
[[ $available == true ]] || { printf 'Factory AI is current: %s\n' "$(jq -r .current <<<"$status")"; exit 0; }

version=$(jq -r .latest <<<"$status")
commit=$(jq -r .gitHead <<<"$status")
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { printf 'npm release does not contain a valid gitHead.\n' >&2; exit 1; }

set -a
source /etc/agent-factory.env
set +a
github_token=$(az keyvault secret show --vault-name "$KEY_VAULT_NAME" --name github-token --query value --output tsv)
tag_commit=$(GH_TOKEN="$github_token" gh api "repos/itsvedantkumar/factory-ai/commits/v$version" --jq .sha)
[[ $tag_commit == "$commit" ]] || { printf 'npm gitHead does not match the immutable release tag.\n' >&2; exit 1; }
release_ok=$(GH_TOKEN="$github_token" gh release view "v$version" --repo itsvedantkumar/factory-ai --json isDraft,isPrerelease --jq '(.isDraft == false) and (.isPrerelease == false)')
[[ $release_ok == true ]] || { printf 'Matching stable GitHub release is unavailable.\n' >&2; exit 1; }
provenance=$(npm view "factory-ai@$version" dist.attestations.provenance.url 2>/dev/null || true)
[[ $provenance == https://search.sigstore.dev/* ]] || { printf 'npm release lacks verifiable provenance metadata.\n' >&2; exit 1; }
checks=$(GH_TOKEN="$github_token" gh api "repos/itsvedantkumar/factory-ai/commits/$commit/check-runs" --jq '[.check_runs[] | select(.name == "verify") | .conclusion] | any(. == "success")')
[[ $checks == true ]] || { printf 'Candidate commit lacks successful CI verification.\n' >&2; exit 1; }

temporary=$(mktemp -d /var/tmp/factory-ai-update.XXXXXX)
trap 'rm -rf "$temporary"; unset github_token' EXIT
previous_commit=$(jq -r '.commit // empty' "$state/runtime-version.json" 2>/dev/null || true)
cp "$app/bootstrap/deploy-runtime.sh" "$temporary/rollback-deploy.sh"
GH_TOKEN="$github_token" gh repo clone itsvedantkumar/factory-ai "$temporary/source" -- --no-checkout
git -C "$temporary/source" checkout --detach "$commit"
test "$(git -C "$temporary/source" rev-parse HEAD)" = "$commit"

npm ci --prefix "$temporary/source"
npm run check --prefix "$temporary/source"
npm run lint --prefix "$temporary/source"
npm test --prefix "$temporary/source"
npm audit --prefix "$temporary/source" --audit-level=high
az bicep build --file "$temporary/source/infra/main.bicep" --stdout >/dev/null
bash -n "$temporary/source/bootstrap/setup.sh" "$temporary/source/bootstrap/deploy-runtime.sh" "$temporary/source/bin/factory"
docker run --rm --read-only --volume "$temporary/source:/workspace:ro" \
  zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f \
  detect --source /workspace --redact --no-banner --exit-code 1

printf 'Deploying Factory AI %s (%s)\n' "$version" "$commit"
deployment_parameters=(
  KEY_VAULT_NAME "$KEY_VAULT_NAME"
  SERVICE_BUS_NAMESPACE "$SERVICE_BUS_NAMESPACE"
  SOURCE_REPOSITORY itsvedantkumar/factory-ai
  SOURCE_REF "$commit"
)
for variable in FACTORY_STORAGE_ACCOUNT FACTORY_NAME FACTORY_PURPOSE AWS_REGION FACTORY_MODEL_SCOUT FACTORY_MODEL_PLANNER FACTORY_MODEL_BUILDER FACTORY_MODEL_TESTER FACTORY_MODEL_DEBUGGER FACTORY_MODEL_REVIEWER FACTORY_MODEL_SECURITY FACTORY_MODEL_RELEASE FACTORY_COMPACT_AFTER_INPUT_TOKENS FACTORY_COMPACT_MAX_CHARACTERS FACTORY_WATCHDOG_STALE_SECONDS FACTORY_HOOKS_JSON; do
  [[ -n ${!variable:-} ]] && deployment_parameters+=("$variable" "${!variable}")
done
if ! bash "$temporary/source/bootstrap/deploy-runtime.sh" "${deployment_parameters[@]}"; then
  printf 'Candidate deployment failed. Restoring previous runtime.\n' >&2
  if [[ $previous_commit =~ ^[0-9a-f]{40}$ ]]; then
    for ((index=0; index<${#deployment_parameters[@]}; index+=2)); do
      [[ ${deployment_parameters[index]} == SOURCE_REF ]] && deployment_parameters[index+1]=$previous_commit
    done
    bash "$temporary/rollback-deploy.sh" "${deployment_parameters[@]}"
  fi
  exit 1
fi
printf 'Factory AI updated to %s.\n' "$version"
