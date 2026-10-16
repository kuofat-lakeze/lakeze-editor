"""Deliverable storage: quota math, plan purchase + renewal + lapse, version deletion, export block."""
import asyncio
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace as NS

os.environ.setdefault("DATA_DIR", "/tmp/lk-test-data")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from app import db as D  # noqa: E402
from app import main as M  # noqa: E402
from app.auth import current_user  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_db(tmp_path: Path):
    """Point the app at an empty SQLite file. NullPool: each asyncio.run / TestClient call gets its own
    connection, so nothing is shared across event loops."""
    eng = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/t.db", poolclass=NullPool)
    D.engine = eng
    D.Session.configure(bind=eng)
    asyncio.run(D.init_db())
    yield


async def _mk_user(email="a@b.c", plan="free", points=0):
    async with D.Session() as s:
        u = D.User(email=email, pw_hash="x", storage_plan=plan)
        s.add(u); await s.commit()
    if points:
        await D.add_credits(u.id, points, "grant", "test")
    return u


async def _mk_deliverable(user_id: str, size: int, version=1, kind="video"):
    async with D.Session() as s:
        p = D.Project(user_id=user_id, name="p"); s.add(p); await s.commit()
        root = D.project_dir(p.id); f = root / "out" / f"v{version}.bin"; f.write_bytes(b"x" * size)
        a = D.Asset(project_id=p.id, kind=kind, name="母帶", rel_path=str(f.relative_to(root)), version=version, size_bytes=size)
        s.add(a); await s.commit()
    return p.id


def test_quota_and_state():
    async def go():
        u = await _mk_user()
        await _mk_deliverable(u.id, 1000)
        st = await D.storage_state(u.id)
        assert st["used_bytes"] == 1000 and st["quota_bytes"] == 2 * D.GB and not st["over"]
        async with D.Session() as s:
            uu = await s.get(D.User, u.id); uu.storage_quota_gb = 0; uu.storage_plan = "s20"; await s.commit()
        assert (await D.storage_state(u.id))["quota_bytes"] == 22 * D.GB
    asyncio.run(go())


def test_renewal_charges_then_lapses():
    async def go():
        u = await _mk_user(plan="s20", points=15)
        async with D.Session() as s:
            uu = await s.get(D.User, u.id); uu.storage_renews_at = datetime.now(timezone.utc) - timedelta(hours=1); await s.commit()
        r = await M.renew_storage_plans()
        assert r == {"renewed": 1, "lapsed": 0}
        assert await D.balance(u.id) == 5
        async with D.Session() as s:
            uu = await s.get(D.User, u.id)
            assert uu.storage_plan == "s20" and uu.storage_renews_at is not None
            uu.storage_renews_at = datetime.now(timezone.utc) - timedelta(hours=1); await s.commit()
        r = await M.renew_storage_plans()   # 5 points left: can't pay 10
        assert r == {"renewed": 0, "lapsed": 1}
        async with D.Session() as s:
            uu = await s.get(D.User, u.id)
            assert uu.storage_plan == "free" and uu.storage_renews_at is None
        assert await D.balance(u.id) == 5
    asyncio.run(go())


@pytest.fixture
def client():
    holder = {}
    M.app.dependency_overrides[current_user] = lambda: holder["u"]
    yield TestClient(M.app), holder
    M.app.dependency_overrides.clear()


def test_plan_switch_and_delete_version(client):
    c, holder = client
    u = asyncio.run(_mk_user(points=12))
    holder["u"] = u
    assert c.post("/api/storage/plan", json={"plan": "s100"}).status_code == 402   # 30 > 12
    r = c.post("/api/storage/plan", json={"plan": "s20"}); assert r.status_code == 200, r.text
    assert r.json()["balance"] == 2 and r.json()["storage"]["plan"] == "s20"
    pid = asyncio.run(_mk_deliverable(u.id, 5000))
    s = c.get("/api/storage").json()
    assert s["used_bytes"] == 5000 and s["projects"][0]["id"] == pid and [p["id"] for p in s["plans"]] == ["free", "s20", "s100", "s500"]
    # final version is protected
    asyncio.run(_set_final(pid, 1))
    assert c.delete(f"/api/projects/{pid}/versions/1").status_code == 409
    asyncio.run(_set_final(pid, None))
    r = c.delete(f"/api/projects/{pid}/versions/1"); assert r.status_code == 200, r.text
    assert r.json()["freed_bytes"] == 5000 and r.json()["storage"]["used_bytes"] == 0
    assert c.delete(f"/api/projects/{pid}/versions/1").status_code == 404
    # back to free: immediate, no refund
    r = c.post("/api/storage/plan", json={"plan": "free"}); assert r.json()["storage"]["plan"] == "free"


async def _set_final(pid, v):
    async with D.Session() as s:
        p = await s.get(D.Project, pid); p.final_version = v; await s.commit()


def test_subscription_lifecycle():
    """Activate grants the period's points and bundles storage; renewing expires the unused part
    (included points are used first, top-ups survive); cancelling drops storage back to free."""
    from app import pricing as P
    sub = P.SUBSCRIPTIONS["sub5"]

    async def go():
        u = await _mk_user(points=20)                       # 20 top-up points that must survive
        r = await M.activate_subscription(u.id, "sub5", paid_twd=sub["twd"])
        assert r["granted"] == sub["points"] and r["expired"] == 0
        assert await D.balance(u.id) == 20 + sub["points"]
        async with D.Session() as s:
            uu = await s.get(D.User, u.id)
            assert uu.subscription == "sub5" and uu.storage_plan == sub["storage_plan"] and uu.storage_renews_at is None
        assert (await D.storage_state(u.id))["quota_bytes"] == sub["storage_gb"] * D.GB
        await D.add_credits(u.id, -100, "charge", "build_cut")   # used 100 of the included points
        r = await M.activate_subscription(u.id, "sub5", paid_twd=sub["twd"])   # next month
        assert r["expired"] == sub["points"] - 100                              # leftover of month 1 gone
        assert await D.balance(u.id) == 20 + sub["points"]                      # top-up 20 intact, fresh grant
        # storage renewals never touch a bundled plan
        assert await M.renew_storage_plans() == {"renewed": 0, "lapsed": 0}
        # lapse: renewal date + grace passed
        async with D.Session() as s:
            uu = await s.get(D.User, u.id); uu.sub_renews_at = datetime.now(timezone.utc) - timedelta(days=4); await s.commit()
        assert await M.lapse_subscriptions() == 1
        async with D.Session() as s:
            uu = await s.get(D.User, u.id)
            assert uu.subscription == "" and uu.storage_plan == "free"
        assert await D.balance(u.id) == 20
    asyncio.run(go())


def test_export_blocked_when_over_quota(monkeypatch):
    """The runner refuses export_video / make_cover with a need_storage event when the quota is full."""
    from app.agent import runner as R
    events = []

    class S:
        async def storage_state(self):
            return {"used_bytes": 3 * D.GB, "quota_bytes": 2 * D.GB, "over": True, "plan": "free", "renews_at": None}

        async def charge(self, *a):
            raise AssertionError("must not charge when storage is full")

    async def emit(ev):
        events.append(ev)
    tr = R.TurnRunner.__new__(R.TurnRunner)
    tr.store, tr.emit, tr.project_id = S(), emit, "p"
    res = asyncio.run(tr._run_tool(NS(name="export_video", input={}, id="t1")))
    assert res["is_error"] and "成品空間已滿" in res["content"][0]["text"]
    assert events[1]["type"] == "need_storage" and events[1]["over"]
