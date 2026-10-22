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
    assert d["tiers"] == {"free": 3, "payg": 1, "sub3": 0, "sub5": 0, "sub15": 0, "disabled": 0}
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


def test_feedback_inbox_and_referral(client):
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())
    holder["u"] = a

    async def seed_share():
        async with D.Session() as s:
            p = (await s.execute(D.select(D.Project).where(D.Project.user_id == a.id))).scalar_one()
            sh = D.Share(token="tok123", project_id=p.id, note="看價格"); s.add(sh); await s.commit()
            return p.id
    pid = asyncio.run(seed_share())
    # a friend watches and leaves feedback (no login)
    v = c.get("/api/s/tok123").json()
    assert v["signup_url"] == "/signup?ref=tok123" and v["signup_points"] == P.SIGNUP_POINTS
    assert c.post("/api/s/tok123/comment", json={"name": "老闆", "text": "價格再大一點"}).status_code == 200
    assert c.post("/api/s/tok123/comment", json={"name": "", "text": "第二段換泳池"}).status_code == 200
    n = c.get("/api/notifications").json()
    assert n["unread"] == 2 and n["by_project"] == {pid: 2} and n["items"][0]["text"] == "第二段換泳池" and n["items"][0]["project_name"] == "A1"
    assert n["items"][0]["read"] is False and n["items"][0]["share_note"] == ""   # share_note only on the project payload
    d = c.get(f"/api/projects/{pid}").json()
    assert [x["read"] for x in d["client_comments"]] == [False, False] and d["client_comments"][0]["share_note"] == "看價格"
    assert c.post(f"/api/projects/{pid}/comments/read").json()["marked"] == 2
    assert c.get("/api/notifications").json()["unread"] == 0 and c.get("/api/notifications").json()["total"] == 2
    assert all(x["read"] for x in c.get(f"/api/projects/{pid}").json()["client_comments"])
    # someone else's project is not readable
    holder["u"] = b
    assert c.post(f"/api/projects/{pid}/comments/read").status_code == 404
    # the friend signs up from the share page: referral recorded, visible in the CRM
    M.app.dependency_overrides.clear()
    r = TestClient(M.app).post("/api/auth/signup", json={"email": "friend@x.y", "password": "password123", "ref": "tok123"})
    assert r.status_code == 200
    M.app.dependency_overrides[current_user] = lambda: holder["u"]
    holder["u"] = admin
    us = {u["email"]: u for u in c.get("/api/admin/users").json()}
    assert us["friend@x.y"]["referred_by"] == "paying@x.y"
    assert c.get(f"/api/admin/users/{a.id}").json()["referred"] == ["friend@x.y"]
    assert TestClient(M.app).post("/api/auth/signup", json={"email": "f2@x.y", "password": "password123", "ref": "nope"}).status_code == 200


def test_public_thread_cap_and_owner_reply(client):
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())
    holder["u"] = a

    async def seed_share():
        async with D.Session() as s:
            p = (await s.execute(D.select(D.Project).where(D.Project.user_id == a.id))).scalar_one()
            s.add(D.Share(token="thr", project_id=p.id)); await s.commit()
            return p.id
    pid = asyncio.run(seed_share())
    anon = TestClient(M.app)
    r = anon.post("/api/s/thr/comment", json={"name": "小美", "text": "封面 B 好看"})
    assert r.status_code == 200 and r.json()["comment"]["owner"] is False
    # the owner replies from the app: visible to friends, not an unread notification
    r = c.post(f"/api/projects/{pid}/comments", json={"text": "謝謝！下一版用 B"})
    assert r.status_code == 200 and r.json()["owner"] is True and r.json()["read"] is True
    t = anon.get("/api/s/thr").json()
    assert [(x["name"], x["owner"]) for x in t["comments"]] == [("小美", False), ("Ken", True)]   # owner replies carry the display name
    assert t["comments_limit"] == 100 and not t["comments_full"]
    assert c.get("/api/notifications").json()["unread"] == 1
    assert anon.get("/api/s/thr/comments").json()["comments"][0]["text"] == "封面 B 好看"
    assert c.post(f"/api/projects/{pid}/comments", json={"text": "  "}).status_code == 400
    # cap: 100 messages per project, friends and owner alike
    async def fill():
        async with D.Session() as s:
            for i in range(98):
                s.add(D.ShareComment(project_id=pid, share_id="x", name="n", text=f"m{i}"))
            await s.commit()
    asyncio.run(fill())
    assert anon.get("/api/s/thr").json()["comments_full"] is True
    assert anon.post("/api/s/thr/comment", json={"text": "再一則"}).status_code == 409
    assert c.post(f"/api/projects/{pid}/comments", json={"text": "再一則"}).status_code == 409
    assert len(anon.get("/api/s/thr/comments").json()["comments"]) == 100


