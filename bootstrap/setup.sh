#!/usr/bin/env bash
set -euo pipefail
set +x

if [[ ${EUID} -ne 0 ]]; then
  echo "setup.sh must run as root" >&2
  exit 1
fi

: "${KEY_VAULT_NAME:?Set KEY_VAULT_NAME to the existing vault name}"
: "${SERVICE_BUS_NAMESPACE:?Set SERVICE_BUS_NAMESPACE to the existing namespace name}"
: "${FACTORY_WORKER_IMAGE:?Set FACTORY_WORKER_IMAGE to an immutable image tag}"
APP_DIR=${APP_DIR:-/opt/agent-factory/app}
FACTORY_USER=${FACTORY_USER:-factory}

chmod 0755 /opt/agent-factory "$APP_DIR"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gpg git jq iptables

install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
printf '%s\n' "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor --yes -o /etc/apt/keyrings/microsoft.gpg
printf '%s\n' "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $(. /etc/os-release && echo "$VERSION_CODENAME") main" > /etc/apt/sources.list.d/azure-cli.list
apt-get update
apt-get install -y azure-cli gh nodejs
test "$(node --version | cut -d. -f1)" = "v22"

id "$FACTORY_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$FACTORY_USER"
test -f "$APP_DIR/package-lock.json"
npm ci --omit=dev --prefix "$APP_DIR"
factory_version=$(node -p "require('$APP_DIR/package.json').version")
docker build --file "$APP_DIR/Dockerfile.worker" --tag "$FACTORY_WORKER_IMAGE" "$APP_DIR"
for scanner_image in \
  aquasec/trivy@sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f \
  zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f \
  ghcr.io/google/osv-scanner@sha256:f7ba4be68bac8086b1f88fd598fdca1ca67239c79ad2c2b5c78e03a82e5187c4 \
  semgrep/semgrep@sha256:183a149fb3e9700ab5294a7b4ab0241a826fd046bc8b721062fbea80fdfa438f; do
  docker pull "$scanner_image"
done
docker pull ollama/ollama@sha256:3d8a05e3432d50ea57594fabe971e46cc8fe963a0f9f8c40400bd56cd5388e47
docker pull qdrant/qdrant@sha256:31407c0e8e32eb771b71718f1a4772e2ad47a07557917b21ac96792f40eb8007
iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT 2>/dev/null || iptables -I DOCKER-USER -d 169.254.169.254/32 -j REJECT

STATE_DEVICE=/dev/disk/azure/scsi1/lun0
if [[ -b $STATE_DEVICE ]]; then
  systemctl stop agent-factory-control.service agent-factory-worker.service agent-factory-release.service 2>/dev/null || true
  if ! blkid "$STATE_DEVICE" >/dev/null 2>&1; then mkfs.ext4 -L agent-factory-state "$STATE_DEVICE"; fi
  install -d -m 0750 /mnt/agent-factory-state /opt/agent-factory/state
  mountpoint -q /mnt/agent-factory-state || mount "$STATE_DEVICE" /mnt/agent-factory-state
  rsync -a /opt/agent-factory/state/ /mnt/agent-factory-state/
  umount /mnt/agent-factory-state
  uuid=$(blkid -s UUID -o value "$STATE_DEVICE")
  grep -q ' /opt/agent-factory/state ' /etc/fstab || printf 'UUID=%s /opt/agent-factory/state ext4 defaults,nofail 0 2\n' "$uuid" >> /etc/fstab
  mountpoint -q /opt/agent-factory/state || mount /opt/agent-factory/state
fi

az login --identity --allow-no-subscriptions --output none
subscription_id=$(az account show --query id --output tsv)
resource_group=$(curl -fsS -H Metadata:true 'http://169.254.169.254/metadata/instance?api-version=2021-02-01' | jq -r .compute.resourceGroupName)
for secret_name in "${GITHUB_TOKEN_SECRET:-github-token}"; do
  az keyvault secret show --vault-name "$KEY_VAULT_NAME" --name "$secret_name" --query id --output none
done

install -d -o "$FACTORY_USER" -g "$FACTORY_USER" -m 0750 /opt/agent-factory/state /opt/agent-factory/state/home /opt/agent-factory/state/memory /opt/agent-factory/state/telegram /opt/agent-factory/state/retrieval /opt/agent-factory/state/usage /opt/agent-factory/workspaces /opt/agent-factory/logs
if [[ -f /opt/agent-factory/state/memory/knowledge-graph.jsonl && ! -e /opt/agent-factory/state/memory/legacy-unscoped-knowledge-graph.jsonl ]]; then
  mv /opt/agent-factory/state/memory/knowledge-graph.jsonl /opt/agent-factory/state/memory/legacy-unscoped-knowledge-graph.jsonl
