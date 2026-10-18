"""先解析素材: the endpoint charges once, saves analysis.json, the runner then probes for free;
OAuth sign-in creates/links accounts by verified email; test accounts are credited without payment."""
import asyncio
import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace as NS

os.environ.setdefault("DATA_DIR", "/tmp/lk-test-data")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from app import config as C  # noqa: E402
from app import db as D  # noqa: E402
from app import main as M  # noqa: E402
from app import oauth as O  # noqa: E402
from app import pricing as P  # noqa: E402
from app.agent import analyze as A  # noqa: E402
from app.agent import runner as R  # noqa: E402
from app.auth import current_user  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_db(tmp_path: Path, monkeypatch):
    eng = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/t.db", poolclass=NullPool)
    D.engine = eng
    D.Session.configure(bind=eng)
    asyncio.run(D.init_db())
    monkeypatch.setattr(C, "DATA_DIR", tmp_path)
    yield


@pytest.fixture
def client():
    holder = {}
    M.app.dependency_overrides[current_user] = lambda: holder["u"]
    yield TestClient(M.app), holder
    M.app.dependency_overrides.clear()


async def _user(email="a@b.c", points=0):
    async with D.Session() as s:
        u = D.User(email=email, pw_hash="x"); s.add(u); await s.commit()
    if points:
        await D.add_credits(u.id, points, "grant", "test")
    return u


async def _project(uid):
    async with D.Session() as s:
        p = D.Project(user_id=uid, name="p"); s.add(p); await s.commit()
    return p.id


def _clip(dest: Path, seconds=4):
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size=320x240:rate=10:duration={seconds}",
                    "-pix_fmt", "yuv420p", str(dest)], check=True)


SAMPLE = {"summary": "海邊民宿，有泳池", "selling_points": ["無邊際泳池看海", "包棟", "寵物友善"],
          "storyboard": [{"n": 1, "clip": 1, "t": 1, "dur": 3, "shot": "泳池全景", "role": "hook"},
                         {"n": 2, "clip": 99, "t": 0, "dur": 3, "shot": "不存在的素材", "role": "feature"},
                         {"n": 3, "clip": 2, "t": 30, "dur": 9, "shot": "超出長度", "role": "cta"}],
          "script": [{"n": 1, "text": "宜蘭海邊，推開門就是泳池"}, {"n": 3, "text": "點連結查空房"}],
          "transcript_notes": "", "missing": ["價格", "店名"]}


def _fake_client(text=json.dumps(SAMPLE, ensure_ascii=False)):
    import inspect
    import anthropic
    allowed = set(inspect.signature(anthropic.AsyncAnthropic(api_key="x").messages.create).parameters)

    async def create(**kw):
        assert set(kw) <= allowed, set(kw) - allowed   # only arguments the real SDK accepts (temperature is gone)
        assert kw["messages"][0]["content"][1]["type"] == "image"   # the contact sheet went along
        return NS(content=[NS(type="text", text=text)], usage=NS(input_tokens=1000, output_tokens=200, cache_read_input_tokens=0, cache_creation_input_tokens=0))
    return NS(messages=NS(create=create))


