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
SERVICE_BUS_QUEUE=${SERVICE_BUS_QUEUE:-code-tasks}
APP_DIR=${APP_DIR:-/opt/agent-factory/app}
FACTORY_USER=${FACTORY_USER:-factory}

chmod 0755 /opt/agent-factory "$APP_DIR"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gpg git jq

install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
printf '%s\n' "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor --yes -o /etc/apt/keyrings/microsoft.gpg
printf '%s\n' "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $(. /etc/os-release && echo "$VERSION_CODENAME") main" > /etc/apt/sources.list.d/azure-cli.list
apt-get update
apt-get install -y azure-cli gh nodejs
test "$(node --version | cut -d. -f1)" = "v20"

id "$FACTORY_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$FACTORY_USER"
test -f "$APP_DIR/package-lock.json"
npm ci --omit=dev --prefix "$APP_DIR"
docker build --file "$APP_DIR/Dockerfile.worker" --tag "$FACTORY_WORKER_IMAGE" "$APP_DIR"

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
for secret_name in \
  "${AZURE_PRIMARY_API_KEY_SECRET:-azure-primary-api-key}" \
  "${AZURE_PRIMARY_BASE_URL_SECRET:-azure-primary-base-url}" \
  "${AZURE_SMALL_API_KEY_SECRET:-azure-small-api-key}" \
  "${AZURE_SMALL_BASE_URL_SECRET:-azure-small-base-url}" \
  "${GITHUB_TOKEN_SECRET:-github-token}"; do
  az keyvault secret show --vault-name "$KEY_VAULT_NAME" --name "$secret_name" --query id --output none
done

install -d -o "$FACTORY_USER" -g "$FACTORY_USER" -m 0750 /opt/agent-factory/state /opt/agent-factory/state/home /opt/agent-factory/state/memory /opt/agent-factory/workspaces /opt/agent-factory/logs
install -m 0600 -o root -g root /dev/null /etc/agent-factory.env
{
  printf 'SERVICE_BUS_NAMESPACE=%s\n' "$SERVICE_BUS_NAMESPACE"
  printf 'CONTROL_QUEUE=control-events\n'
  printf 'AGENT_QUEUE=agent-tasks\n'
  printf 'RELEASE_QUEUE=release-tasks\n'
  printf 'KEY_VAULT_NAME=%s\n' "$KEY_VAULT_NAME"
  printf 'AZURE_SUBSCRIPTION_ID=%s\n' "$subscription_id"
  printf 'FACTORY_RESOURCE_GROUP=rg-vedant-3569\n'
  printf 'FACTORY_STATE_DIR=/opt/agent-factory/state\n'
  printf 'FACTORY_WORKSPACE_DIR=/opt/agent-factory/workspaces\n'
  printf 'FACTORY_REGISTRY=%s/config/capabilities.json\n' "$APP_DIR"
  printf 'FACTORY_WORKER_IMAGE=%s\n' "$FACTORY_WORKER_IMAGE"
  printf 'MAX_CONCURRENCY=3\n'
  printf 'TASK_TIMEOUT_MS=1800000\n'
  printf 'MAX_DELIVERY_COUNT=8\n'
} > /etc/agent-factory.env

install -m 0600 -o root -g root /dev/null /etc/agent-factory-control.env
{
  printf 'SERVICE_BUS_NAMESPACE=%s\n' "$SERVICE_BUS_NAMESPACE"
  printf 'CONTROL_QUEUE=control-events\n'
  printf 'AGENT_QUEUE=agent-tasks\n'
  printf 'RELEASE_QUEUE=release-tasks\n'
  printf 'KEY_VAULT_NAME=%s\n' "$KEY_VAULT_NAME"
  printf 'AZURE_SUBSCRIPTION_ID=%s\n' "$subscription_id"
  printf 'FACTORY_RESOURCE_GROUP=rg-vedant-3569\n'
  printf 'FACTORY_STATE_DIR=/opt/agent-factory/state\n'
  printf 'FACTORY_REGISTRY=%s/config/capabilities.json\n' "$APP_DIR"
  printf 'MAX_DELIVERY_COUNT=8\n'
} > /etc/agent-factory-control.env

chown -R "$FACTORY_USER:$FACTORY_USER" /opt/agent-factory/state /opt/agent-factory/workspaces /opt/agent-factory/logs
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"
install -m 0644 "$APP_DIR/bootstrap/agent-factory-worker.service" /etc/systemd/system/agent-factory-worker.service
install -m 0644 "$APP_DIR/bootstrap/agent-factory-control.service" /etc/systemd/system/agent-factory-control.service
install -m 0644 "$APP_DIR/bootstrap/agent-factory-release.service" /etc/systemd/system/agent-factory-release.service
install -m 0644 "$APP_DIR/bootstrap/agent-factory-reporter.service" /etc/systemd/system/agent-factory-reporter.service
install -m 0644 "$APP_DIR/bootstrap/agent-factory-reporter.timer" /etc/systemd/system/agent-factory-reporter.timer
systemctl daemon-reload
systemctl enable --now agent-factory-worker.service
systemctl enable --now agent-factory-control.service
systemctl enable --now agent-factory-release.service
systemctl enable --now agent-factory-reporter.timer
systemctl restart agent-factory-control.service agent-factory-worker.service agent-factory-release.service
echo "Agent factory worker installed"