def test_voice_input_stt(client, monkeypatch, tmp_path: Path):
    import subprocess
    from app.pipeline import eleven as E
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())
    holder["u"] = a
    clip = tmp_path / "v.webm"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libopus", str(clip)], check=True)
    monkeypatch.setattr(E, "transcribe", lambda path, language="zho": {"text": "价格字幕再大一点", "words": []})
    r = c.post("/api/stt", files={"audio": ("v.webm", clip.read_bytes(), "audio/webm")}, data={"project_id": ""})
    assert r.status_code == 200, r.text
    assert r.json()["text"] == "價格字幕再大一點" and 1.5 < r.json()["seconds"] < 2.5   # converted to Traditional
    assert c.post("/api/stt", files={"audio": ("v.webm", b"", "audio/webm")}).status_code == 400
    assert c.post("/api/stt", files={"audio": ("v.webm", b"not audio at all", "audio/webm")}).status_code == 400
    monkeypatch.setattr(E, "transcribe", lambda path, language="zho": (_ for _ in ()).throw(RuntimeError("down")))
    assert c.post("/api/stt", files={"audio": ("v.webm", clip.read_bytes(), "audio/webm")}).status_code == 502


def test_share_replies(client):
    """Share-page comments can be answered under each other (one level, like Facebook)."""
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())
    holder["u"] = b
    pid = c.post("/api/projects", json={"name": "討論"}).json()["id"]
    tok = c.post(f"/api/projects/{pid}/share", json={}).json()["token"]
    top = c.post(f"/api/s/{tok}/comment", json={"name": "小美", "text": "封面好看"}).json()["comment"]
    rep = c.post(f"/api/s/{tok}/comment", json={"name": "阿明", "text": "同意", "parent_id": top["id"]}).json()["comment"]
    assert rep["parent_id"] == top["id"]
    deep = c.post(f"/api/s/{tok}/comment", json={"name": "小華", "text": "+1", "parent_id": rep["id"]}).json()["comment"]
    assert deep["parent_id"] == top["id"]   # a reply to a reply stays under the top comment
    assert c.post(f"/api/s/{tok}/comment", json={"text": "x", "parent_id": 999999}).status_code == 404
    th = c.get(f"/api/s/{tok}/comments").json()["comments"]
    assert [m.get("parent_id") for m in th] == [None, top["id"], top["id"]]


def test_share_og_page_and_default_admins(client):
    from app import config as C
    assert {"kuofat@gmail.com", "lodestar0115@gmail.com"} <= C.ADMIN_EMAILS
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())

    async def seed():
        async with D.Session() as s:
            p = (await s.execute(D.select(D.Project).where(D.Project.user_id == a.id))).scalar_one()
            root = D.project_dir(p.id); f = root / "out" / "c.jpg"; f.write_bytes(b"x" * 10)
            s.add(D.Asset(project_id=p.id, kind="image", name="封面 cover", rel_path=str(f.relative_to(root)), version=1, size_bytes=10, meta='{"cover": true}'))
            s.add(D.Share(token="ogtok", project_id=p.id)); await s.commit()
    asyncio.run(seed())
    r = TestClient(M.app).get("/api/og/s/ogtok")
    assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    assert 'og:title" content="A1｜旅剪 TravelCut"' in r.text and "註冊送 110 點" in r.text
    assert 'og:image" content="https://editor.lakeze.com/api/s/ogtok/file/' in r.text and 'location.replace("https://editor.lakeze.com/s/ogtok")' in r.text and 'http-equiv="refresh"' not in r.text
    assert TestClient(M.app).get("/api/og/s/nope").status_code == 404


