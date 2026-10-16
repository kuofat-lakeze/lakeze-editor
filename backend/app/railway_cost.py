"""Railway hosting cost for the admin cost page.

How Railway bills (docs.railway.com/pricing/plans): a monthly plan fee that already includes the same
amount of resource usage (Pro: $20 fee, $20 included), plus per-minute resource usage above that:
  RAM     $10 / GB / month    = $0.000231    per GB-minute
  CPU     $20 / vCPU / month  = $0.000463    per vCPU-minute
  Egress  $0.05 / GB
  Volume  $0.15 / GB / month  = $0.000003472 per GB-minute
Builds are free. The public API's `usage` query returns exactly these units (vCPU-minutes, GB-minutes,
GB) per service, and `estimatedUsage` projects them to the end of the billing month.

We report the usage for the selected window, plus the unused part of the included amount spread over
the days (when the month's usage stays under the plan fee, that difference is still paid).
Needs RAILWAY_COST_TOKEN: a *project* token (read access to this project only), never an account token.
"""
import asyncio
import calendar
import os
import time
from datetime import datetime, timedelta, timezone

import httpx

API = "https://backboard.railway.com/graphql/v2"
TOKEN = os.environ.get("RAILWAY_COST_TOKEN", "")
PROJECT_ID = os.environ.get("RAILWAY_PROJECT_ID", "")          # injected by Railway into every service
PLAN_FEE_USD = float(os.environ.get("RAILWAY_PLAN_FEE_USD", "20"))   # Pro; Hobby would be 5

# measurement -> (label, unit shown, USD per unit)
RATES = {
    "CPU_USAGE": ("CPU", "vCPU·分", 20 / 43200),
    "MEMORY_USAGE_GB": ("記憶體", "GB·分", 10 / 43200),
    "NETWORK_TX_GB": ("對外流量", "GB", 0.05),
    "DISK_USAGE_GB": ("硬碟（Volume）", "GB·分", 0.15 / 43200),
}
SERVICE_LABEL = {"backend": "後端（剪輯、轉檔）", "frontend": "前端網頁"}

_cache: dict[int, tuple[float, dict]] = {}


async def _gql(c: httpx.AsyncClient, q: str, v: dict) -> dict:
    r = await c.post(API, json={"query": q, "variables": v}, headers={"Project-Access-Token": TOKEN})
    r.raise_for_status()
    j = r.json()
    if j.get("errors"):
        raise RuntimeError(j["errors"][0].get("message", "railway api error"))
    return j["data"]


async def _fetch(days: int) -> dict:
    ref = datetime.now(timezone.utc)
    since = ref - timedelta(days=days)
    ms = list(RATES)
    async with httpx.AsyncClient(timeout=15) as c:
        used, est, proj = await asyncio.gather(
            _gql(c, "query($p:String!,$s:DateTime!,$e:DateTime!,$m:[MetricMeasurement!]!){ usage(projectId:$p, measurements:$m,"
                    " startDate:$s, endDate:$e, groupBy:[SERVICE_ID]){ measurement value tags{ serviceId } } }",
                 {"p": PROJECT_ID, "s": since.isoformat(), "e": ref.isoformat(), "m": ms}),
            _gql(c, "query($p:String!,$m:[MetricMeasurement!]!){ estimatedUsage(projectId:$p, measurements:$m){ measurement estimatedValue } }",
                 {"p": PROJECT_ID, "m": ms}),
            _gql(c, "query($p:String!){ project(id:$p){ services{ edges{ node{ id name } } } } }", {"p": PROJECT_ID}),
        )
    names = {e["node"]["id"]: e["node"]["name"] for e in proj["project"]["services"]["edges"]}
    items: dict[str, dict] = {}
    for u in used["usage"]:
        label, unit, rate = RATES[u["measurement"]]
        svc = names.get((u.get("tags") or {}).get("serviceId") or "", "其他")
        iid = f"{svc}:{u['measurement']}"
        it = items.setdefault(iid, {"id": iid, "label": f"{SERVICE_LABEL.get(svc, svc)} · {label}", "usd": 0.0,
                                    "units": 0.0, "unit": unit, "calls": 0})
        it["usd"] += (u["value"] or 0) * rate
        it["units"] += u["value"] or 0
    month_est = sum((e["estimatedValue"] or 0) * RATES[e["measurement"]][2] for e in est["estimatedUsage"])
    dim = calendar.monthrange(ref.year, ref.month)[1]
    floor = max(0.0, PLAN_FEE_USD - month_est) * days / dim
    if floor > 0:
        items["plan_floor"] = {"id": "plan_floor", "label": f"方案低消差額（月費 ${PLAN_FEE_USD:g} 含等額用量，沒用完的部分依天數分攤）",
                               "usd": floor, "units": days, "unit": "天", "calls": 0}
    return {"ok": True, "items": list(items.values()), "usd": sum(i["usd"] for i in items.values()),
            "usage_usd": sum(i["usd"] for k, i in items.items() if k != "plan_floor"),
            "month_estimate_usd": round(month_est, 2), "month_bill_usd": round(max(PLAN_FEE_USD, month_est), 2),
            "plan_fee_usd": PLAN_FEE_USD}


async def cost(days: int) -> dict:
    """Railway cost for the last `days` days; cached 10 minutes. Never raises."""
    if not TOKEN or not PROJECT_ID:
        return {"ok": False, "error": "未設定 RAILWAY_COST_TOKEN，暫時只能估月費", "items": [], "usd": PLAN_FEE_USD * days / 30,
                "usage_usd": 0.0, "month_estimate_usd": None, "month_bill_usd": PLAN_FEE_USD, "plan_fee_usd": PLAN_FEE_USD}
    hit = _cache.get(days)
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    try:
        out = await _fetch(days)
    except Exception as e:   # the cost page must still load when Railway's API is slow or down
        if hit:
            return hit[1]
        return {"ok": False, "error": f"Railway 用量暫時讀不到：{str(e)[:80]}", "items": [], "usd": PLAN_FEE_USD * days / 30,
                "usage_usd": 0.0, "month_estimate_usd": None, "month_bill_usd": PLAN_FEE_USD, "plan_fee_usd": PLAN_FEE_USD}
    _cache[days] = (time.time(), out)
    return out