fi
install -d -o root -g root -m 0750 /opt/agent-factory/state/qdrant /opt/agent-factory/state/qdrant-snapshots /opt/agent-factory/state/ollama
worker_env=$(mktemp)
{
  printf 'SERVICE_BUS_NAMESPACE=%s\n' "$SERVICE_BUS_NAMESPACE"
  printf 'CONTROL_QUEUE=control-events\n'
  printf 'AGENT_QUEUE=agent-tasks\n'
  printf 'RELEASE_QUEUE=release-tasks\n'
  printf 'KEY_VAULT_NAME=%s\n' "$KEY_VAULT_NAME"
  printf 'AZURE_SUBSCRIPTION_ID=%s\n' "$subscription_id"
  printf 'FACTORY_RESOURCE_GROUP=%s\n' "$resource_group"
  [[ -n ${FACTORY_STORAGE_ACCOUNT:-} ]] && printf 'FACTORY_STORAGE_ACCOUNT=%s\n' "$FACTORY_STORAGE_ACCOUNT"
  printf 'FACTORY_STATE_DIR=/opt/agent-factory/state\n'
  printf 'FACTORY_WORKSPACE_DIR=/opt/agent-factory/workspaces\n'
  printf 'FACTORY_REGISTRY=%s/config/capabilities.json\n' "$APP_DIR"
  printf 'FACTORY_WORKER_IMAGE=%s\n' "$FACTORY_WORKER_IMAGE"
  printf 'FACTORY_VERSION=%s\n' "$factory_version"
  printf 'FACTORY_NAME=%s\n' "${FACTORY_NAME:-Factory AI}"
  printf 'FACTORY_PURPOSE=%s\n' "${FACTORY_PURPOSE:-Ship secure reviewed software continuously}"
  printf 'MAX_CONCURRENCY=3\n'
  printf 'TASK_TIMEOUT_MS=1800000\n'
  printf 'FACTORY_COMPACT_AFTER_INPUT_TOKENS=%s\n' "${FACTORY_COMPACT_AFTER_INPUT_TOKENS:-80000}"
  printf 'FACTORY_COMPACT_MAX_CHARACTERS=%s\n' "${FACTORY_COMPACT_MAX_CHARACTERS:-24000}"
  printf 'FACTORY_WATCHDOG_STALE_SECONDS=%s\n' "${FACTORY_WATCHDOG_STALE_SECONDS:-900}"
  printf 'FACTORY_HOOKS_JSON=%s\n' "${FACTORY_HOOKS_JSON:-[]}"
  printf 'MAX_DELIVERY_COUNT=8\n'
  [[ -n ${AWS_REGION:-} ]] && printf 'AWS_REGION=%s\nAWS_DEFAULT_REGION=%s\n' "$AWS_REGION" "$AWS_REGION"
  for variable in FACTORY_MODEL_SCOUT FACTORY_MODEL_PLANNER FACTORY_MODEL_BUILDER FACTORY_MODEL_TESTER FACTORY_MODEL_DEBUGGER FACTORY_MODEL_REVIEWER FACTORY_MODEL_SECURITY FACTORY_MODEL_RELEASE; do
    [[ -n ${!variable:-} ]] && printf '%s=%s\n' "$variable" "${!variable}"
  done
} > "$worker_env"
install -m 0640 -o root -g "$FACTORY_USER" "$worker_env" /etc/agent-factory.env
rm -f "$worker_env"

control_env=$(mktemp)
{
  printf 'SERVICE_BUS_NAMESPACE=%s\n' "$SERVICE_BUS_NAMESPACE"
  printf 'CONTROL_QUEUE=control-events\n'
  printf 'AGENT_QUEUE=agent-tasks\n'
  printf 'RELEASE_QUEUE=release-tasks\n'
  printf 'KEY_VAULT_NAME=%s\n' "$KEY_VAULT_NAME"
  printf 'AZURE_SUBSCRIPTION_ID=%s\n' "$subscription_id"
  printf 'FACTORY_RESOURCE_GROUP=%s\n' "$resource_group"
  [[ -n ${FACTORY_STORAGE_ACCOUNT:-} ]] && printf 'FACTORY_STORAGE_ACCOUNT=%s\n' "$FACTORY_STORAGE_ACCOUNT"
  printf 'FACTORY_NAME=%s\n' "${FACTORY_NAME:-Factory AI}"
  printf 'FACTORY_PURPOSE=%s\n' "${FACTORY_PURPOSE:-Ship secure reviewed software continuously}"
  printf 'FACTORY_STATE_DIR=/opt/agent-factory/state\n'
  printf 'FACTORY_REGISTRY=%s/config/capabilities.json\n' "$APP_DIR"
  printf 'MAX_DELIVERY_COUNT=8\n'
  printf 'FACTORY_COMPACT_AFTER_INPUT_TOKENS=%s\n' "${FACTORY_COMPACT_AFTER_INPUT_TOKENS:-80000}"
  printf 'FACTORY_COMPACT_MAX_CHARACTERS=%s\n' "${FACTORY_COMPACT_MAX_CHARACTERS:-24000}"
  [[ -n ${AWS_REGION:-} ]] && printf 'AWS_REGION=%s\nAWS_DEFAULT_REGION=%s\n' "$AWS_REGION" "$AWS_REGION"
  for variable in FACTORY_MODEL_SCOUT FACTORY_MODEL_PLANNER FACTORY_MODEL_BUILDER FACTORY_MODEL_TESTER FACTORY_MODEL_DEBUGGER FACTORY_MODEL_REVIEWER FACTORY_MODEL_SECURITY FACTORY_MODEL_RELEASE; do
    [[ -n ${!variable:-} ]] && printf '%s=%s\n' "$variable" "${!variable}"
  done
} > "$control_env"
install -m 0640 -o root -g "$FACTORY_USER" "$control_env" /etc/agent-factory-control.env
rm -f "$control_env"

