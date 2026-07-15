#!/bin/sh
set -eu

if [ -d /source ]; then
  rsync -a --no-owner --no-group \
    --exclude .git --exclude node_modules \
    --exclude '.env*' --exclude .npmrc --exclude .netrc --exclude .pypirc \
    --exclude '*.tfvars' --exclude 'id_rsa*' \
    --exclude .aws --exclude .azure --exclude .kube \
    --exclude '*credentials*.json' --exclude '*secret*.json' --exclude '*secret*.yaml' --exclude '*secret*.yml' \
    --exclude '*.pem' --exclude '*.key' --exclude '*.p12' --exclude '*.pfx' \
    /source/ /workspace/
  if [ -n "${FACTORY_TARGET_UID:-}" ] && [ -n "${FACTORY_TARGET_GID:-}" ]; then
    chown -R "$FACTORY_TARGET_UID:$FACTORY_TARGET_GID" /workspace
  fi
fi
exec "$@"
