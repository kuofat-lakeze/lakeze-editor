"""Railway hosting cost for the admin cost page, worked out per day.

How Railway bills (docs.railway.com/pricing/plans): each billing cycle costs the plan fee, which already
includes the same amount of resource usage (Pro: $20 fee, $20 included), plus any usage above that:
  RAM     $10 / GB / month    = $0.000231    per GB-minute
  CPU     $20 / vCPU / month  = $0.000463    per vCPU-minute
  Egress  $0.05 / GB
  Volume  $0.15 / GB / month  = $0.000003472 per GB-minute
Builds are free. The API's `usage` query returns exactly these units (vCPU-minutes, GB-minutes, GB) for
any time range, so one query per UTC day gives that day's real usage.

A cycle's bill is max(fee, usage). Per day we count the day's own usage plus that day's share of the
part of the fee the cycle's usage didn't use up, spread by the hour over the cycle (which runs from the
anchor time, e.g. the 16th 03:09 UTC, to the same time next month; not calendar months). Past cycles use
their actual usage, the current one Railway's own estimate to the end of the cycle. The days of a cycle
therefore add up to exactly what that cycle is billed.

Needs RAILWAY_COST_TOKEN: a *project* token (read access to this project only), never an account token.
A project token can't read the workspace's billing period, so the first cycle start is configured in
RAILWAY_BILLING_ANCHOR (ISO time; the workspace's billing page / API shows it).
"""
import asyncio
import calendar
import json
import os
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

API = "https://backboard.railway.com/graphql/v2"
TOKEN = os.environ.get("RAILWAY_COST_TOKEN", "")
PROJECT_ID = os.environ.get("RAILWAY_PROJECT_ID", "")          # injected by Railway into every service
PLAN_FEE_USD = float(os.environ.get("RAILWAY_PLAN_FEE_USD", "20"))   # Pro; Hobby would be 5
ANCHOR = datetime.fromisoformat(os.environ.get("RAILWAY_BILLING_ANCHOR", "2026-10-16T03:09:08+00:00").replace("Z", "+00:00"))
CACHE_FILE = Path(os.environ.get("DATA_DIR", "/data")) / "railway_daily.json"   # finished days never change

# measurement -> (label, unit shown, USD per unit)
RATES = {
    "CPU_USAGE": ("CPU", "vCPU·分", 20 / 43200),
    "MEMORY_USAGE_GB": ("記憶體", "GB·分", 10 / 43200),
    "NETWORK_TX_GB": ("對外流量", "GB", 0.05),
    "DISK_USAGE_GB": ("硬碟（Volume）", "GB·分", 0.15 / 43200),
}
SERVICE_LABEL = {"backend": "後端（剪輯、轉檔）", "frontend": "前端網頁"}
LIVE_TTL = 600   # today, the current cycle's estimate and service names: refreshed every 10 minutes

_days: dict[str, list] = {}          # "YYYY-MM-DD" -> [{svc, m, v}] for finished days (also on disk)
_cycles: dict[str, float] = {}       # finished cycle start iso -> actual usage USD
_live: dict[str, tuple[float, object]] = {}
_sem = asyncio.Semaphore(6)


