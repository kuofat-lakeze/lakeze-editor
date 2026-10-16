#!/usr/bin/env bash
# Fully scripted Railway setup: one project, `backend` (with /data volume) + `frontend` (public domain),
# both deployed from the GitHub repo so pushes to main auto-deploy.
#
# Needs: railway CLI (npm i -g @railway/cli), and env vars
#   RAILWAY_TOKEN        account/workspace token (Account Settings → Tokens)
#   ANTHROPIC_API_KEY    ELEVENLABS_API_KEY    ADMIN_EMAILS
# Optional: RAILWAY_WORKSPACE (name/id), PROJECT_NAME (default lakeze-editor), REPO (default kuofat-lakeze/lakeze-editor)
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RAILWAY_TOKEN:?set RAILWAY_TOKEN}" "${ANTHROPIC_API_KEY:?}" "${ELEVENLABS_API_KEY:?}" "${ADMIN_EMAILS:?}"
REPO="${REPO:-kuofat-lakeze/lakeze-editor}"
PROJECT_NAME="${PROJECT_NAME:-lakeze-editor}"
SECRET_KEY="${SECRET_KEY:-$(openssl rand -hex 32)}"
API=https://backboard.railway.com/graphql/v2

gql() {  # gql '<query>' '<json variables>'
  curl -sS -X POST "$API" -H "Authorization: Bearer $RAILWAY_TOKEN" -H 'content-type: application/json' \
    -d "$(jq -cn --arg q "$1" --argjson v "${2:-{\}}" '{query:$q, variables:$v}')"
}

echo "== project"
if [ -n "${PROJECT_ID:-}" ]; then
  railway link -p "$PROJECT_ID" ${RAILWAY_WORKSPACE:+-w "$RAILWAY_WORKSPACE"} >/dev/null
else
  OUT=$(railway init --name "$PROJECT_NAME" ${RAILWAY_WORKSPACE:+-w "$RAILWAY_WORKSPACE"} --json)
  PROJECT_ID=$(echo "$OUT" | jq -r '.id // .projectId // .project.id')
fi
ENV_ID=$(gql 'query($id:String!){ project(id:$id){ environments{ edges{ node{ id name } } } } }' "{\"id\":\"$PROJECT_ID\"}" \
  | jq -r '.data.project.environments.edges[] | select(.node.name=="production") | .node.id')
echo "project=$PROJECT_ID env=$ENV_ID"

echo "== backend service"
railway add --service backend --repo "$REPO" --branch main \
  --variables "PORT=8000" --variables "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
  --variables "ELEVENLABS_API_KEY=$ELEVENLABS_API_KEY" --variables "SECRET_KEY=$SECRET_KEY" \
  --variables "ADMIN_EMAILS=$ADMIN_EMAILS" --variables "DATA_DIR=/data" \
  ${TOPUP_NOTE:+--variables "TOPUP_NOTE=$TOPUP_NOTE"} --json >/dev/null
echo "== frontend service"
railway add --service frontend --repo "$REPO" --branch main \
  --variables "API_UPSTREAM=backend.railway.internal:8000" --json >/dev/null

svc_id() { gql 'query($id:String!){ project(id:$id){ services{ edges{ node{ id name } } } } }' "{\"id\":\"$PROJECT_ID\"}" \
  | jq -r --arg n "$1" '.data.project.services.edges[] | select(.node.name==$n) | .node.id'; }
BACKEND_ID=$(svc_id backend); FRONTEND_ID=$(svc_id frontend)

echo "== root directories (Dockerfiles live in backend/ and frontend/)"
for pair in "$BACKEND_ID:backend" "$FRONTEND_ID:frontend"; do
  sid=${pair%%:*}; dir=${pair##*:}
  gql 'mutation($s:String!,$e:String!,$d:String!){ serviceInstanceUpdate(serviceId:$s, environmentId:$e, input:{rootDirectory:$d}) }' \
    "{\"s\":\"$sid\",\"e\":\"$ENV_ID\",\"d\":\"$dir\"}" | jq -c '.errors // "ok"'
done

echo "== volume on backend"
railway service link backend >/dev/null
railway volume add -m /data --json >/dev/null || echo "(volume may already exist)"

echo "== public domain on frontend"
railway service link frontend >/dev/null
DOMAIN_JSON=$(railway domain --json 2>/dev/null || railway domain list --json)
URL=$(echo "$DOMAIN_JSON" | jq -r '.. | .domain? // empty' | head -1)

echo "== deploy"
railway redeploy --service backend -y 2>/dev/null || railway service redeploy --service backend 2>/dev/null || true
railway redeploy --service frontend -y 2>/dev/null || railway service redeploy --service frontend 2>/dev/null || true

echo
echo "URL: https://${URL:-<see Railway dashboard → frontend → Networking>}"
echo "Next: wait ~5 min, then open https://$URL/api/health and sign up with $ADMIN_EMAILS"