def test_analyze_charges_once_then_probe_is_free(client, monkeypatch):
    c, holder = client
    u = asyncio.run(_user(points=P.SIGNUP_POINTS)); holder["u"] = u
    pid = asyncio.run(_project(u.id))
    root = D.project_dir(pid)
    assert c.post(f"/api/projects/{pid}/analyze", json={}).status_code == 400   # no footage yet
    _clip(root / "raw" / "uploads" / "a.mp4"); _clip(root / "raw" / "uploads" / "b.mp4")
    monkeypatch.setattr(A, "_client", _fake_client)
    r = c.post(f"/api/projects/{pid}/analyze", json={"brief": "寵物友善"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["charged"] == 14 and d["selling_points"][0] == "無邊際泳池看海"
    assert [s["clip"] for s in d["storyboard"]] == [1, 2]                  # clip 99 dropped
    assert d["storyboard"][1]["dur"] == 6.0 and d["storyboard"][1]["t"] <= 4  # clamped to the clip
    assert d["estimate"]["first_video_points"] == 64 and d["estimate"]["two_revisions_points"] == 100
    assert d["estimate"]["balance"] == 96 and d["estimate"]["enough_first"] and not d["estimate"]["enough_two"] and d["estimate"]["short_two"] == 4
    assert (root / "sheets" / "analysis.json").exists()
    assert c.get(f"/api/projects/{pid}").json()["analysis"]["n_clips"] == 2
    # frames for the storyboard
    assert c.get(f"/api/projects/{pid}/frame/1?t=1").headers["content-type"] == "image/jpeg"
    assert c.get(f"/api/projects/{pid}/frame/7").status_code == 404
    # a failing model call refunds
    monkeypatch.setattr(A, "_client", lambda: _fake_client("not json"))
    assert c.post(f"/api/projects/{pid}/analyze", json={}).status_code == 500
    assert asyncio.run(D.balance(u.id)) == 96
    # the agent's probe is now free for this project
    cost = {}

    async def charge(pid_, points, reason):
        cost[reason] = points
        return True, 96
    store = NS(charge=charge, storage_state=None, note_export=None, credit_state=None)
    tr = R.TurnRunner(pid, root, store, lambda ev: asyncio.sleep(0))
    tr._loop = asyncio.new_event_loop()
    asyncio.run(tr._run_tool(NS(name="probe_footage", id="t1", input={})))
    assert cost == {"probe_footage": 0}
    brief = A.as_brief(d)
    assert "無邊際泳池看海" in brief and "#01@1.0s" in brief


def test_analyze_insufficient_points(client, monkeypatch):
    c, holder = client
    u = asyncio.run(_user(points=5)); holder["u"] = u
    pid = asyncio.run(_project(u.id))
    _clip(D.project_dir(pid) / "raw" / "uploads" / "a.mp4")
    r = c.post(f"/api/projects/{pid}/analyze", json={})
    assert r.status_code == 402 and r.json()["needed"] == 14 and r.json()["balance"] == 5


def test_oauth_creates_then_links(monkeypatch):
    monkeypatch.setattr(C, "GOOGLE_CLIENT_ID", "id"); monkeypatch.setattr(C, "GOOGLE_CLIENT_SECRET", "sec")
    c = TestClient(M.app)
    assert c.get("/api/auth/providers").json() == {"google": True, "facebook": False, "line": False}
    assert c.get("/api/auth/facebook/start", follow_redirects=False).status_code == 404
    r = c.get("/api/auth/google/start", follow_redirects=False)
    assert r.status_code == 302 and "accounts.google.com" in r.headers["location"] and "editor.lakeze.com%2Fapi%2Fauth%2Fgoogle%2Fcallback" in r.headers["location"]
    state = r.headers["location"].split("state=")[1].split("&")[0]
    monkeypatch.setattr(O, "_fetch_profile", lambda name, code: {"id": "g1", "email": "New@Gmail.com", "verified": True, "name": "Ken"})
    r = c.get(f"/api/auth/google/callback?code=abc&state={state}", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/" and "lk_session" in r.headers.get("set-cookie", "")
    me = c.get("/api/me").json()
    assert me["email"] == "new@gmail.com" and me["provider"] == "google" and me["balance"] == P.SIGNUP_POINTS and me["name"] == "Ken"
    # password login on an OAuth-only account is refused with a hint
    assert "Google" in c.post("/api/auth/login", json={"email": "new@gmail.com", "password": "whatever1"}).json()["detail"]
    # bad state → back to /login with an error, no session
    c2 = TestClient(M.app)
    r = c2.get("/api/auth/google/callback?code=abc&state=nope", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].startswith("/login?oauth_error=")
    # an existing password account with the same email just signs in (no second welcome grant)
    u = asyncio.run(_user(email="old@x.y", points=3))
    c3 = TestClient(M.app)
    state = c3.get("/api/auth/google/start", follow_redirects=False).headers["location"].split("state=")[1].split("&")[0]
    monkeypatch.setattr(O, "_fetch_profile", lambda name, code: {"id": "g2", "email": "old@x.y", "verified": True, "name": None})
    c3.get(f"/api/auth/google/callback?code=abc&state={state}", follow_redirects=False)
    assert c3.get("/api/me").json()["id"] == u.id and asyncio.run(D.balance(u.id)) == 3
    # unverified / missing email is refused
    c4 = TestClient(M.app)
    state = c4.get("/api/auth/google/start", follow_redirects=False).headers["location"].split("state=")[1].split("&")[0]
    monkeypatch.setattr(O, "_fetch_profile", lambda name, code: {"id": "g3", "email": "", "verified": False, "name": None})
    assert "oauth_error" in c4.get(f"/api/auth/google/callback?code=abc&state={state}", follow_redirects=False).headers["location"]


def test_default_test_accounts():
    assert {"kuofat@gmail.com", "lodestar0115@gmail.com"} <= C.TEST_EMAILS


def test_test_account_buys_without_payment(client):
    c, holder = client
    u = asyncio.run(_user(email="kuofat@gmail.com")); holder["u"] = u
    assert c.get("/api/me").json()["test_account"] is True
    r = c.get("/api/checkout/p100"); assert r.status_code == 200, r.text
    assert r.json()["test"] and r.json()["granted"] == 100 and r.json()["balance"] == 100
    r = c.get("/api/checkout/sub5"); assert r.status_code == 200, r.text

    async def reload():
        async with D.Session() as s:
            return await s.get(D.User, u.id)
    holder["u"] = asyncio.run(reload())   # the real dependency reloads the user per request
    me = c.get("/api/me").json()
    assert me["subscription"]["id"] == "sub5" and me["balance"] == 100 + P.SUBSCRIPTIONS["sub5"]["points"] == 700 and me["can_clone_voice"]
    assert c.get("/api/checkout/nope").status_code == 404
    # a normal account without checkout URLs is still told to contact support
    holder["u"] = asyncio.run(_user(email="x@y.z"))
    assert c.get("/api/checkout/p100").status_code == 410


def test_drive_check(client, monkeypatch):
    c, holder = client
    u = asyncio.run(_user()); holder["u"] = u
    pid = asyncio.run(_project(u.id))
    assert c.post(f"/api/projects/{pid}/drive/check", json={"url": "not a url"}).status_code == 400
    from app.pipeline import footage as F
    monkeypatch.setattr(F, "list_drive_folder", lambda url, root: [{"id": "1", "path": "a.MOV"}, {"id": "2", "path": "sub/b.jpg"}, {"id": "3", "path": "notes.txt"}])
    r = c.post(f"/api/projects/{pid}/drive/check", json={"url": "https://drive.google.com/drive/folders/XYZ_1?usp=sharing"})
    assert r.status_code == 200 and r.json()["media"] == 2 and r.json()["videos"] == 1 and r.json()["photos"] == 1 and r.json()["other"] == 1
    monkeypatch.setattr(F, "list_drive_folder", lambda url, root: (_ for _ in ()).throw(ValueError("folder is empty or not shared publicly")))
    r = c.post(f"/api/projects/{pid}/drive/check", json={"url": "https://drive.google.com/drive/folders/XYZ"})
    assert r.status_code == 400 and "知道連結的使用者" in r.json()["detail"]


def test_link_providers(tmp_path: Path, monkeypatch):
    from app.pipeline import links as L
    assert [L.provider(u) for u in ["https://drive.google.com/drive/folders/x", "https://www.dropbox.com/scl/fi/abc/IMG_1.MOV?rlkey=k&dl=0",
            "https://www.icloud.com/iclouddrive/0aBc#clip", "https://1drv.ms/f/s!abc", "https://cdn.example.com/a.mp4"]] == ["google", "dropbox", "icloud", "onedrive", "direct"]
    r = L.resolve("https://www.dropbox.com/scl/fi/abc/IMG_1.MOV?rlkey=k&dl=0", tmp_path)
    assert r["items"][0]["path"] == "IMG_1.MOV" and "dl=1" in r["items"][0]["url"] and "rlkey=k" in r["items"][0]["url"]
    r = L.resolve("https://www.dropbox.com/scl/fo/xyz/AAA?rlkey=k&dl=0", tmp_path)
    assert r["items"][0]["zip"] and "dl=1" in r["items"][0]["url"]
    assert json.loads((tmp_path / "sheets" / "drive.json").read_text())[0]["zip"] is True
    class H:
        status_code = 200; headers = {"content-type": "video/mp4", "content-length": "123"}; url = "https://cdn.example.com/v/beach"
    monkeypatch.setattr(L.requests, "head", lambda *a, **k: H())
    r = L.resolve("https://cdn.example.com/v/beach", tmp_path)
    assert r["items"][0]["path"] == "beach.mp4" and r["provider"] == "direct"
    H.headers = {"content-type": "text/html"}
    import pytest
    with pytest.raises(L.LinkError):
        L.resolve("https://example.com/page", tmp_path)


def test_dropbox_zip_unpacked(tmp_path: Path, monkeypatch):
    import subprocess as SP
    import zipfile
    from app.pipeline import footage as F
    src = tmp_path / "src.zip"
    with zipfile.ZipFile(src, "w") as z:
        z.writestr("trip/a.mov", b"m" * 4000); z.writestr("trip/b.jpg", b"j" * 4000); z.writestr("trip/notes.txt", b"t" * 4000); z.writestr("__MACOSX/._a.mov", b"x")
    def fake_run(cmd, **kw):
        out = Path(cmd[cmd.index("-o") + 1]); out.write_bytes(src.read_bytes())
    monkeypatch.setattr(F.subprocess, "run", fake_run)
    root = tmp_path / "p"; (root / "raw").mkdir(parents=True)
    res = F.download_link([{"id": "dropbox", "path": "dropbox_folder.zip", "url": "https://x?dl=1", "zip": True}], root)
    assert res == ["ok 2 files from folder"]
    assert sorted(p.name for p in (root / "raw" / "dropbox").iterdir()) == ["a.mov", "b.jpg"] and not (root / "raw" / "dropbox_folder.zip").exists()
