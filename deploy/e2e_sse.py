#!/usr/bin/env python3
"""Pretty-print the project SSE stream (stdin) as compact lines; used by deploy/e2e.sh.

Exit codes: 0 = turn finished (done/idle), 4 = agent asked for credits, 1 = stream ended early.
"""
import json
import sys

buf = []
rc = 1
need_credits = False


def flush():
    global buf
    if buf:
        txt = "".join(buf).strip()
        if txt:
            print(f"ASSISTANT: {txt}", flush=True)
        buf = []


for line in sys.stdin:
    line = line.rstrip("\n")
    if not line.startswith("data: "):
        continue
    try:
        ev = json.loads(line[6:])
    except json.JSONDecodeError:
        continue
    t = ev.get("type")
    if t == "text":
        buf.append(ev.get("text", ""))
        continue
    if t == "thinking":
        continue
    flush()
    if t == "tool_run":
        print(f"[tool_run] {ev.get('name')} {str(ev.get('input', ''))[:160]}", flush=True)
    elif t == "tool_end":
        s = str(ev.get("summary", "")).replace("\n", " ")[:220]
        print(f"[tool_end] {ev.get('name')} ok={ev.get('ok')} {ev.get('seconds')}s {s}", flush=True)
    elif t == "asset":
        a = ev.get("asset", {})
        print(f"[asset] id={a.get('id')} kind={a.get('kind')} name={a.get('name')}", flush=True)
    elif t == "need_credits":
        need_credits = True
        print(f"[need_credits] {json.dumps(ev, ensure_ascii=False)}", flush=True)
    elif t in ("done", "idle"):
        print(f"[{t}]", flush=True)
        rc = 4 if need_credits else 0
        break
    elif t == "tool_start":
        pass
    else:
        print(f"[{t}] {json.dumps(ev, ensure_ascii=False)[:300]}", flush=True)
flush()
sys.exit(rc)
