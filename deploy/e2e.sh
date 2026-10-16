#!/usr/bin/env bash
# End-to-end test of a deployed Lakeze Editor. Signs up the admin, runs one real project through the
# editor agent (Drive footage → cut → voice → music → captions → export → cover), does one revision
# round, checks credits/admin stats, and downloads the deliverables. Costs real Claude + ElevenLabs money.
#
# Env:
#   BASE            https://your-host              (required)
#   E2E_EMAIL       admin email (must be in ADMIN_EMAILS)   E2E_PASSWORD  password (signup, or login if it exists)
#   OUT             output dir (default ./e2e_out) — log.txt, project.json, stats.json, final_1080.mp4, cover.jpg, summary.json
#   PROJECT_NAME    BRIEF  (first message)   REVISION (second message)   MAX_FOLLOWUPS (auto "可以，照建議做" replies, default 10)
#   MODE=revision   with PROJECT_ID (and optional GRANT_POINTS, granted by the admin account first): only the revision round
#   TURN_TIMEOUT    seconds per streamed turn (default 5400)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
: "${BASE:?}" "${E2E_EMAIL:?}" "${E2E_PASSWORD:?}"
OUT=${OUT:-./e2e_out}; mkdir -p "$OUT"
PROJECT_NAME=${PROJECT_NAME:-測試專案}
BRIEF=${BRIEF:-請先列出專案狀態}
REVISION=${REVISION:-把價格字幕改成金色、大一點}
MAX_FOLLOWUPS=${MAX_FOLLOWUPS:-10}
TURN_TIMEOUT=${TURN_TIMEOUT:-5400}
MODE=${MODE:-full}   # full: new project, first version + revision; revision: PROJECT_ID (+ GRANT_POINTS) revision only
FOLLOWUP_TEXT="可以，照建議做"
JAR=${JAR:-${RUNNER_TEMP:-/tmp}/e2e_cookies_$$.txt}
LOG=$OUT/log.txt; : > "$LOG"
CHECKS=()

say() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$LOG"; }
api() { curl -sS -m "${T:-300}" -b "$JAR" -c "$JAR" -H 'content-type: application/json' "$@"; }
check() {  # check <name> <true|false> <detail>
  local ok=false; [ "$2" = true ] && ok=true
  say "$([ $ok = true ] && echo PASS || echo FAIL) $1: $3"
  CHECKS+=("$(jq -cn --arg n "$1" --argjson ok $ok --arg d "$3" '{name:$n,ok:$ok,detail:$d}')")
}
proj() { api "$BASE/api/projects/$1"; }
stream() {  # follow the SSE stream of a turn until done; reconnects while the turn is still running
  local pid=$1 rc
  for _ in 1 2 3 4 5 6; do
    timeout "$TURN_TIMEOUT" curl -sS -N -b "$JAR" "$BASE/api/projects/$pid/stream" 2>>"$LOG" | python3 -u "$HERE/e2e_sse.py" | tee -a "$LOG"
    rc=${PIPESTATUS[1]}
    [ "$rc" != 1 ] && return "$rc"
    if [ "$(proj "$pid" | jq -r '.running')" != "true" ]; then return 0; fi
    say "(stream dropped while turn still running; reconnecting)"; sleep 5
  done
  return 1
}
turn() {  # turn <pid> <text>
  say ">>> USER: $2"
  local r; r=$(api -X POST "$BASE/api/projects/$1/messages" -d "$(jq -cn --arg t "$2" '{text:$t}')")
  say "send → $r"
  stream "$1"
}
has_deliverables() { proj "$1" | jq -e '([.assets[]|select(.kind=="video" and (.name|test("1080")))]|length>0) and ([.assets[]|select(.kind=="image")]|length>0)' >/dev/null; }

# ---- 0. health -------------------------------------------------------------------------------------------
H=$(curl -sS -m 30 "$BASE/api/health"); say "health: $H"
check health "$(echo "$H" | jq -r '(.ok==true) and (.elevenlabs==true)')" "$H"

