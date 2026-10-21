"""推薦好友: personal link → referrer recorded; the friend's first finished video pays the referrer once,
30 points (60 while the referrer has a subscription)."""
import asyncio
import os
from pathlib import Path

os.environ.setdefault("DATA_DIR", "/tmp/lk-test-data")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from app import db as D  # noqa: E402
from app import main as M  # noqa: E402
from app import pricing as P  # noqa: E402
from app.auth import current_user  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_db(tmp_path: Path):
    eng = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/t.db", poolclass=NullPool)
    D.engine = eng
    D.Session.configure(bind=eng)
    asyncio.run(D.init_db())
    yield
    M.app.dependency_overrides.clear()


async def _user(email: str, **kw) -> D.User:
    async with D.Session() as s:
        u = D.User(email=email, pw_hash="x", **kw); s.add(u); await s.commit(); return u


def _as(u):
    M.app.dependency_overrides[current_user] = lambda: u
    return TestClient(M.app)


def test_personal_link_and_first_video_reward():
    ref = asyncio.run(_user("ref@x.y"))
    me = _as(ref).get("/api/referral").json()
    assert me["link"] == f"/signup?ref=u-{ref.id}" and me["points"] == P.REFERRAL_POINTS and me["points_sub"] == P.REFERRAL_POINTS_SUB
    assert me["friends"] == [] and me["earned"] == 0 and me["subscribed"] is False
    # a friend signs up through the personal link
    M.app.dependency_overrides.clear()
    r = TestClient(M.app).post("/api/auth/signup", json={"email": "friend@x.y", "password": "password123", "ref": f"u-{ref.id}"})
    assert r.status_code == 200
    fid = r.json()["id"]
    me = _as(ref).get("/api/referral").json()
    assert len(me["friends"]) == 1 and me["friends"][0]["made_video"] is False and me["friends"][0]["points"] is None
    assert me["friends"][0]["email"].startswith("fr") and "＊" in me["friends"][0]["email"]
    before = asyncio.run(D.balance(ref.id))

    async def export_twice():
        async with D.Session() as s:
            p = D.Project(user_id=fid, name="F1"); s.add(p); await s.commit(); pid = p.id
        st = D.Store(fid)
        await st.note_export(pid)
        await st.note_export(pid)   # second export: nothing more
        async with D.Session() as s:
            p2 = D.Project(user_id=fid, name="F2"); s.add(p2); await s.commit()
        await st.note_export(p2.id)  # another project: still nothing more
    asyncio.run(export_twice())
    assert asyncio.run(D.balance(ref.id)) == before + P.REFERRAL_POINTS
    me = _as(ref).get("/api/referral").json()
    assert me["friends"][0]["made_video"] is True and me["friends"][0]["points"] == P.REFERRAL_POINTS and me["earned"] == P.REFERRAL_POINTS


def test_subscriber_gets_double_and_bad_links_are_ignored():
    ref = asyncio.run(_user("sub@x.y", subscription="sub15"))
    M.app.dependency_overrides.clear()
    fid = TestClient(M.app).post("/api/auth/signup", json={"email": "f@x.y", "password": "password123", "ref": f"u-{ref.id}"}).json()["id"]
    assert asyncio.run(D.reward_referrer(fid)) == 0   # no video yet

    async def one_export():
        async with D.Session() as s:
            p = D.Project(user_id=fid, name="F1"); s.add(p); await s.commit(); pid = p.id
        await D.Store(fid).note_export(pid)
    asyncio.run(one_export())
    assert asyncio.run(D.balance(ref.id)) == P.REFERRAL_POINTS_SUB
    assert asyncio.run(D.reward_referrer(fid)) == 0   # paid once
    # unknown personal link and self-referral leave no referrer
    r = TestClient(M.app).post("/api/auth/signup", json={"email": "g@x.y", "password": "password123", "ref": "u-nobody"})
    assert r.status_code == 200
    async def referrer_of(uid):
        async with D.Session() as s:
            return (await s.get(D.User, uid)).referrer_id
    assert asyncio.run(referrer_of(r.json()["id"])) is None
    assert _as(ref).get("/api/pricing").json()["referral_points"] == P.REFERRAL_POINTS
