"""CRM dashboard: aggregates, user list with lifetime numbers and stage, CSV, tags; shared cookie domain."""
import asyncio
import os
from datetime import timedelta
from pathlib import Path

os.environ.setdefault("DATA_DIR", "/tmp/lk-test-data")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from app import auth as AU  # noqa: E402
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


@pytest.fixture
def client():
    holder = {}
    M.app.dependency_overrides[current_user] = lambda: holder["u"]
    yield TestClient(M.app), holder
    M.app.dependency_overrides.clear()


async def _seed():
    async with D.Session() as s:
        admin = D.User(email="admin@lakeze.com", pw_hash="x", is_admin=True)
        a = D.User(email="paying@x.y", pw_hash="x", provider="google", display_name="Ken", tags="vip,宜蘭")
        b = D.User(email="trial@x.y", pw_hash="x")
        c = D.User(email="idle@x.y", pw_hash="x")
        s.add_all([admin, a, b, c]); await s.commit()
        pa = D.Project(user_id=a.id, name="A1", exports=2, revision_turns=1)
        pb = D.Project(user_id=b.id, name="B1")
        s.add_all([pa, pb]); await s.commit()
        s.add(D.Usage(user_id=a.id, project_id=pa.id, kind="claude_tokens", units=1000, cost_usd=3.0)); await s.commit()
    await D.add_credits(a.id, 110, "grant", "signup")
    await D.add_credits(a.id, 100, "purchase", "test p100", amount_twd=700)
    await D.add_credits(a.id, -64, "charge", "export_video", project_id=pa.id)
    await D.add_credits(a.id, -14, "charge", "probe_footage", project_id=pa.id)
    await D.add_credits(b.id, 110, "grant", "signup")
    await D.add_credits(c.id, 110, "grant", "signup")
    return admin, a, b, c


def test_dashboard_and_users(client):
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())
    holder["u"] = admin
    d = c.get("/api/admin/dashboard?days=30").json()
    t = d["totals"]
    assert t["users"] == 4 and t["paying_users"] == 1 and t["revenue_twd"] == 700 and t["points_used"] == 78 and t["exports"] == 2
    assert t["cost_twd"] == 3 * P.TWD_PER_USD and t["conversion_pct"] == 25.0 and t["points_outstanding"] == 110 + 100 - 78 + 110 + 110
    assert d["period"]["revenue_twd"] == 700 and d["period"]["signups"] == 4 and d["period"]["exports"] == 1  # one export charge row
    assert len(d["daily"]) == 30 and d["daily"][-1]["revenue_twd"] == 700 and d["daily"][-1]["points_used"] == 78
    assert d["tiers"] == {"free": 3, "payg": 1, "sub5": 0, "sub15": 0, "disabled": 0}
    assert [f["n"] for f in d["funnel"]] == [4, 2, 1, 1, 0]
    assert next(x for x in d["by_category"] if x["id"] == "export")["points"] == 64
    assert d["top"][0]["email"] == "paying@x.y" and d["top"][0]["points_used"] == 78
    assert {r["email"] for r in d["recent"]} >= {"idle@x.y", "trial@x.y"}
    # user list
    us = {u["email"]: u for u in c.get("/api/admin/users").json()}
    pa = us["paying@x.y"]
    assert pa["stage"] == "paid" and pa["paid_twd"] == 700 and pa["purchases"] == 1 and pa["purchased_points"] == 100
    assert pa["granted_points"] == 110 and pa["used_points"] == 78 and pa["balance"] == 132 and pa["exports"] == 2 and pa["provider"] == "google"
    assert pa["tags"] == ["vip", "宜蘭"] and pa["cost_twd"] == 96
    assert us["trial@x.y"]["stage"] == "trial" and us["idle@x.y"]["stage"] == "new" and us["admin@lakeze.com"]["stage"] == "new"
    assert [u["email"] for u in c.get("/api/admin/users?q=vip").json()] == ["paying@x.y"]
    # csv
    r = c.get("/api/admin/users.csv")
    assert r.status_code == 200 and "text/csv" in r.headers["content-type"] and "paying@x.y" in r.text and "付費用戶" in r.text
    # detail + tags
    det = c.get(f"/api/admin/users/{a.id}").json()
    assert det["summary"]["paid_twd"] == 700 and det["summary"]["used_points"] == 78 and det["summary"]["profit_twd"] == 700 - 96
    assert det["summary"]["margin_pct"] == round((700 - 96) / 96 * 100) and len(det["daily"]) == 30 and det["projects"][0]["exports"] == 2
    assert c.post(f"/api/admin/users/{a.id}", json={"tags": [" 民宿 ", "vip", ""]}).status_code == 200
    assert c.get(f"/api/admin/users/{a.id}").json()["tags"] == ["vip", "民宿"]
    # non-admin is refused
    holder["u"] = b
    assert c.get("/api/admin/dashboard").status_code == 403


def test_churn_stage():
    async def go():
        admin, a, b, idle = await _seed()
        async with D.Session() as s:
            p = (await s.execute(D.select(D.Project).where(D.Project.user_id == a.id))).scalar_one()
            p.updated_at = D.now() - timedelta(days=45)
            await s.commit()
    asyncio.run(go())
    M.app.dependency_overrides[current_user] = lambda: asyncio.run(_admin())
    try:
        us = {u["email"]: u for u in TestClient(M.app).get("/api/admin/users").json()}
        assert us["paying@x.y"]["stage"] == "churn"
    finally:
        M.app.dependency_overrides.clear()


async def _admin():
    async with D.Session() as s:
        return (await s.execute(D.select(D.User).where(D.User.is_admin))).scalars().first()


def test_cookie_domain_and_next(monkeypatch):
    monkeypatch.setattr(AU.config, "PUBLIC_URL", "https://editor.lakeze.com")
    monkeypatch.setattr(AU.config, "COOKIE_DOMAIN", "")
    assert AU.cookie_domain("editor.lakeze.com") == ".editor.lakeze.com"
    assert AU.cookie_domain("dashboard.editor.lakeze.com:443") == ".editor.lakeze.com"
    assert AU.cookie_domain("localhost:5173") is None and AU.cookie_domain("evil-editor.lakeze.com") is None
    from app import oauth as O
    assert O._safe_next("/dashboard") == "/dashboard"
    assert O._safe_next("https://dashboard.editor.lakeze.com/") == "https://dashboard.editor.lakeze.com/"
    assert O._safe_next("https://evil.com/") == "/" and O._safe_next("//evil.com") == "/" and O._safe_next("") == "/"
    # login sets the domain cookie and logout clears it
    c = TestClient(M.app, base_url="https://dashboard.editor.lakeze.com")
    c.post("/api/auth/signup", json={"email": "d@lakeze.com", "password": "password123"})
    r = c.post("/api/auth/login", json={"email": "d@lakeze.com", "password": "password123"})
    assert r.status_code == 200 and "Domain=.editor.lakeze.com" in r.headers["set-cookie"]
    assert c.get("/api/me").status_code == 200
    r = c.post("/api/auth/logout")
    assert "Domain=.editor.lakeze.com" in r.headers["set-cookie"]