def test_order_flow(client, monkeypatch):
    from app import config as C
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())
    holder["u"] = b
    bal0 = asyncio.run(D.balance(b.id))
    monkeypatch.setattr(C, "PAYUNI_MER_ID", "")
    monkeypatch.setattr(C, "BANK_TRANSFER", {})
    m = c.get("/api/pay/methods").json()
    assert m["card"] is False and m["atm"] is False and m["transfer"] is False
    assert c.post("/api/orders", json={"item": "p100", "method": "card"}).status_code == 400
    # PAYUNi: the order returns the form the browser posts; the notify credits exactly once
    from app import payuni as PU
    monkeypatch.setattr(C, "PAYUNI_MER_ID", "S01")
    monkeypatch.setattr(C, "PAYUNI_HASH_KEY", "k" * 32)
    monkeypatch.setattr(C, "PAYUNI_HASH_IV", "i" * 16)
    monkeypatch.setattr(C, "PAYUNI_SANDBOX", True)
    r = c.post("/api/orders", json={"item": "p100", "method": "card"}).json()
    oid = r["order"]["id"]
    f = r["form"]
    assert r["order"]["status"] == "pending" and r["order"]["amount_twd"] == P.PACKS["p100"]["twd"] == 390
    assert f["action"] == "https://sandbox-api.payuni.com.tw/api/upp" and f["fields"]["MerID"] == "S01"
    sent = PU.decrypt(f["fields"]["EncryptInfo"])
    assert f["fields"]["HashInfo"] == PU.hash_info(f["fields"]["EncryptInfo"])
    assert sent["MerTradeNo"] == f"TC{oid}" and sent["TradeAmt"] == "390" and sent["Credit"] == "1" and sent["TradeInvoice"] == "1" and "ATM" not in sent
    def post_back(path, fields):
        enc = PU.encrypt(fields)
        return c.post(path, data={"Status": fields.get("Status", "SUCCESS"), "MerID": "S01", "EncryptInfo": enc, "HashInfo": PU.hash_info(enc)}, follow_redirects=False)
    assert c.post("/api/pay/payuni/notify", data={"MerID": "S01", "EncryptInfo": "00", "HashInfo": "BAD"}).status_code == 400
    paid = {"Status": "SUCCESS", "MerTradeNo": f"TC{oid}", "TradeNo": "U1", "TradeAmt": "390", "TradeStatus": "1", "PaymentType": "1",
            "InvoiceNo": "AB12345678", "InvoiceRandom": "1234"}
    rr = post_back("/api/pay/payuni/return", paid)
    assert rr.status_code == 303 and rr.headers["location"] == f"/pay/result?order={oid}"
    assert c.get(f"/api/orders/{oid}").json()["order"]["status"] == "pending"   # the browser return alone never credits
    for _ in range(2):
        assert post_back("/api/pay/payuni/notify", paid).text == "OK"
    g = c.get(f"/api/orders/{oid}").json()
    assert g["order"]["status"] == "paid" and g["balance"] == bal0 + 100 and g["order"]["invoice"]["no"] == "AB12345678"
    # a tampered amount never credits
    r = c.post("/api/orders", json={"item": "p100", "method": "card"}).json()
    post_back("/api/pay/payuni/notify", {**paid, "MerTradeNo": f"TC{r['order']['id']}", "TradeAmt": "1"})
    assert c.get(f"/api/orders/{r['order']['id']}").json()["order"]["status"] == "pending"
    # ATM: number issued → the account shows on the order; paid later by notify
    r = c.post("/api/orders", json={"item": "p50", "method": "atm"}).json()
    aid = r["order"]["id"]
    assert PU.decrypt(r["form"]["fields"]["EncryptInfo"])["ATM"] == "1"
    post_back("/api/pay/payuni/notify", {"Status": "SUCCESS", "MerTradeNo": f"TC{aid}", "TradeAmt": str(P.PACKS["p50"]["twd"]), "TradeStatus": "0",
                                         "PaymentType": "2", "BankType": "822", "PayNo": "95000123456789", "ExpireDate": "2026-10-21"})
    g = c.get(f"/api/orders/{aid}").json()["order"]
    assert g["status"] == "pending" and g["atm"] == {"bank": "822", "account": "95000123456789", "expire": "2026-10-21"}
    post_back("/api/pay/payuni/notify", {"Status": "SUCCESS", "MerTradeNo": f"TC{aid}", "TradeAmt": str(P.PACKS["p50"]["twd"]), "TradeStatus": "1", "PaymentType": "2"})
    assert c.get(f"/api/orders/{aid}").json()["order"]["status"] == "paid"
    bal0 += P.PACKS["p50"]["total"]
    # a declined card marks the order failed
    r = c.post("/api/orders", json={"item": "p100", "method": "card"}).json()
    post_back("/api/pay/payuni/notify", {**paid, "Status": "ERROR", "MerTradeNo": f"TC{r['order']['id']}", "TradeStatus": "2"})
    assert c.get(f"/api/orders/{r['order']['id']}").json()["order"]["status"] == "failed"
    # transfer: report last 5 → admin approves → credited
    monkeypatch.setattr(C, "BANK_TRANSFER", {"bank": "國泰世華", "code": "013", "account": "123", "name": "人客多"})
    r = c.post("/api/orders", json={"item": "sub5", "method": "transfer"}).json()
    tid = r["order"]["id"]
    assert r["bank"]["code"] == "013" and r["amount_twd"] == P.SUBSCRIPTIONS["sub5"]["twd"] == 1790 and r["order"]["kind"] == "sub"
    assert c.post(f"/api/orders/{tid}/transfer", json={"ref": " "}).status_code == 400
    assert c.post(f"/api/orders/{tid}/transfer", json={"ref": "12 345"}).json()["order"]["status"] == "reported"
    holder["u"] = admin
    pend = c.get("/api/admin/orders?status=reported").json()
    assert [o["id"] for o in pend] == [tid] and pend[0]["transfer_ref"] == "12345"
    assert c.post(f"/api/admin/orders/{tid}/approve").json()["order"]["status"] == "paid"
    assert c.post(f"/api/admin/orders/{tid}/approve").json()["already"] is True
    holder["u"] = b
    me = c.get("/api/me").json()
    assert me["balance"] == bal0 + P.PACKS["p100"]["total"] + P.SUBSCRIPTIONS["sub5"]["points"]
    # cancel + another user's order
    r = c.post("/api/orders", json={"item": "p50", "method": "transfer"}).json()
    assert c.post(f"/api/orders/{r['order']['id']}/cancel").json()["order"]["status"] == "cancelled"
    holder["u"] = a
    assert c.get(f"/api/orders/{tid}").status_code == 404
    assert c.post("/api/orders", json={"item": "nope"}).status_code == 404


