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
        assert st["used_bytes"] == 1000 and st["quota_bytes"] == 500 * 2**20 and st["retention_days"] == 7 and not st["over"]
        async with D.Session() as s:
            uu = await s.get(D.User, u.id); uu.storage_quota_gb = 0; uu.storage_plan = "s20"; await s.commit()
        assert (await D.storage_state(u.id))["quota_bytes"] == 20 * D.GB
    asyncio.run(go())


def test_renewal_charges_then_lapses():
    async def go():
        u = await _mk_user(plan="s20", points=30)
        async with D.Session() as s:
            uu = await s.get(D.User, u.id); uu.storage_renews_at = datetime.now(timezone.utc) - timedelta(hours=1); await s.commit()
        r = await M.renew_storage_plans()
        assert r == {"renewed": 1, "lapsed": 0}
        assert await D.balance(u.id) == 10
        async with D.Session() as s:
            uu = await s.get(D.User, u.id)
            assert uu.storage_plan == "s20" and uu.storage_renews_at is not None
            uu.storage_renews_at = datetime.now(timezone.utc) - timedelta(hours=1); await s.commit()
        r = await M.renew_storage_plans()   # 10 points left: can't pay 20
        assert r == {"renewed": 0, "lapsed": 1}
        async with D.Session() as s:
            uu = await s.get(D.User, u.id)
            assert uu.storage_plan == "free" and uu.storage_renews_at is None
        assert await D.balance(u.id) == 10
    asyncio.run(go())


@pytest.fixture
def client():
    holder = {}
    M.app.dependency_overrides[current_user] = lambda: holder["u"]
    yield TestClient(M.app), holder
    M.app.dependency_overrides.clear()


def test_plan_switch_and_delete_version(client):
    c, holder = client
    u = asyncio.run(_mk_user(points=24))
    holder["u"] = u
    assert c.post("/api/storage/plan", json={"plan": "s100"}).status_code == 402   # 60 > 24
    r = c.post("/api/storage/plan", json={"plan": "s20"}); assert r.status_code == 200, r.text
    assert r.json()["balance"] == 4 and r.json()["storage"]["plan"] == "s20"
    pid = asyncio.run(_mk_deliverable(u.id, 5000))
    s = c.get("/api/storage").json()
    assert s["used_bytes"] == 5000 and s["projects"][0]["id"] == pid and [p["id"] for p in s["plans"]] == ["free", "s20", "s100"]
    assert [p["gb"] for p in s["plans"]] == [0.5, 20, 100]
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


def test_own_voice_is_a_subscription_feature(client, monkeypatch, tmp_path: Path):
    """Cloning is refused on the free/payg tiers, works on a subscription, and the voice shows up first in /api/voices."""
    from app import pricing as P
    from app.pipeline import eleven, ff
    c, holder = client
    u = asyncio.run(_mk_user())
    holder["u"] = u
    assert P.has_feature("sub5", P.OWN_VOICE) and P.has_feature("", P.OWN_VOICE, paying=True) and P.has_feature("", P.OWN_VOICE)
    me = c.get("/api/me").json()
    assert me["tier"] == "free" and me["can_clone_voice"] and me["voice_trial"] == {"used": 0, "limit": P.TRIAL_VOICE_SECONDS}
    asyncio.run(D.add_credits(u.id, 50, "purchase", "p500", amount_twd=500))
    me = c.get("/api/me").json()
    assert me["tier"] == "payg" and me["can_clone_voice"] and me["voice_trial"] is None
    asyncio.run(M.activate_subscription(u.id, "sub5"))
    async def fresh():
        async with D.Session() as s:
            return await s.get(D.User, u.id)
    holder["u"] = asyncio.run(fresh())
    monkeypatch.setattr(ff, "ffmpeg", lambda *a, **k: Path(a[-1]).write_bytes(b"mp3"))
    monkeypatch.setattr(ff, "duration", lambda p: 45.0)
    calls = []
    monkeypatch.setattr(eleven, "add_voice", lambda name, sample, description="": (calls.append(name), "v_clone")[1])
    monkeypatch.setattr(eleven, "delete_voice", lambda vid: calls.append(("del", vid)))
    monkeypatch.setattr(M, "_voices_cache", {"at": 1e12, "data": [{"voice_id": "preset", "name": "Vivian"}]})
    r = c.post("/api/voice/clone", files={"file": ("s.webm", b"xx", "audio/webm")}, data={"name": "老闆"})
    assert r.status_code == 200, r.text
    assert r.json()["voice"]["voice_id"] == "v_clone" and calls and "老闆" in calls[0]
    holder["u"] = asyncio.run(fresh())
    vs = c.get("/api/voices").json()
    assert vs[0]["voice_id"] == "v_clone" and vs[0]["custom"] and vs[1]["voice_id"] == "preset"
    assert c.get("/api/me").json()["voice"]["name"] == "老闆"
    # too short a recording is refused before anything is sent
    monkeypatch.setattr(ff, "duration", lambda p: 8.0)
    assert c.post("/api/voice/clone", files={"file": ("s.webm", b"xx", "audio/webm")}).status_code == 400
    assert c.delete("/api/voice/clone").status_code == 200 and ("del", "v_clone") in calls


