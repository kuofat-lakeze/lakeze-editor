#!/usr/bin/env bash
# Fully scripted Railway setup, pure GraphQL (works with workspace/account tokens, no CLI login needed):
# one project, `backend` (with /data volume) + `frontend` (public domain), both deployed from the
# GitHub repo so pushes to main auto-deploy.
#
# Needs: curl, jq, openssl, and env vars
#   RAILWAY_TOKEN        workspace token (Workspace Settings → Tokens) or account token
#   ANTHROPIC_API_KEY    ELEVENLABS_API_KEY    ADMIN_EMAILS
# Optional: RAILWAY_WORKSPACE_ID (default: workspace of an existing project, or the token's only workspace),
#           PROJECT_NAME (default lakeze-editor), PROJECT_ID (reuse an existing project),
#           REPO (default kuofat-lakeze/lakeze-editor), BRANCH (default main), TOPUP_NOTE, REGION
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RAILWAY_TOKEN:?set RAILWAY_TOKEN}" "${ANTHROPIC_API_KEY:?}" "${ELEVENLABS_API_KEY:?}" "${ADMIN_EMAILS:?}"
REPO="${REPO:-kuofat-lakeze/lakeze-editor}"
BRANCH="${BRANCH:-main}"
PROJECT_NAME="${PROJECT_NAME:-lakeze-editor}"
SECRET_KEY="${SECRET_KEY:-$(openssl rand -hex 32)}"
API=https://backboard.railway.com/graphql/v2

gql() {  # gql '<query>' '<json variables>'  → prints JSON; exits non-zero on GraphQL errors
  local out
  out=$(curl -sS --retry 3 -X POST "$API" -H "Authorization: Bearer $RAILWAY_TOKEN" -H 'content-type: application/json' \
    -d "$(jq -cn --arg q "$1" --argjson v "${2:-{\}}" '{query:$q, variables:$v}')")
  if echo "$out" | jq -e '.errors' >/dev/null 2>&1; then
    echo "GraphQL error: $(echo "$out" | jq -c '.errors')" >&2
    return 1
  fi
  echo "$out"
}

echo "== project"
if [ -z "${PROJECT_ID:-}" ]; then
  # Reuse the project if it already exists (script is re-runnable).
  PROJECT_ID=$(gql '{ projects { edges { node { id name workspaceId } } } }' \
    | jq -r --arg n "$PROJECT_NAME" '.data.projects.edges[] | select(.node.name==$n) | .node.id' | head -1)
fi
if [ -z "$PROJECT_ID" ]; then
  if [ -z "${RAILWAY_WORKSPACE_ID:-}" ]; then
    RAILWAY_WORKSPACE_ID=$(gql '{ projects { edges { node { workspaceId } } } }' \
      | jq -r '[.data.projects.edges[].node.workspaceId] | unique | .[0] // empty')
  fi
  if [ -z "$RAILWAY_WORKSPACE_ID" ]; then
    RAILWAY_WORKSPACE_ID=$(gql '{ me { workspaces { id name } } }' | jq -r '.data.me.workspaces[0].id // empty')
  fi
  : "${RAILWAY_WORKSPACE_ID:?could not determine workspace id; set RAILWAY_WORKSPACE_ID}"
  PROJECT_ID=$(gql 'mutation($n:String!,$w:String!){ projectCreate(input:{name:$n, workspaceId:$w, defaultEnvironmentName:"production"}){ id } }' \
    "{\"n\":\"$PROJECT_NAME\",\"w\":\"$RAILWAY_WORKSPACE_ID\"}" | jq -r '.data.projectCreate.id')
fi
ENV_ID=$(gql 'query($id:String!){ project(id:$id){ environments{ edges{ node{ id name } } } } }' "{\"id\":\"$PROJECT_ID\"}" \
  | jq -r '.data.project.environments.edges[] | select(.node.name=="production") | .node.id')
echo "project=$PROJECT_ID env=$ENV_ID"

svc_id() { gql 'query($id:String!){ project(id:$id){ services{ edges{ node{ id name } } } } }' "{\"id\":\"$PROJECT_ID\"}" \
  | jq -r --arg n "$1" '.data.project.services.edges[] | select(.node.name==$n) | .node.id' | head -1; }

# make_service <name> <rootDir> <healthcheckPath> <variables-json>
# Create the service WITHOUT a source first, configure root dir + variables, then connect the repo,
# so the very first build already uses the right Dockerfile.
make_service() {
  local name=$1 dir=$2 health=$3 vars=$4 sid
  sid=$(svc_id "$name")
  if [ -z "$sid" ]; then
    sid=$(gql 'mutation($p:String!,$n:String!,$e:String!){ serviceCreate(input:{projectId:$p, name:$n, environmentId:$e}){ id } }' \
      "{\"p\":\"$PROJECT_ID\",\"n\":\"$name\",\"e\":\"$ENV_ID\"}" | jq -r '.data.serviceCreate.id')
    echo "created $name=$sid"
  else
    echo "exists  $name=$sid"
  fi
  # railway.json (config-as-code) is deprecated on Railway, so set deploy settings here directly.
  gql 'mutation($s:String!,$e:String!,$d:String!,$h:String!){ serviceInstanceUpdate(serviceId:$s, environmentId:$e, input:{rootDirectory:$d, dockerfilePath:"Dockerfile", healthcheckPath:$h, healthcheckTimeout:300, restartPolicyType:ON_FAILURE, restartPolicyMaxRetries:10, numReplicas:1}) }' \
    "{\"s\":\"$sid\",\"e\":\"$ENV_ID\",\"d\":\"$dir\",\"h\":\"$health\"}" >/dev/null
  gql 'mutation($p:String!,$e:String!,$s:String!,$v:EnvironmentVariables!){ variableCollectionUpsert(input:{projectId:$p, environmentId:$e, serviceId:$s, variables:$v, skipDeploys:true}) }' \
    "$(jq -cn --arg p "$PROJECT_ID" --arg e "$ENV_ID" --arg s "$sid" --argjson v "$vars" '{p:$p,e:$e,s:$s,v:$v}')" >/dev/null
  echo "$sid"
}