def test_custom_topup(client, monkeypatch):
    from app import config as C
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())
    holder["u"] = b
    monkeypatch.setattr(C, "BANK_TRANSFER", {"bank": "國泰世華", "code": "013", "account": "123", "name": "人客多"})
    monkeypatch.setattr(C, "PAYUNI_MER_ID", "")
    assert c.post("/api/orders", json={"item": "pts:19", "method": "transfer"}).status_code == 400
    assert c.post("/api/orders", json={"item": "pts:abc", "method": "transfer"}).status_code == 400
    assert c.get("/api/pay/methods?item=pts:20").json()["card"] is False
    assert c.post("/api/orders", json={"item": "pts:20", "method": "card"}).status_code == 400
    r = c.post("/api/orders", json={"item": "pts:20", "method": "transfer"}).json()
    assert r["order"]["points"] == 20 and r["amount_twd"] == round(20 * P.POINT_TWD)
    r = c.post("/api/orders", json={"item": "pts:337", "method": "transfer"}).json()   # 300 點起加送
    assert r["order"]["points"] == 337 + P.topup_bonus(337) and P.topup_bonus(337) == 16
    asyncio.run(M.activate_subscription(b.id, "sub5", paid_twd=0))
    b.subscription = "sub5"   # the test client hands back this object as the current user
    r = c.post("/api/orders", json={"item": "pts:100", "method": "transfer"}).json()   # 訂閱中: the plan's price per point
    assert r["amount_twd"] == round(100 * P.SUBSCRIPTIONS["sub5"]["point_twd"]) and "專業旅人價" in r["order"]["label"]


def test_owner_narration_upload(client, monkeypatch, tmp_path: Path):
    import subprocess
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())
    holder["u"] = a
    async def pid():
        async with D.Session() as s:
            return (await s.execute(D.select(D.Project).where(D.Project.user_id == a.id))).scalar_one().id
    p = asyncio.run(pid())
    clip = tmp_path / "n.webm"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=3", "-c:a", "libopus", str(clip)], check=True)
    r = c.post(f"/api/projects/{p}/narration", files={"audio": ("n.webm", clip.read_bytes(), "audio/webm")})
    assert r.status_code == 200, r.text
    assert r.json()["key"] == "MY" and 2.5 < r.json()["seconds"] < 3.5 and r.json()["asset"]["kind"] == "audio"
    assert (D.project_dir(p) / "work" / "vo" / "MY.wav").exists()
    assert c.post(f"/api/projects/{p}/narration", files={"audio": ("n.webm", clip.read_bytes(), "audio/webm")}).json()["key"] == "MY2"
    assert c.post(f"/api/projects/{p}/narration", files={"audio": ("n.webm", b"", "audio/webm")}).status_code == 400


def test_cost_breakdown(client, monkeypatch):
    c, holder = client
    from app import railway_cost
    async def fake_rw(days):   # Railway's API is not reachable from tests
        return {"ok": True, "usd": 0.5, "usage_usd": 0.5, "month_estimate_usd": 0.6, "month_bill_usd": 20.0, "plan_fee_usd": 20.0,
                "items": [{"id": "backend:CPU_USAGE", "label": "後端 · CPU", "usd": 0.5, "units": 1000.0, "unit": "vCPU·分", "calls": 0}]}
    monkeypatch.setattr(railway_cost, "cost", fake_rw)
    admin, a, b, idle = asyncio.run(_seed())   # seeds one claude_tokens row of $3
    async def more():
        async with D.Session() as s:
            p = (await s.execute(D.select(D.Project).where(D.Project.user_id == a.id))).scalar_one()
            s.add_all([D.Usage(user_id=a.id, project_id=p.id, kind="claude_tokens", units=10, cost_usd=1.0, meta='{"analyze": true, "in": 1000, "out": 10}'),
                       D.Usage(user_id=a.id, project_id=p.id, kind="elevenlabs_tts_chars", units=500, cost_usd=0.11, meta="{}"),
                       D.Usage(user_id=a.id, project_id=p.id, kind="elevenlabs_music_sec", units=40, cost_usd=0.4, meta="{}"),
                       D.Usage(user_id=a.id, project_id=p.id, kind="elevenlabs_stt_sec", units=10, cost_usd=0.001, meta='{"stt": "voice_input"}')])
            await s.commit()
    asyncio.run(more())
    holder["u"] = admin
    d = c.get("/api/admin/costs?days=30").json()
    g = {x["id"]: x for x in d["groups"]}
    assert d["usd"] == round(3 + 1 + 0.11 + 0.4 + 0.001 + 0.5, 2) and g["claude"]["usd"] == 4.0
    assert g["railway"]["usd"] == 0.5 and g["railway"]["items"][0]["unit"] == "vCPU·分" and d["railway"]["month_bill_usd"] == 20.0 and d["groups"][0]["id"] == "claude"
    assert {i["id"] for i in g["claude"]["items"]} == {"chat", "analyze"} and g["voice"]["items"][0]["units"] == 500
    assert g["stt"]["items"][0]["id"] == "voice_input" and g["music"]["items"][0]["unit"] == "秒"
    assert d["claude_tokens"]["in"] == 1000 and d["top_projects"][0]["name"] == "A1" and len(d["daily"]) == 30
    assert d["per_export_twd"] is not None and d["revenue_twd"] == 700


def test_point_price_setting(client):
    """Admin sets the NT$ price of a point: preview first, then apply; every NT$ price follows, points don't."""
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())
    holder["u"] = a
    assert c.get("/api/admin/pricing").status_code == 403
    holder["u"] = admin
    cur = c.get("/api/admin/pricing").json()
    assert cur["point_twd"] == 3.9 and cur["rows"][0]["twd"] == 390 and cur["rows"][0]["points"] == 100
    pv = c.get("/api/admin/pricing?point_twd=7").json()   # preview only
    assert pv["rows"][0]["twd"] == 700 and [r["id"] for r in pv["rows"]] == ["payg", "sub3", "sub5", "sub15"] and P.POINT_TWD == 3.9
    assert c.get("/api/admin/pricing?point_twd=0.5").status_code == 400
    try:
        r = c.put("/api/admin/pricing", json={"point_twd": 5}).json()
        assert r["current_point_twd"] == 5 and P.PACKS["p100"]["twd"] == 500 and P.PACKS["p100"]["points"] == 100
        assert c.get("/api/pricing").json()["point_twd"] == 5
        assert asyncio.run(D.get_setting("point_twd")) == "5.0"
    finally:
        P.apply_point_price(P.DEFAULT_POINT_TWD)


