#!/usr/bin/env bash
# Build and (re)start everything. Safe to re-run; used by the GitHub Actions deploy too.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only || true
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
docker compose ps