echo "== backend service"
BACKEND_VARS=$(jq -cn --arg a "$ANTHROPIC_API_KEY" --arg el "$ELEVENLABS_API_KEY" --arg sk "$SECRET_KEY" --arg ad "$ADMIN_EMAILS" --arg tn "${TOPUP_NOTE:-}" \
  '{PORT:"8000", ANTHROPIC_API_KEY:$a, ELEVENLABS_API_KEY:$el, SECRET_KEY:$sk, ADMIN_EMAILS:$ad, DATA_DIR:"/data"} + (if $tn != "" then {TOPUP_NOTE:$tn} else {} end)')
BACKEND_ID=$(make_service backend backend /api/health "$BACKEND_VARS" | tail -1)

echo "== volume on backend (/data)"
HAS_VOL=$(gql 'query($id:String!){ project(id:$id){ volumes{ edges{ node{ id volumeInstances{ edges{ node{ serviceId mountPath } } } } } } } }' "{\"id\":\"$PROJECT_ID\"}" \
  | jq -r --arg s "$BACKEND_ID" '[.data.project.volumes.edges[].node.volumeInstances.edges[].node | select(.serviceId==$s)] | length')
if [ "$HAS_VOL" = "0" ]; then
  gql 'mutation($p:String!,$e:String!,$s:String!){ volumeCreate(input:{projectId:$p, environmentId:$e, serviceId:$s, mountPath:"/data"}){ id } }' \
    "{\"p\":\"$PROJECT_ID\",\"e\":\"$ENV_ID\",\"s\":\"$BACKEND_ID\"}" | jq -c '.data.volumeCreate'
else
  echo "(volume already attached)"
fi

echo "== frontend service"
FRONTEND_ID=$(make_service frontend frontend / '{"PORT":"80","API_UPSTREAM":"backend.railway.internal:8000","RESOLVER":"[fd12::10]"}' | tail -1)

echo "== public domain on frontend"
URL=$(gql 'query($p:String!,$e:String!,$s:String!){ domains(projectId:$p, environmentId:$e, serviceId:$s){ serviceDomains{ domain } customDomains{ domain } } }' \
  "{\"p\":\"$PROJECT_ID\",\"e\":\"$ENV_ID\",\"s\":\"$FRONTEND_ID\"}" | jq -r '.data.domains | (.customDomains + .serviceDomains)[0].domain // empty')
if [ -z "$URL" ]; then
  URL=$(gql 'mutation($e:String!,$s:String!){ serviceDomainCreate(input:{environmentId:$e, serviceId:$s, targetPort:80}){ domain } }' \
    "{\"e\":\"$ENV_ID\",\"s\":\"$FRONTEND_ID\"}" | jq -r '.data.serviceDomainCreate.domain')
fi

echo "== connect GitHub repo ($REPO@$BRANCH) → triggers the first deploy"
for sid in "$BACKEND_ID" "$FRONTEND_ID"; do
  gql 'mutation($id:String!,$r:String!,$b:String!){ serviceConnect(id:$id, input:{repo:$r, branch:$b}){ id } }' \
    "{\"id\":\"$sid\",\"r\":\"$REPO\",\"b\":\"$BRANCH\"}" >/dev/null
done
# Connecting usually starts a build; make sure both have a deployment either way.
sleep 5
for sid in "$BACKEND_ID" "$FRONTEND_ID"; do
  N=$(gql 'query($p:String!,$e:String!,$s:String!){ deployments(first:1, input:{projectId:$p, environmentId:$e, serviceId:$s}){ edges{ node{ id status } } } }' \
    "{\"p\":\"$PROJECT_ID\",\"e\":\"$ENV_ID\",\"s\":\"$sid\"}" | jq -r '.data.deployments.edges | length')
  if [ "$N" = "0" ]; then
    gql 'mutation($e:String!,$s:String!){ serviceInstanceDeployV2(environmentId:$e, serviceId:$s) }' "{\"e\":\"$ENV_ID\",\"s\":\"$sid\"}" >/dev/null || true
  fi
done

echo
echo "PROJECT_ID=$PROJECT_ID ENV_ID=$ENV_ID BACKEND_ID=$BACKEND_ID FRONTEND_ID=$FRONTEND_ID"
echo "URL: https://$URL"
echo "Next: wait ~5 min, then open https://$URL/api/health and sign up with $ADMIN_EMAILS"