# ---- 1. admin account --------------------------------------------------------------------------------------
CREDS=$(jq -cn --arg e "$E2E_EMAIL" --arg p "$E2E_PASSWORD" '{email:$e,password:$p}')
code=$(api -o "$OUT/signup.json" -w '%{http_code}' -X POST "$BASE/api/auth/signup" -d "$CREDS")
say "signup http=$code $(cat "$OUT/signup.json")"
if [ "$code" = 409 ]; then
  code=$(api -o "$OUT/login.json" -w '%{http_code}' -X POST "$BASE/api/auth/login" -d "$CREDS"); say "login http=$code"
fi
ME=$(api "$BASE/api/me"); say "me: $ME"
check admin_signup "$(echo "$ME" | jq -r '.is_admin==true')" "$ME"
echo "$ME" > "$OUT/me.json"
if [ "$(echo "$ME" | jq -r '.free_project_id')" != null ]; then  # re-run: give the account a fresh free trial
  UID_=$(echo "$ME" | jq -r .id)
  say "free trial already used → admin reset: $(api -X POST "$BASE/api/admin/users/$UID_" -d '{"reset_free_project":true}')"
fi

if [ "$MODE" = full ]; then
# ---- 2. project + first turn --------------------------------------------------------------------------------
P=$(api -X POST "$BASE/api/projects" -d "$(jq -cn --arg n "$PROJECT_NAME" '{name:$n}')"); say "project: $P"
PID=$(echo "$P" | jq -r .id); echo "$PID" > "$OUT/project_id.txt"
check free_project "$(echo "$P" | jq -r '.free==true')" "$P"
turn "$PID" "$BRIEF"; rc=$?
n=0
while [ "$rc" != 4 ] && ! has_deliverables "$PID" && [ "$n" -lt "$MAX_FOLLOWUPS" ]; do
  n=$((n+1)); say "(no deliverables yet; follow-up $n/$MAX_FOLLOWUPS)"
  turn "$PID" "$FOLLOWUP_TEXT"; rc=$?
done
proj "$PID" > "$OUT/project_v1.json"
check deliverables_v1 "$(has_deliverables "$PID" && echo true || echo false)" "$(jq -c '[.assets[]|{kind,name}]' "$OUT/project_v1.json")"
FRL1=$(jq -r '.credits.free_revisions_left' "$OUT/project_v1.json"); EXP1=$(jq -r '.credits.exports' "$OUT/project_v1.json")
check free_revisions_left_v1 "$([ "$FRL1" = 4 ] && echo true || echo false)" "free_revisions_left=$FRL1 exports=$EXP1 followups=$n credits=$(jq -c .credits "$OUT/project_v1.json")"
ST1=$(api "$BASE/api/admin/stats"); echo "$ST1" > "$OUT/stats_v1.json"; say "stats: $ST1"
check admin_stats "$(echo "$ST1" | jq -r '(.exports>=1) and (.points_waived>0) and (.claude_cost_usd>0)')" "$ST1"
else
# ---- revision-only mode: existing project, optionally topped up by the admin first --------------------------
PID=${PROJECT_ID:?MODE=revision needs PROJECT_ID}; echo "$PID" > "$OUT/project_id.txt"; rc=0
if [ "${GRANT_POINTS:-0}" -gt 0 ]; then
  UID_=$(echo "$ME" | jq -r .id)
  say "admin grant $GRANT_POINTS points → $(api -X POST "$BASE/api/admin/users/$UID_/credits" -d "$(jq -cn --argjson d "$GRANT_POINTS" '{delta:$d, reason:"e2e revision test"}')")"
fi
proj "$PID" > "$OUT/project_v1.json"
EXP1=$(jq -r '.credits.exports' "$OUT/project_v1.json"); FRL1=$(jq -r '.credits.free_revisions_left' "$OUT/project_v1.json")
BAL1=$(jq -r '.credits.balance' "$OUT/project_v1.json")
say "project before revision: exports=$EXP1 free_revisions_left=$FRL1 balance=$BAL1"
fi

