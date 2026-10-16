"""Railway hosting cost: real usage per UTC day + the unused part of the plan fee spread over the billing cycle."""
import asyncio
from datetime import datetime, timedelta, timezone

from app import railway_cost as R


def test_daily_cost_adds_up_to_the_cycle_bill(monkeypatch, tmp_path):
    now = datetime.now(timezone.utc)
    anchor = (now - timedelta(days=40)).replace(hour=3, minute=9, second=0, microsecond=0)
    monkeypatch.setattr(R, "TOKEN", "t"); monkeypatch.setattr(R, "PROJECT_ID", "p"); monkeypatch.setattr(R, "ANCHOR", anchor)
    monkeypatch.setattr(R, "CACHE_FILE", tmp_path / "rw.json")
    for d in (R._days, R._cycles, R._live, R._cache):
        d.clear()

    async def usage(start, end):   # 0.1 vCPU all the time → $0.000463 × 0.1 per minute
        mins = max(0.0, (min(end, now) - max(start, anchor)).total_seconds() / 60)
        return [{"svc": "b", "m": "CPU_USAGE", "v": 0.1 * mins}]

    async def gql(q, v):
        if "estimatedUsage" in q:
            s, e = R._cycle_of(now)
            return {"estimatedUsage": [{"measurement": "CPU_USAGE", "estimatedValue": 0.1 * (e - s).total_seconds() / 60}]}
        return {"project": {"services": {"edges": [{"node": {"id": "b", "name": "backend"}}]}}}
    monkeypatch.setattr(R, "_usage", usage); monkeypatch.setattr(R, "_gql", gql)

    out = asyncio.run(R._fetch(60))
    day = {x["date"]: x for x in out["daily"]}
    # nothing before billing started; afterwards every day pays usage + its share of the unused fee
    assert day[(anchor - timedelta(days=2)).date().isoformat()]["usd"] == 0
    full = (now - timedelta(days=5)).date().isoformat()
    use_per_day = 0.1 * 1440 * 20 / 43200
    assert abs(day[full]["usage_usd"] - use_per_day) < 1e-3 and day[full]["floor_usd"] > 0
    # the finished cycle: its days (usage + fee share) add up to exactly the $20 it was billed
    s, e = R._cycle_of(anchor)
    in_cycle = 0.0
    for x in out["daily"]:
        ds = datetime.fromisoformat(x["date"]).replace(tzinfo=timezone.utc)
        ov = (min(e, ds + timedelta(days=1)) - max(s, ds)).total_seconds()
        if ov > 0:   # the boundary days are split between the two cycles by the hour
            in_cycle += x["usage_usd"] * ov / 86400 if ds < s or ds + timedelta(days=1) > e else x["usage_usd"]
    total_floor_cycle = max(0.0, R.PLAN_FEE_USD - R._cycles[s.isoformat()])
    assert abs(R._cycles[s.isoformat()] - 0.1 * (e - s).total_seconds() / 60 * 20 / 43200) < 1e-6
    assert abs(in_cycle + total_floor_cycle - R.PLAN_FEE_USD) < 0.02
    assert any(i["id"] == "plan_floor" for i in out["items"]) and out["month_bill_usd"] == R.PLAN_FEE_USD
    # finished days are kept on disk and not asked for again
    assert (tmp_path / "rw.json").exists() and full in R._days


def test_cycle_boundaries_follow_the_anchor_day():
    a = datetime(2026, 1, 31, 3, 9, tzinfo=timezone.utc)
    orig = R.ANCHOR
    try:
        R.ANCHOR = a
        assert R._cycle_of(a - timedelta(seconds=1)) is None
        assert R._cycle_of(datetime(2026, 2, 28, 12, tzinfo=timezone.utc)) == (datetime(2026, 2, 28, 3, 9, tzinfo=timezone.utc), datetime(2026, 3, 31, 3, 9, tzinfo=timezone.utc))
        assert R._cycle_of(datetime(2026, 2, 28, 1, tzinfo=timezone.utc))[0] == a
    finally:
        R.ANCHOR = orig