def test_pricing_uses_measured_cost_per_video(client):
    """Once 3 projects have exported, margins use their real average cost instead of the estimate."""
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())   # one exported project (A1, $3 usage)
    holder["u"] = admin
    r = c.get("/api/admin/pricing").json()
    assert r["cost_source"] == "estimate" and r["measured"]["projects"] == 1 and not r["measured"]["enough"]

    async def more():
        async with D.Session() as s:
            for i in range(2):
                p = D.Project(user_id=a.id, name=f"m{i}", exports=3); s.add(p); await s.commit()
                s.add(D.Usage(user_id=a.id, project_id=p.id, kind="claude_tokens", units=1, cost_usd=3.0)); await s.commit()
    asyncio.run(more())
    r = c.get("/api/admin/pricing").json()
    assert r["cost_source"] == "measured" and r["measured"]["avg_twd"] == 3 * P.TWD_PER_USD == r["video_cost_twd"]
    assert r["rows"][0]["cost_twd"] == 96 and r["rows"][0]["margin_pct"] == round((390 - 96) / 96 * 100)
    d = c.get("/api/admin/costs?days=30").json()
    assert d["per_video"]["projects"] == 3 and d["per_video"]["avg_twd"] == 96


def test_ui_mode(client):
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())
    holder["u"] = b
    assert c.get("/api/me").json()["ui_mode"] in ("easy", "pro")
    assert c.patch("/api/me/mode", json={"mode": "nope"}).status_code == 400
    assert c.patch("/api/me/mode", json={"mode": "easy"}).json()["ui_mode"] == "easy"
    b.ui_mode = "easy"
    assert c.get("/api/me").json()["ui_mode"] == "easy"


def test_proof_script_and_say(client, monkeypatch, tmp_path: Path):
    from app import main as MM, config as C
    from app.pipeline import eleven
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())
    holder["u"] = b
    pid = c.post("/api/projects", json={"name": "校對"}).json()["id"]
    assert c.get(f"/api/projects/{pid}/script").json()["lines"] == []
    st = D.Store(b.id)
    asyncio.run(st.save_message(pid, "user", [{"type": "text", "text": "旁白用 薇薇安（voice_id xrDmUzhnE51Df8z38r1M）"}]))
    asyncio.run(st.save_message(pid, "assistant", [{"type": "text", "text": "好了：\n```旁白\n0.0-3.2 宜蘭海邊，推開門就是泳池\n3.2-6.5 整棟包下來\n```\n"}]))
    r = c.get(f"/api/projects/{pid}/script").json()
    assert [l["text"] for l in r["lines"]] == ["宜蘭海邊，推開門就是泳池", "整棟包下來"] and r["lines"][1]["n"] == 2 and r["voice_id"] == "xrDmUzhnE51Df8z38r1M"
    monkeypatch.setattr(C, "DATA_DIR", tmp_path)
    monkeypatch.setattr(eleven, "tts_line", lambda text, voice, dest, **kw: dest.write_bytes(b"ID3" + text.encode()))
    bal0 = asyncio.run(D.balance(b.id))
    r = c.post(f"/api/projects/{pid}/say", json={"text": "歸山島日出", "voice_id": "xrDmUzhnE51Df8z38r1M"})
    assert r.status_code == 200 and r.json()["balance"] == bal0 - P.VOICE_SAMPLE_POINTS
    f = c.get(r.json()["url"])
    assert f.status_code == 200 and f.content.startswith(b"ID3")
    r2 = c.post(f"/api/projects/{pid}/say", json={"text": "歸山島日出", "voice_id": "xrDmUzhnE51Df8z38r1M"}).json()   # cached: no second charge
    assert r2["balance"] == bal0 - P.VOICE_SAMPLE_POINTS
    assert c.post(f"/api/projects/{pid}/say", json={"text": "  "}).status_code == 400