def _post(q: str, v: dict) -> dict:
    req = urllib.request.Request(API, data=json.dumps({"query": q, "variables": v}).encode(),
                                 headers={"Project-Access-Token": TOKEN, "content-type": "application/json", "user-agent": "lakeze-editor"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


async def _gql(q: str, v: dict) -> dict:
    async with _sem:
        j = await asyncio.to_thread(_post, q, v)
    if j.get("errors"):
        raise RuntimeError(j["errors"][0].get("message", "railway api error"))
    return j["data"]


async def _usage(start: datetime, end: datetime) -> list[dict]:
    d = await _gql("query($p:String!,$s:DateTime!,$e:DateTime!,$m:[MetricMeasurement!]!){ usage(projectId:$p, measurements:$m,"
                   " startDate:$s, endDate:$e, groupBy:[SERVICE_ID]){ measurement value tags{ serviceId } } }",
                   {"p": PROJECT_ID, "s": start.isoformat(), "e": end.isoformat(), "m": list(RATES)})
    return [{"svc": (u.get("tags") or {}).get("serviceId") or "", "m": u["measurement"], "v": u["value"] or 0} for u in d["usage"]]


def _usd(rows: list[dict]) -> float:
    return sum(r["v"] * RATES[r["m"]][2] for r in rows if r["m"] in RATES)


def _load_disk() -> None:
    if not _days and CACHE_FILE.exists():
        try:
            j = json.loads(CACHE_FILE.read_text())
            _days.update(j.get("days", {})); _cycles.update(j.get("cycles", {}))
        except Exception:
            pass


def _save_disk() -> None:
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        CACHE_FILE.write_text(json.dumps({"days": _days, "cycles": _cycles}))
    except Exception:
        pass


async def _live_get(key: str, fn):
    hit = _live.get(key)
    if hit and time.time() - hit[0] < LIVE_TTL:
        return hit[1]
    val = await fn()
    _live[key] = (time.time(), val)
    return val


async def _day_rows(d: date, now: datetime) -> list[dict]:
    start = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    if end <= ANCHOR - timedelta(days=1):          # before the project / billing existed
        return []
    if end <= now:                                  # finished day: fetch once, keep forever
        k = d.isoformat()
        if k not in _days:
            _days[k] = await _usage(start, end)
        return _days[k]
    return await _live_get(f"day:{d.isoformat()}", lambda: _usage(start, now))


def _add_months(t: datetime, n: int) -> datetime:
    y, m = divmod(t.month - 1 + n, 12)
    y, m = t.year + y, m + 1
    return t.replace(year=y, month=m, day=min(ANCHOR.day, calendar.monthrange(y, m)[1]))


def _cycle_of(t: datetime) -> tuple[datetime, datetime] | None:
    """The billing cycle [start, end) containing t, or None before the first one."""
    if t < ANCHOR:
        return None
    n = (t.year - ANCHOR.year) * 12 + t.month - ANCHOR.month
    if _add_months(ANCHOR, n) > t:
        n -= 1
    return _add_months(ANCHOR, n), _add_months(ANCHOR, n + 1)   # always from the anchor, so a 31st never drifts


async def _cycle_usage(s: datetime, e: datetime, now: datetime) -> tuple[float, bool]:
    """(usage USD for the whole cycle, is_estimate). Current cycle: Railway's projection to its end."""
    if e <= now:
        k = s.isoformat()
        if k not in _cycles:
            _cycles[k] = _usd(await _usage(s, e))
        return _cycles[k], False

    async def est():
        d = await _gql("query($p:String!,$m:[MetricMeasurement!]!){ estimatedUsage(projectId:$p, measurements:$m){ measurement estimatedValue } }",
                       {"p": PROJECT_ID, "m": list(RATES)})
        return sum((x["estimatedValue"] or 0) * RATES[x["measurement"]][2] for x in d["estimatedUsage"])
    return await _live_get(f"est:{s.isoformat()}", est), True


async def _names() -> dict[str, str]:
    async def q():
        d = await _gql("query($p:String!){ project(id:$p){ services{ edges{ node{ id name } } } } }", {"p": PROJECT_ID})
        return {x["node"]["id"]: x["node"]["name"] for x in d["project"]["services"]["edges"]}
    return await _live_get("names", q)


async def _fetch(days: int) -> dict:
    _load_disk()
    now = datetime.now(timezone.utc)
    today = now.date()
    dates = [today - timedelta(days=days - 1 - i) for i in range(days)]
    names, rows = await asyncio.gather(_names(), asyncio.gather(*[_day_rows(d, now) for d in dates]))

    # the unused part of each cycle's fee, spread by the hour over the cycle
    cycles: dict[datetime, dict] = {}
    floor_by_day: dict[date, float] = {}
    for d in dates:
        ds = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
        t, total = ds, 0.0
        while t < ds + timedelta(days=1):          # a UTC day can straddle two cycles (they start at 03:09)
            c = _cycle_of(t)
            if c is None:
                t = min(ds + timedelta(days=1), ANCHOR)
                continue
            s, e = c
            if s not in cycles:
                used, is_est = await _cycle_usage(s, e, now)
                span = (e - s).total_seconds()
                cycles[s] = {"start": s, "end": e, "usage_usd": used, "estimate": is_est,
                             "floor_per_sec": max(0.0, PLAN_FEE_USD - used) / span, "bill_usd": max(PLAN_FEE_USD, used)}
            seg_end = min(e, ds + timedelta(days=1))
            total += cycles[s]["floor_per_sec"] * (seg_end - t).total_seconds()
            t = seg_end
        floor_by_day[d] = total

    items: dict[str, dict] = {}
    daily = []
    for d, rs in zip(dates, rows):
        use = 0.0
        for r in rs:
            label, unit, rate = RATES[r["m"]]
            svc = names.get(r["svc"], "其他")
            iid = f"{svc}:{r['m']}"
            it = items.setdefault(iid, {"id": iid, "label": f"{SERVICE_LABEL.get(svc, svc)} · {label}", "usd": 0.0,
                                        "units": 0.0, "unit": unit, "calls": 0})
            it["usd"] += r["v"] * rate; it["units"] += r["v"]; use += r["v"] * rate
        fl = floor_by_day[d]
        daily.append({"date": d.isoformat(), "usage_usd": round(use, 4), "floor_usd": round(fl, 4), "usd": round(use + fl, 4)})
    floor = sum(x["floor_usd"] for x in daily)
    billed_days = sum(1 for x in daily if x["usd"] > 0)
    if floor > 0:
        items["plan_floor"] = {"id": "plan_floor", "label": f"方案月費未用完的部分（月費 ${PLAN_FEE_USD:g} 內含等額用量，依帳單週期逐日攤提）",
                               "usd": floor, "units": billed_days, "unit": "天", "calls": 0}
    _save_disk()
    cur = _cycle_of(now)
    cc = cycles.get(cur[0]) if cur else None
    if cur and cc is None:
        used, is_est = await _cycle_usage(cur[0], cur[1], now)
        cc = {"start": cur[0], "end": cur[1], "usage_usd": used, "bill_usd": max(PLAN_FEE_USD, used)}
    usage_usd = sum(x["usage_usd"] for x in daily)
    return {"ok": True, "items": list(items.values()), "daily": daily,
            "usd": usage_usd + floor, "usage_usd": usage_usd, "floor_usd": floor, "plan_fee_usd": PLAN_FEE_USD,
            "month_estimate_usd": round(cc["usage_usd"], 2) if cc else None,
            "month_bill_usd": round(cc["bill_usd"], 2) if cc else PLAN_FEE_USD,
            "cycle_start": cc["start"].isoformat() if cc else None, "cycle_end": cc["end"].isoformat() if cc else None}


_cache: dict[int, tuple[float, dict]] = {}


def _fallback(days: int, error: str) -> dict:
    return {"ok": False, "error": error, "items": [], "daily": [], "usd": PLAN_FEE_USD * days / 30, "usage_usd": 0.0,
            "floor_usd": PLAN_FEE_USD * days / 30, "month_estimate_usd": None, "month_bill_usd": PLAN_FEE_USD, "plan_fee_usd": PLAN_FEE_USD}


async def cost(days: int) -> dict:
    """Railway cost for the last `days` UTC days (today included), day by day. Never raises."""
    if not TOKEN or not PROJECT_ID:
        return _fallback(days, "未設定 RAILWAY_COST_TOKEN，暫時只能估月費")
    hit = _cache.get(days)
    if hit and time.time() - hit[0] < LIVE_TTL:
        return hit[1]
    try:
        out = await _fetch(days)
    except Exception as e:   # the cost page must still load when Railway's API is slow or down
        if hit:
            return hit[1]
        return _fallback(days, f"Railway 用量暫時讀不到：{str(e)[:80]}")
    _cache[days] = (time.time(), out)
    return out
