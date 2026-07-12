#!/usr/bin/env bash
set -euo pipefail
set +x

if [[ ${EUID} -ne 0 ]]; then
  echo "deploy-runtime.sh must run as root" >&2
  exit 1
fi

while (($# > 0)); do
  if [[ $1 == *=* ]]; then
    name=${1%%=*}
    value=${1#*=}
    shift
  else
    name=$1
    shift
    (($# > 0)) || { echo "Missing value for $name" >&2; exit 1; }
    value=$1
    shift
  fi
  case "$name" in
    KEY_VAULT_NAME|SERVICE_BUS_NAMESPACE|SERVICE_BUS_QUEUE|SOURCE_REPOSITORY|SOURCE_REF|AWS_REGION|FACTORY_MODEL_SCOUT|FACTORY_MODEL_PLANNER|FACTORY_MODEL_BUILDER|FACTORY_MODEL_TESTER|FACTORY_MODEL_DEBUGGER|FACTORY_MODEL_REVIEWER|FACTORY_MODEL_SECURITY|FACTORY_MODEL_RELEASE) printf -v "$name" '%s' "$value" ;;
    *) echo "Unknown deployment parameter: $name" >&2; exit 1 ;;
  esac
done

: "${KEY_VAULT_NAME:?KEY_VAULT_NAME is required}"
: "${SERVICE_BUS_NAMESPACE:?SERVICE_BUS_NAMESPACE is required}"
: "${SOURCE_REPOSITORY:?SOURCE_REPOSITORY as OWNER/REPOSITORY is required}"
: "${SOURCE_REF:?SOURCE_REF must be a full commit SHA}"
SERVICE_BUS_QUEUE=${SERVICE_BUS_QUEUE:-code-tasks}
[[ $SOURCE_REPOSITORY =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid SOURCE_REPOSITORY" >&2; exit 1; }
[[ $SOURCE_REF =~ ^[0-9a-f]{40}$ ]] || { echo "SOURCE_REF must be a full lowercase commit SHA" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git gpg rsync
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
printf '%s\n' "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor --yes -o /etc/apt/keyrings/microsoft.gpg
printf '%s\n' "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $(. /etc/os-release && printf '%s' "$VERSION_CODENAME") main" > /etc/apt/sources.list.d/azure-cli.list
apt-get update
apt-get install -y azure-cli gh

az login --identity --allow-no-subscriptions --output none
github_token=$(az keyvault secret show --vault-name "$KEY_VAULT_NAME" --name "${GITHUB_TOKEN_SECRET:-github-token}" --query value --output tsv)
[[ -n $github_token && $github_token != *$'\n'* && $github_token != *$'\r'* ]] || { echo "GitHub secret is empty or invalid" >&2; exit 1; }

temporary=$(mktemp -d /opt/agent-factory-source.XXXXXX)
trap 'rm -rf "$temporary"' EXIT
GH_TOKEN="$github_token" gh repo clone "$SOURCE_REPOSITORY" "$temporary/source" -- --no-checkout
unset github_token
git -C "$temporary/source" checkout --detach "$SOURCE_REF"
test "$(git -C "$temporary/source" rev-parse HEAD)" = "$SOURCE_REF"
install -d -m 0755 /opt/agent-factory/app
rsync -a --delete --exclude .git "$temporary/source/" /opt/agent-factory/app/

KEY_VAULT_NAME="$KEY_VAULT_NAME" \
SERVICE_BUS_NAMESPACE="$SERVICE_BUS_NAMESPACE" \
SERVICE_BUS_QUEUE="$SERVICE_BUS_QUEUE" \
FACTORY_WORKER_IMAGE="agent-factory-worker:$SOURCE_REF" \
AWS_REGION="${AWS_REGION:-}" \
FACTORY_MODEL_SCOUT="${FACTORY_MODEL_SCOUT:-}" \
FACTORY_MODEL_PLANNER="${FACTORY_MODEL_PLANNER:-}" \
FACTORY_MODEL_BUILDER="${FACTORY_MODEL_BUILDER:-}" \
FACTORY_MODEL_TESTER="${FACTORY_MODEL_TESTER:-}" \
FACTORY_MODEL_DEBUGGER="${FACTORY_MODEL_DEBUGGER:-}" \
FACTORY_MODEL_REVIEWER="${FACTORY_MODEL_REVIEWER:-}" \
FACTORY_MODEL_SECURITY="${FACTORY_MODEL_SECURITY:-}" \
FACTORY_MODEL_RELEASE="${FACTORY_MODEL_RELEASE:-}" \
bash /opt/agent-factory/app/bootstrap/setup.sh
install -d -o factory -g factory -m 0750 /opt/agent-factory/state
version=$(node -p 'require("/opt/agent-factory/app/package.json").version')
jq -n --arg version "$version" --arg commit "$SOURCE_REF" --arg repository "$SOURCE_REPOSITORY" \
  '{version:$version,commit:$commit,repository:$repository,installedAt:(now|todate)}' \
  > /opt/agent-factory/state/runtime-version.json.tmp
chown factory:factory /opt/agent-factory/state/runtime-version.json.tmp
chmod 0640 /opt/agent-factory/state/runtime-version.json.tmp
mv /opt/agent-factory/state/runtime-version.json.tmp /opt/agent-factory/state/runtime-version.json