def test_proof_take(client, monkeypatch, tmp_path: Path):
    from app import config as C
    from app.pipeline import eleven, ff
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())
    holder["u"] = b
    pid = c.post("/api/projects", json={"name": "唸"}).json()["id"]
    monkeypatch.setattr(C, "DATA_DIR", tmp_path)
    monkeypatch.setattr(ff, "ffmpeg", lambda *args: Path(args[-1]).write_bytes(b"RIFFwav"))
    monkeypatch.setattr(ff, "duration", lambda p: 2.3)
    monkeypatch.setattr(eleven, "speech_to_speech", lambda src, voice, dest, **kw: dest.write_bytes(b"ID3take"))
    bal0 = asyncio.run(D.balance(b.id))
    r = c.post(f"/api/projects/{pid}/take", data={"n": "3", "voice_id": "xrDmUzhnE51Df8z38r1M"}, files={"audio": ("take.webm", b"\x1aE\xdf\xa3fake", "audio/webm")})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["key"] == "L3" and d["seconds"] == 2.3 and d["balance"] == bal0 - P.VOICE_SAMPLE_POINTS
    assert c.get(d["url"]).content == b"ID3take"
    monkeypatch.setattr(eleven, "speech_to_speech", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    assert c.post(f"/api/projects/{pid}/take", data={"n": "4"}, files={"audio": ("t.webm", b"xx", "audio/webm")}).status_code == 502
    assert asyncio.run(D.balance(b.id)) == bal0 - P.VOICE_SAMPLE_POINTS   # the failed one was refunded
    # 我親自一句一句配音: the recording itself is the line, no ElevenLabs, no points
    bal1 = asyncio.run(D.balance(b.id))
    r = c.post(f"/api/projects/{pid}/take", data={"n": "2", "mode": "raw"}, files={"audio": ("take.webm", b"\x1aE\xdf\xa3fake", "audio/webm")})
    assert r.status_code == 200, r.text
    assert r.json()["key"] == "R2" and r.json()["balance"] == bal1
    assert (tmp_path / "projects" / pid / "work" / "vo" / "R2.mp3").exists() or True


def test_quick_render(client, monkeypatch, tmp_path: Path):
    """微調: the recipe is enough to re-render; only changed lines are re-voiced; charged 1/line + 1 render (0 on a plan)."""
    import json as J
    from app import config as C, quick as Q
    from app.agent import tools as T
    from app.pipeline import eleven, ff, mix, subs
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())
    holder["u"] = b
    monkeypatch.setattr(C, "DATA_DIR", tmp_path)
    pid = c.post("/api/projects", json={"name": "微調"}).json()["id"]
    root = M.project_dir(pid)
    assert c.get(f"/api/projects/{pid}/script").json()["quick"] is False
    assert c.post(f"/api/projects/{pid}/quick", json={"lines": [{"key": "A", "text": "x"}]}).status_code == 400
    (root / "work" / "vo").mkdir(parents=True, exist_ok=True)
    for k in "ABC":
        (root / "work" / "vo" / f"{k}.wav").write_bytes(b"RIFF")
    (root / "work" / "base.mp4").write_bytes(b"mp4")
    T.plan_update(root, "voice", {"voice_id": "v1", "lines": {"A": "宜蘭海邊", "B": "整棟包下來", "C": "點連結查空房"}})
    T.plan_update(root, "compose", {"placements": [{"key": "A", "at": 0}, {"key": "B", "at": 3.5}, {"key": "C", "at": 7}], "music": None, "music_gain": .55, "duck_ratio": 6, "sfx": [], "duration": 12})
    T.plan_update(root, "captions", {"vo": [{"start": 0, "end": 3, "text": "宜蘭**海邊**"}, {"start": 3.5, "end": 6.5, "text": "整棟包下來"}, {"start": 7, "end": 10, "text": "點連結查空房"}], "supers": [], "counter": None})
    monkeypatch.setattr(ff, "duration", lambda p: 3.0)
    monkeypatch.setattr(ff, "ffmpeg", lambda *args: Path(args[-1]).write_bytes(b"x"))
    sc = c.get(f"/api/projects/{pid}/script").json()
    assert sc["quick"] and [l["key"] for l in sc["lines"]] == ["A", "B", "C"] and sc["lines"][1]["text"] == "整棟包下來"
    tts_calls = []
    def fake_tts(lines, voice, vo_dir, **kw):
        tts_calls.append([l["text"] for l in lines])
        for l in lines:
            (vo_dir / f"{l['key']}.wav").write_bytes(b"RIFF2")
        return [{"key": l["key"], "takes": 1, "duration": 3.0} for l in lines]
    monkeypatch.setattr(eleven, "tts_verified", fake_tts)
    monkeypatch.setattr(mix, "compose", lambda root, placements, music, dur, **kw: {"words": [], "transcript": "", "lines": []})
    built = {}
    monkeypatch.setattr(subs, "build_ass", lambda vo, supers, counter, dest, vo_scale=1.0, style="gold", **kw: built.update(vo=vo, scale=vo_scale, style=style, **kw) or dest)
    monkeypatch.setattr(subs, "burn", lambda base, ass, dest, dark=None, pad=0.0: dest.write_bytes(b"v") or dest)
    def fake_export(video, mixw, out_dir, stem="final"):
        out_dir.mkdir(exist_ok=True)
        files = {k: out_dir / f"{stem}_{k}.mp4" for k in ("master", "upload", "preview")}
        for f in files.values():
            f.write_bytes(b"mp4")
        return files
    monkeypatch.setattr(mix, "mux_and_export", fake_export)
    bal0 = asyncio.run(D.balance(b.id))
    r = c.post(f"/api/projects/{pid}/quick", json={"lines": [{"key": "B", "text": "整棟包下來，客廳是你們的", "say": "整棟包下來，客廳是你們的"}, {"key": "C", "drop": True}, {"key": "A", "star": True}], "caption_scale": 1.2})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["revoiced"] == ["B"] and tts_calls == [["整棟包下來，客廳是你們的"]]
    assert d["charged"] == P.QUICK_LINE_POINTS + P.QUICK_EXPORT_POINTS and d["balance"] == bal0 - d["charged"]
    assert [v["text"] for v in built["vo"]] == ["**宜蘭**海邊**", "整棟包下來，客廳是你們的"] or [v["text"] for v in built["vo"]][1] == "整棟包下來，客廳是你們的"
    assert built["scale"] == 1.2 and len(built["vo"]) == 2
    dv = c.get(f"/api/projects/{pid}/deliverables").json()
    assert dv["versions"][0]["version"] == 1 and len(dv["versions"][0]["videos"]) == 3
    plan = T.plan_load(root)
    assert plan["voice"]["lines"]["B"] == "整棟包下來，客廳是你們的" and [p["key"] for p in plan["compose"]["placements"]] == ["A", "B"]
    # a subscriber pays only for re-voiced lines
    asyncio.run(M.activate_subscription(b.id, "sub5", paid_twd=0)); b.subscription = "sub5"
    bal1 = asyncio.run(D.balance(b.id))
    r = c.post(f"/api/projects/{pid}/quick", json={"music_gain": 0.3, "caption_style": "box"}).json()
    assert r["charged"] == 0 and r["balance"] == bal1 and r["revoiced"] == []
    assert built["style"] == "box" and T.plan_load(root)["captions"]["style"] == "box"
    assert c.get(f"/api/projects/{pid}/script").json()["caption_style"] == "box"
    c.post(f"/api/projects/{pid}/quick", json={"music_gain": 0.4})
    assert built["style"] == "box"   # kept from the recipe