# ---- 3. one revision round -----------------------------------------------------------------------------------
if [ "$EXP1" != 0 ] && [ "$rc" != 4 ]; then
  turn "$PID" "$REVISION"; rc=$?
  m=0
  while [ "$rc" != 4 ] && [ "$(proj "$PID" | jq -r .credits.exports)" = "$EXP1" ] && [ "$m" -lt 4 ]; do
    m=$((m+1)); say "(no new export yet; follow-up $m/4)"; turn "$PID" "$FOLLOWUP_TEXT"; rc=$?
  done
  proj "$PID" > "$OUT/project_v2.json"
  FRL2=$(jq -r '.credits.free_revisions_left' "$OUT/project_v2.json"); EXP2=$(jq -r '.credits.exports' "$OUT/project_v2.json")
  BAL2=$(jq -r '.credits.balance' "$OUT/project_v2.json")
  check revision_exported "$([ "$EXP2" -gt "$EXP1" ] && echo true || echo false)" "exports $EXP1 → $EXP2 followups=$m"
  if [ "$MODE" = full ]; then
    check free_revisions_left_v2 "$([ "$FRL2" = 3 ] && echo true || echo false)" "free_revisions_left=$FRL2 credits=$(jq -c .credits "$OUT/project_v2.json")"
  elif [ "$(jq -r .credits.in_free "$OUT/project_v1.json")" != true ]; then
    check points_charged "$([ "$BAL2" -lt "$BAL1" ] && echo true || echo false)" "balance $BAL1 → $BAL2 (paid revision) credits=$(jq -c .credits "$OUT/project_v2.json")"
  fi
else
  say "skipping revision round (no export yet or credits needed)"
fi

# ---- 4. download deliverables ------------------------------------------------------------------------------------
proj "$PID" > "$OUT/project.json"
VID=$(jq -r '[.assets[]|select(.kind=="video" and (.name|test("1080")))]|last|.id // empty' "$OUT/project.json")
IMG=$(jq -r '[.assets[]|select(.kind=="image")]|last|.id // empty' "$OUT/project.json")
[ -n "$VID" ] && T=1800 api -o "$OUT/final_1080.mp4" "$BASE/api/projects/$PID/assets/$VID" && say "downloaded final_1080.mp4 $(stat -c %s "$OUT/final_1080.mp4") bytes"
[ -n "$IMG" ] && T=600 api -o "$OUT/cover.jpg" "$BASE/api/projects/$PID/assets/$IMG" && say "downloaded cover.jpg $(stat -c %s "$OUT/cover.jpg") bytes"
STATS=$(api "$BASE/api/admin/stats"); echo "$STATS" > "$OUT/stats.json"
api "$BASE/api/admin/projects/$PID/messages" > "$OUT/transcript.json"

jq -n --arg base "$BASE" --arg pid "$PID" --arg vid "$VID" --arg img "$IMG" --argjson stats "$STATS" \
   --argjson checks "$(printf '%s\n' "${CHECKS[@]}" | jq -s .)" --argjson assets "$(jq .assets "$OUT/project.json")" \
   --argjson credits "$(jq .credits "$OUT/project.json")" \
   '{base:$base, project_id:$pid, final_1080_url:(if $vid!="" then "/api/projects/\($pid)/assets/\($vid)" else null end),
     cover_url:(if $img!="" then "/api/projects/\($pid)/assets/\($img)" else null end), credits:$credits, stats:$stats,
     checks:$checks, assets:$assets}' > "$OUT/summary.json"
say "SUMMARY: $(jq -c '{project_id, final_1080_url, cover_url, credits, stats, checks:[.checks[]|"\(.name)=\(.ok)"]}' "$OUT/summary.json")"
rm -f "$JAR"
jq -e '[.checks[].ok]|all' "$OUT/summary.json" >/dev/null