def test_signup_gets_welcome_points(client):
    from app import pricing as P
    c, holder = client
    holder["u"] = asyncio.run(_mk_user(email="other@x.y"))
    r = c.post("/api/auth/signup", json={"email": "new@lakeze.com", "password": "password123"})
    assert r.status_code == 200, r.text
    assert asyncio.run(D.balance(r.json()["id"])) == P.SIGNUP_POINTS == 220
    assert P.FIRST_VIDEO_POINTS + 2 * P.REVISION_POINTS == 200 and P.POINT_TWD == 3.5
    # every NT$ price is what it was at NT$7 a point
    assert (P.FIRST_VIDEO_POINTS + 2 * P.REVISION_POINTS) * P.POINT_TWD == 700 and P.PACKS["p300"] == {**P.PACKS["p300"], "twd": 2100, "points": 600}
    assert [P.SUBSCRIPTIONS[k]["twd"] for k in ("sub5", "sub15")] == [3150, 8550]
    assert not asyncio.run(D.has_paid(r.json()["id"]))   # a gift isn't a purchase: trial rules still apply


def test_trial_voice_cap():
    """On the free tier the owner's clone may narrate TRIAL_VOICE_SECONDS; a longer script is refused
    before anything is generated, and paying lifts the cap."""
    from app import pricing as P
    from app.agent import tools as T
    from app.pipeline import eleven

    async def go():
        u = await _mk_user()
        async with D.Session() as s:
            uu = await s.get(D.User, u.id); uu.voice_id = "v_clone"; uu.voice_name = "老闆"; await s.commit()
        st = D.Store(u.id)
        assert await st.voice_trial("v_clone") == {"used": 0, "limit": P.TRIAL_VOICE_SECONDS}
        assert await st.voice_trial("preset") is None
        await st.add_voice_seconds(12.5)
        assert (await st.voice_trial("v_clone"))["used"] == 12.5
        await D.add_credits(u.id, 50, "purchase", "p500", amount_twd=500)
        assert await st.voice_trial("v_clone") is None
    asyncio.run(go())

    used = []
    ctx = T.ToolContext(root=Path("/tmp"), add_asset=lambda *a, **k: {"id": "x"}, record_usage=lambda *a, **k: None,
                        voice_trial=lambda vid: {"used": 20.0, "limit": 30} if vid == "v_clone" else None, voice_used=used.append)
    long_script = {"voice_id": "v_clone", "lines": [{"key": "A", "text": "這是一段很長很長的旁白" * 8}]}
    with pytest.raises(RuntimeError) as e:
        T._voice(long_script, ctx)
    assert "最多生成 30 秒" in str(e.value) and "剩 10 秒" in str(e.value)
    # a short line fits and its real duration is added to the counter
    fake = lambda lines, voice_id, vo_dir, **k: [{"key": l["key"], "text": l["text"], "file": "a.wav", "duration": 4.2, "transcript": l["text"], "match": 1.0, "takes": 1, "ok": True} for l in lines]
    T.eleven.tts_verified = fake  # type: ignore[attr-defined]
    try:
        out = T._voice({"voice_id": "v_clone", "lines": [{"key": "A", "text": "歡迎來到宜蘭"}]}, ctx)
        assert "全部句子核對通過" in out[0]["text"] and used == [4.2]
    finally:
        T.eleven.tts_verified = eleven.tts_verified


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


def test_free_plan_removes_deliverables_after_7_days():
    async def go():
        free = await _mk_user("free@x.y")
        paid = await _mk_user("paid@x.y", plan="s20")
        old = datetime.now(timezone.utc) - timedelta(days=8)
        pf = await _mk_deliverable(free.id, 100)
        pp = await _mk_deliverable(paid.id, 100)
        pn = await _mk_deliverable(free.id, 100, version=2)   # recent: stays
        async with D.Session() as s:
            for a in (await s.execute(D.select(D.Asset).where(D.Asset.project_id.in_([pf, pp])))).scalars():
                a.created_at = old
            p = await s.get(D.Project, pf); p.final_version = 1
            s.add(D.Share(token="tok1", project_id=pf, version=1))
            await s.commit()
        r = await M.purge_free_deliverables()
        assert r == {"removed": 1, "freed_bytes": 100}
        async with D.Session() as s:
            left = {a.project_id for a in (await s.execute(D.select(D.Asset))).scalars()}
            assert left == {pp, pn}                       # paid storage keeps old files; recent free files stay
            assert (await s.get(D.Project, pf)).final_version is None
            assert (await s.execute(D.select(D.Share).where(D.Share.token == "tok1"))).scalar_one().revoked
        # dropping from paid to free starts the 7 days from that moment, not from when the file was made
        async with D.Session() as s:
            u = await s.get(D.User, paid.id); u.storage_plan = "free"; u.storage_free_since = datetime.now(timezone.utc); await s.commit()
        assert (await M.purge_free_deliverables())["removed"] == 0
        async with D.Session() as s:
            u = await s.get(D.User, paid.id); a = (await s.execute(D.select(D.Asset).where(D.Asset.project_id == pp))).scalar_one()
            exp = D.deliverable_expiry(u, a.created_at)
            assert timedelta(days=6) < exp - datetime.now(timezone.utc) <= timedelta(days=7)
    asyncio.run(go())


def test_points_rescale_doubles_the_ledger_once():
    """1 點 NT$7 → NT$3.5: an existing ledger is doubled exactly once, so balances keep their NT$ worth."""
    async def go():
        u = await _mk_user(points=110)
        await D.add_credits(u.id, -64, "charge", "build_cut")
        async with D.Session() as s:
            s.add(D.Order(user_id=u.id, item="p50", kind="pack", label="50 點", points=50, amount_twd=350, method="transfer", status="reported"))
            await s.commit()
        async with D.engine.begin() as conn:   # pretend this database predates the rescale
            await conn.execute(D.text("DELETE FROM app_flags"))
        await D.init_db(); await D.init_db()    # runs once, then never again
        assert await D.balance(u.id) == (110 - 64) * 2
        async with D.Session() as s:
            o = (await s.execute(D.select(D.Order))).scalar_one()
            assert o.points == 100
    asyncio.run(go())