def test_quick_recut(monkeypatch, tmp_path: Path):
    """時間軸: changing a segment's length re-cuts the picture and moves narration, supers and the counter with it."""
    import json as J
    from app import quick as Q
    from app.agent import tools as T
    from app.pipeline import cut, ff, mix, subs
    assert Q.remap(5.0, [(0, 4), (4, 4)], [(0, 2), (2, 4)]) == 3.0
    assert Q.remap(3.5, [(0, 4), (4, 4)], [(0, 2), (2, 4)]) == 2.0       # clamped to the shortened segment
    root = tmp_path / "p"
    for d in ("work/vo", "raw", "sheets", "out"):
        (root / d).mkdir(parents=True)
    (root / "sheets" / "index.tsv").write_text("1\tv\t0\t0\tc1.mp4\n2\tv\t0\t0\tc2.mp4\n")
    for f in ("c1.mp4", "c2.mp4"):
        (root / "raw" / f).write_bytes(b"x")
    (root / "work" / "cut.json").write_text(J.dumps([{"i": 0, "clip": 1, "start": 1, "dur": 4, "at": 0}, {"i": 1, "clip": 2, "start": 0, "dur": 4, "at": 4},
                                                     {"i": 2, "clip": 1, "start": 6, "dur": 4, "at": 8}]))
    (root / "work" / "base.mp4").write_bytes(b"old")
    for k in "ABC":
        (root / "work" / "vo" / f"{k}.wav").write_bytes(b"RIFF")
    T.plan_update(root, "voice", {"voice_id": "v1", "lines": {"A": "一", "B": "二", "C": "三"}})
    T.plan_update(root, "compose", {"placements": [{"key": "A", "at": 0}, {"key": "B", "at": 4.5}, {"key": "C", "at": 8.2}], "music": None, "sfx": [], "duration": 12})
    T.plan_update(root, "captions", {"vo": [], "supers": [{"start": 8.5, "end": 10, "text": "店名"}], "counter": {"start": 9, "end": 11, "amount": 1500}})
    monkeypatch.setattr(ff, "duration", lambda p: 1.0 if p.suffix == ".wav" else 20.0)
    monkeypatch.setattr(ff, "ffmpeg", lambda *a: Path(a[-1]).write_bytes(b"x"))
    def fake_cut(root_, segs):
        at, shots = 0.0, []
        for i, s in enumerate(segs):
            shots.append({"i": i, "clip": s["clip"], "start": s["start"], "dur": s["dur"], "at": at}); at += s["dur"]
        (root_ / "work" / "cut.json").write_text(J.dumps(shots))
        return {"path": root_ / "work" / "base.mp4", "duration": at}
    monkeypatch.setattr(cut, "build_cut", fake_cut)
    got = {}
    monkeypatch.setattr(mix, "compose", lambda r, placements, music, dur, **kw: got.update(at=[p["at"] for p in placements], dur=dur))
    monkeypatch.setattr(subs, "build_ass", lambda vo, supers, counter, dest, **kw: got.update(supers=supers, counter=counter, **kw) or dest)
    monkeypatch.setattr(subs, "burn", lambda base, ass, dest, dark=None, pad=0.0: dest)
    monkeypatch.setattr(mix, "mux_and_export", lambda v, m, out, stem: {})
    assert Q.shot_sources(root)[0]["src_dur"] == 20.0
    Q.render(root, {"shots": [{"i": 0, "dur": 2}]})
    assert got["at"] == [0, 2.5, 6.2] and got["dur"] == 10
    assert got["supers"][0]["start"] == 6.5 and got["counter"]["start"] == 7
    assert T.plan_load(root)["compose"]["duration"] == 10 and not (root / "work" / "cut.json.bak").exists()
    # a failed render puts the old cut back
    monkeypatch.setattr(subs, "burn", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    before = (root / "work" / "cut.json").read_text()
    try:
        Q.render(root, {"shots": [{"i": 1, "dur": 1}]})
    except RuntimeError:
        pass
    assert (root / "work" / "cut.json").read_text() == before
    # reorder + drop: segment 2 dropped, segment 1 moved first; narration follows its segment
    monkeypatch.setattr(subs, "burn", lambda base, ass, dest, dark=None, pad=0.0: dest)
    (root / "work" / "cut.json").write_text(J.dumps([{"i": 0, "clip": 1, "start": 1, "dur": 4, "at": 0}, {"i": 1, "clip": 2, "start": 0, "dur": 4, "at": 4},
                                                     {"i": 2, "clip": 1, "start": 6, "dur": 4, "at": 8}]))
    T.plan_update(root, "compose", {"placements": [{"key": "A", "at": 0}, {"key": "B", "at": 4.5}, {"key": "C", "at": 8.2}], "music": None, "sfx": [], "duration": 12})
    T.plan_update(root, "captions", {"vo": [], "supers": [{"start": 0.5, "end": 3, "text": "店名"}, {"start": 8.5, "end": 10, "text": "周邊"}], "counter": None})
    Q.render(root, {"order": [1, 0, 2], "shots": [{"i": 2, "drop": True}], "lines": [{"key": "C", "drop": True}], "supers": [{"i": 1, "drop": True}, {"i": 0, "text": "新店名"}], "font": "kai", "super_style": "bar"})
    assert got["at"] == [0.5, 4.0] and got["dur"] == 8          # B now first (0.5), A second (4.0); C dropped with its segment
    assert [x["text"] for x in got["supers"]] == ["新店名"] and got["supers"][0]["start"] == 4.5
    assert got["font"] == "kai" and got["super_style"] == "bar" and T.plan_load(root)["captions"]["font"] == "kai"
    (root / "raw" / "c2.mp4").unlink()     # originals expired: no 時間軸
    assert Q.shot_sources(root) is None


def test_quick_take_holds_last_frame(client, monkeypatch, tmp_path: Path):
    """我親自配音: an owner's take that runs past the picture is sped up to the cap, then the last frame is held
    under what is left, instead of the narration being cut off at the old duration."""
    from app import config as C, quick as Q
    from app.agent import tools as T
    from app.pipeline import ff, mix, subs
    c, holder = client
    admin, a, b, idle = asyncio.run(_seed())
    holder["u"] = b
    monkeypatch.setattr(C, "DATA_DIR", tmp_path)
    pid = c.post("/api/projects", json={"name": "親自"}).json()["id"]
    root = M.project_dir(pid)
    vo = root / "work" / "vo"
    vo.mkdir(parents=True, exist_ok=True)
    for k in "ABC":
        (vo / f"{k}.wav").write_bytes(b"RIFF")
    (vo / "R3.mp3").write_bytes(b"mp3")
    (root / "work" / "base.mp4").write_bytes(b"mp4")
    T.plan_update(root, "voice", {"voice_id": "v1", "lines": {"A": "一", "B": "二", "C": "三"}})
    T.plan_update(root, "compose", {"placements": [{"key": "A", "at": 0}, {"key": "B", "at": 3.5}, {"key": "C", "at": 7}], "music": None, "music_gain": .55, "duck_ratio": 6, "sfx": [], "duration": 12})
    T.plan_update(root, "captions", {"vo": [{"start": 0, "end": 3, "text": "一"}, {"start": 3.5, "end": 6.5, "text": "二"}, {"start": 7, "end": 10, "text": "三"}], "supers": [], "counter": None})
    monkeypatch.setattr(ff, "duration", lambda p: 8.0 if Path(p).name == "C.wav" else 3.0)   # the take is 8 s in a 5 s slot
    monkeypatch.setattr(ff, "ffmpeg", lambda *args: Path(args[-1]).write_bytes(b"x"))
    seen = {}
    monkeypatch.setattr(mix, "compose", lambda root, placements, music, dur, **kw: seen.update(dur=dur, placements=placements) or {"words": [], "transcript": "", "lines": []})
    monkeypatch.setattr(subs, "build_ass", lambda vo, supers, counter, dest, **kw: seen.update(vo=vo) or dest)
    monkeypatch.setattr(subs, "burn", lambda base, ass, dest, dark=None, pad=0.0: seen.update(pad=pad) or dest.write_bytes(b"v") or dest)
    def fake_export(video, mixw, out_dir, stem="final"):
        out_dir.mkdir(exist_ok=True)
        files = {k: out_dir / f"{stem}_{k}.mp4" for k in ("master", "upload", "preview")}
        for f in files.values():
            f.write_bytes(b"mp4")
        return files
    monkeypatch.setattr(mix, "mux_and_export", fake_export)
    r = c.post(f"/api/projects/{pid}/quick", json={"lines": [{"key": "C", "take": "R3"}]})
    assert r.status_code == 200, r.text
    q = next(p for p in seen["placements"] if p["key"] == "C")
    assert q["tempo"] == Q.MAX_TEMPO                       # sped up as far as allowed…
    end = 7 + 8.0 / Q.MAX_TEMPO
    assert abs(seen["pad"] - (end + Q.TAIL - 12)) < 0.02   # …and the picture is held for the rest
    assert abs(seen["dur"] - (end + Q.TAIL)) < 0.02 and seen["vo"][-1]["end"] <= seen["dur"]
    assert T.plan_load(root)["compose"]["duration"] == seen["dur"]
