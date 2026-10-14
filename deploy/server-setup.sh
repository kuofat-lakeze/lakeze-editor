#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 22.04/24.04 server (run as root):
#   curl -fsSL https://raw.githubusercontent.com/kuofat-lakeze/lakeze-editor/main/deploy/server-setup.sh | bash
set -euo pipefail
apt-get update && apt-get install -y ca-certificates curl git ufw
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
mkdir -p /opt && cd /opt
[ -d lakeze-editor ] || git clone https://github.com/kuofat-lakeze/lakeze-editor.git
cd lakeze-editor
[ -f .env ] || { cp .env.example .env; sed -i "s/^SECRET_KEY=.*/SECRET_KEY=$(openssl rand -hex 32)/" .env; }
echo
echo "Now edit /opt/lakeze-editor/.env (API keys + DOMAIN), then run:"
echo "  cd /opt/lakeze-editor && ./deploy/up.sh"
