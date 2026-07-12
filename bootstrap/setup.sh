#!/usr/bin/env bash
set -euo pipefail
set +x

if [[ ${EUID} -ne 0 ]]; then
  echo "setup.sh must run as root" >&2
  exit 1
fi

: "${KEY_VAULT_NAME:?Set KEY_VAULT_NAME to the existing vault name}"
: "${SERVICE_BUS_NAMESPACE:?Set SERVICE_BUS_NAMESPACE to the existing namespace name}"
SERVICE_BUS_QUEUE=${SERVICE_BUS_QUEUE:-code-tasks}
APP_DIR=${APP_DIR:-/opt/agent-factory/app}
FACTORY_USER=${FACTORY_USER:-factory}

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
npx --prefix "$APP_DIR" playwright install --with-deps chromium

az login --identity --allow-no-subscriptions --output none
for secret_name in \
  "${AZURE_PRIMARY_API_KEY_SECRET:-azure-primary-api-key}" \
  "${AZURE_PRIMARY_BASE_URL_SECRET:-azure-primary-base-url}" \
  "${AZURE_SMALL_API_KEY_SECRET:-azure-small-api-key}" \
  "${AZURE_SMALL_BASE_URL_SECRET:-azure-small-base-url}" \
  "${GITHUB_TOKEN_SECRET:-github-token}"; do
  az keyvault secret show --vault-name "$KEY_VAULT_NAME" --name "$secret_name" --query id --output none
done

install -d -o "$FACTORY_USER" -g "$FACTORY_USER" -m 0750 /opt/agent-factory/state /opt/agent-factory/state/home /opt/agent-factory/workspaces /opt/agent-factory/logs
install -m 0600 -o root -g root /dev/null /etc/agent-factory.env
{
  printf 'SERVICE_BUS_NAMESPACE=%s\n' "$SERVICE_BUS_NAMESPACE"
  printf 'SERVICE_BUS_QUEUE=%s\n' "$SERVICE_BUS_QUEUE"
  printf 'KEY_VAULT_NAME=%s\n' "$KEY_VAULT_NAME"
  printf 'FACTORY_STATE_DIR=/opt/agent-factory/state\n'
  printf 'FACTORY_WORKSPACE_DIR=/opt/agent-factory/workspaces\n'
  printf 'FACTORY_REGISTRY=%s/config/capabilities.json\n' "$APP_DIR"
  printf 'MAX_CONCURRENCY=3\n'
  printf 'TASK_TIMEOUT_MS=1800000\n'
  printf 'MAX_DELIVERY_COUNT=8\n'
} > /etc/agent-factory.env

chown -R "$FACTORY_USER:$FACTORY_USER" /opt/agent-factory/state /opt/agent-factory/workspaces /opt/agent-factory/logs
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"
install -m 0644 "$APP_DIR/bootstrap/agent-factory-worker.service" /etc/systemd/system/agent-factory-worker.service
install -m 0644 "$APP_DIR/bootstrap/agent-factory-reporter.service" /etc/systemd/system/agent-factory-reporter.service
install -m 0644 "$APP_DIR/bootstrap/agent-factory-reporter.timer" /etc/systemd/system/agent-factory-reporter.timer
systemctl daemon-reload
systemctl enable --now agent-factory-worker.service
systemctl enable --now agent-factory-reporter.timer
echo "Agent factory worker installed"