chown -R "$FACTORY_USER:$FACTORY_USER" /opt/agent-factory/state /opt/agent-factory/workspaces /opt/agent-factory/logs
chown root:root /opt/agent-factory/state/qdrant /opt/agent-factory/state/qdrant-snapshots /opt/agent-factory/state/ollama
chmod 0750 /opt/agent-factory/state/qdrant /opt/agent-factory/state/qdrant-snapshots /opt/agent-factory/state/ollama
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"
install -m 0644 "$APP_DIR/bootstrap/agent-factory-worker.service" /etc/systemd/system/agent-factory-worker.service
install -m 0644 "$APP_DIR/bootstrap/factory-ai-container-firewall.service" /etc/systemd/system/factory-ai-container-firewall.service
install -m 0644 "$APP_DIR/bootstrap/agent-factory-control.service" /etc/systemd/system/agent-factory-control.service
install -m 0644 "$APP_DIR/bootstrap/agent-factory-release.service" /etc/systemd/system/agent-factory-release.service
install -m 0644 "$APP_DIR/bootstrap/agent-factory-reporter.service" /etc/systemd/system/agent-factory-reporter.service
install -m 0644 "$APP_DIR/bootstrap/agent-factory-reporter.timer" /etc/systemd/system/agent-factory-reporter.timer
install -m 0644 "$APP_DIR/bootstrap/agent-factory-telegram.service" /etc/systemd/system/agent-factory-telegram.service
chmod 0755 "$APP_DIR/bootstrap/auto-update.sh"
install -m 0644 "$APP_DIR/bootstrap/factory-ai-update.service" /etc/systemd/system/factory-ai-update.service
install -m 0644 "$APP_DIR/bootstrap/factory-ai-update.timer" /etc/systemd/system/factory-ai-update.timer
install -m 0644 "$APP_DIR/bootstrap/factory-ai-snapshot.service" /etc/systemd/system/factory-ai-snapshot.service
  install -m 0644 "$APP_DIR/bootstrap/factory-ai-snapshot.timer" /etc/systemd/system/factory-ai-snapshot.timer
  install -m 0644 "$APP_DIR/bootstrap/factory-ai-watchdog.service" /etc/systemd/system/factory-ai-watchdog.service
  install -m 0644 "$APP_DIR/bootstrap/factory-ai-watchdog.timer" /etc/systemd/system/factory-ai-watchdog.timer
install -m 0644 "$APP_DIR/bootstrap/factory-ai-qdrant.service" /etc/systemd/system/factory-ai-qdrant.service
install -m 0644 "$APP_DIR/bootstrap/factory-ai-ollama.service" /etc/systemd/system/factory-ai-ollama.service
systemctl daemon-reload
systemctl enable --now factory-ai-container-firewall.service
systemctl enable --now agent-factory-worker.service
systemctl enable --now agent-factory-control.service
systemctl enable --now agent-factory-release.service
systemctl enable --now agent-factory-reporter.timer
systemctl enable --now agent-factory-telegram.service
systemctl enable --now factory-ai-update.timer
  systemctl enable --now factory-ai-snapshot.timer
  systemctl enable --now factory-ai-watchdog.timer
systemctl enable --now factory-ai-qdrant.service factory-ai-ollama.service
for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done
docker exec factory-ai-ollama ollama show embeddinggemma >/dev/null 2>&1 || docker exec factory-ai-ollama ollama pull embeddinggemma
systemctl restart agent-factory-control.service agent-factory-worker.service agent-factory-release.service
echo "Agent factory worker installed"
