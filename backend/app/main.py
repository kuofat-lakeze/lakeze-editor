"""Lakeze Editor API: auth, projects, uploads, chat turns streamed over SSE, asset files."""
import asyncio
import json
import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, select

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from . import config, pricing
from .admin import router as admin_router
from .agent.runner import TurnRunner
from .auth import CurrentUser, check_pw, clear_session, hash_pw, set_session
from .db import Asset, CreditTx, Message, Project, Session, Share, ShareComment, Store, Usage, User, add_credits, asset_dict, backfill_versions, balance, init_db
from .pipeline import eleven
from .pipeline.fonts import ensure_fonts
from .storage import project_dir, safe_join

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("api")


async def _cleanup_loop():
    """Free disk: drop raw footage + work files of projects idle longer than RAW_RETENTION_DAYS."""
    import shutil
    from datetime import datetime, timedelta, timezone
    while True:
        try:
            cutoff = datetime.now(timezone.utc) - timedelta(days=config.RAW_RETENTION_DAYS)
            async with Session() as s:
                stale = (await s.execute(select(Project).where(Project.updated_at < cutoff))).scalars().all()
            for p in stale:
                if p.id in _turns and not _turns[p.id]["task"].done():
                    continue
                root = project_dir(p.id)
                freed = 0
                for sub in ("raw", "work"):
                    d = root / sub
                    if d.exists() and any(d.iterdir()):
                        freed += sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
                        shutil.rmtree(d)
                        d.mkdir()
                if freed:
                    log.info("cleanup: project %s freed %d MB", p.id, freed >> 20)
        except Exception:
            log.exception("cleanup failed")
        await asyncio.sleep(6 * 3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    try:
        n = await backfill_versions()
        if n:
            log.info("backfilled version on %d legacy deliverable assets", n)
    except Exception:
        log.exception("deliverable backfill failed")
    try:
        await asyncio.to_thread(ensure_fonts)
    except Exception as e:  # fonts can be fetched later; don't block startup
        log.warning("font download failed: %s", e)
    task = asyncio.create_task(_cleanup_loop()) if config.RAW_RETENTION_DAYS > 0 else None
    yield
    if task:
        task.cancel()


app = FastAPI(title="Lakeze Editor", lifespan=lifespan)
app.include_router(admin_router)

# ---- live turn registry -------------------------------------------------------
_turns: dict[str, dict] = {}  # project_id -> {"task", "subs": set[Queue], "events": list}


def _broadcast(project_id: str):
    async def emit(ev: dict):
        t = _turns.get(project_id)
        if not t:
            return
        t["events"].append(ev)
        for q in list(t["subs"]):
            await q.put(ev)
    return emit


# ---- auth ----------------------------------------------------------------------
class Creds(BaseModel):
    email: EmailStr
    password: str


@app.post("/api/auth/signup")
async def signup(c: Creds, request: Request):
    if not config.ALLOW_SIGNUP:
        raise HTTPException(403, "signup disabled")
    if len(c.password) < 8:
        raise HTTPException(400, "密碼至少 8 碼")
    async with Session() as s:
        if (await s.execute(select(User).where(User.email == c.email.lower()))).scalar_one_or_none():
            raise HTTPException(409, "email 已註冊")
        u = User(email=c.email.lower(), pw_hash=hash_pw(c.password), is_admin=c.email.lower() in config.ADMIN_EMAILS)
        s.add(u)
        await s.commit()
    resp = JSONResponse({"id": u.id, "email": u.email})
    set_session(resp, u.id, request.url.scheme == "https")
    return resp


@app.post("/api/auth/login")
async def login(c: Creds, request: Request):
    async with Session() as s:
        u = (await s.execute(select(User).where(User.email == c.email.lower()))).scalar_one_or_none()
        if u and u.email in config.ADMIN_EMAILS and not u.is_admin:
            u.is_admin = True
            await s.commit()
    if not u or not check_pw(c.password, u.pw_hash):
        raise HTTPException(401, "email 或密碼錯誤")
    if u.disabled:
        raise HTTPException(403, "帳號已停用")
    resp = JSONResponse({"id": u.id, "email": u.email})
    set_session(resp, u.id, request.url.scheme == "https")
    return resp


@app.post("/api/auth/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    clear_session(resp)
    return resp


@app.get("/api/me")
async def me(user: User = CurrentUser):
    if user.disabled:
        raise HTTPException(403, "帳號已停用")
    return {"id": user.id, "email": user.email, "is_admin": user.is_admin, "balance": await balance(user.id),
            "free_project_id": user.free_project_id}


@app.get("/api/pricing")
async def get_pricing():
    packs = []
    for pid, p in pricing.PACKS.items():
        packs.append({"id": pid, **p, "checkout_url": config.CHECKOUT_URLS.get(pid)})
    return {"point_twd": pricing.POINT_TWD, "menu": [{"item": i, "points": p} for i, p in pricing.MENU],
            "free_revision_turns": pricing.FREE_REVISION_TURNS, "packs": packs,
            "provider_configured": bool(config.CHECKOUT_URLS), "note": config.TOPUP_NOTE}


@app.get("/api/credits")
async def my_credits(user: User = CurrentUser):
    async with Session() as s:
        tx = (await s.execute(select(CreditTx).where(CreditTx.user_id == user.id).order_by(CreditTx.id.desc()).limit(100))).scalars()
        return {"balance": await balance(user.id),
                "ledger": [{"delta": t.delta, "waived": t.points_waived, "kind": t.kind, "reason": t.reason,
                            "project_id": t.project_id, "created_at": t.created_at.isoformat()} for t in tx]}


@app.get("/api/credits/summary")
async def credits_summary(user: User = CurrentUser):
    """Everything the credits page shows: totals, per-project spend by category, daily usage (30 days)."""
    from datetime import datetime, timedelta, timezone
    since = datetime.now(timezone.utc) - timedelta(days=30)
    async with Session() as s:
        tx = (await s.execute(select(CreditTx).where(CreditTx.user_id == user.id).order_by(CreditTx.id))).scalars().all()
        projects = (await s.execute(select(Project).where(Project.user_id == user.id).order_by(Project.updated_at.desc()))).scalars().all()
    purchased = sum(t.delta for t in tx if t.kind in ("purchase", "grant"))
    refunded = sum(t.delta for t in tx if t.kind == "refund")
    used = -sum(t.delta for t in tx if t.kind == "charge")
    waived = sum(t.points_waived for t in tx)
    by_proj: dict[str, dict] = {}
    daily: dict[str, dict] = {}
    for t in tx:
        if t.kind != "charge":
            continue
        cat = pricing.TOOL_CATEGORY.get(t.reason, "subs")
        pts_used, pts_waived = -t.delta, t.points_waived
        if t.project_id:
            d = by_proj.setdefault(t.project_id, {"used": 0, "waived": 0, "by_category": {c: 0 for c, _ in pricing.CATEGORIES},
                                                 "by_tool": {}})
            d["used"] += pts_used; d["waived"] += pts_waived
            d["by_category"][cat] += pts_used + pts_waived
            d["by_tool"][t.reason] = d["by_tool"].get(t.reason, 0) + pts_used + pts_waived
        ts = t.created_at
        if ts is not None and ts.tzinfo is None:  # SQLite hands back naive UTC timestamps
            ts = ts.replace(tzinfo=timezone.utc)
        if ts is not None and ts >= since:
            k = ts.date().isoformat()
            dd = daily.setdefault(k, {"date": k, "used": 0, "waived": 0})
            dd["used"] += pts_used; dd["waived"] += pts_waived
    days = [(since + timedelta(days=i + 1)).date().isoformat() for i in range(30)]
    balance_now = await balance(user.id)
    return {
        "balance": balance_now, "purchased": purchased, "refunded": refunded, "used": used, "waived": waived,
        "revision_points": 8,  # typical revision round (mix + captions + export), for the "about N more revisions" hint
        "categories": [{"id": c, "label": l} for c, l in pricing.CATEGORIES],
        "tool_labels": pricing.TOOL_LABELS,
        "projects": [{"id": p.id, "name": p.name, "exports": p.exports, "revision_turns": p.revision_turns,
                      "free": user.free_project_id == p.id, "updated_at": p.updated_at.isoformat(),
                      **by_proj.get(p.id, {"used": 0, "waived": 0, "by_category": {c: 0 for c, _ in pricing.CATEGORIES}, "by_tool": {}})}
                     for p in projects],
        "daily": [daily.get(d, {"date": d, "used": 0, "waived": 0}) for d in days],
    }


@app.get("/api/checkout/{pack_id}")
async def checkout(pack_id: str, user: User = CurrentUser):
    """Hosted checkout link with the user id attached so the webhook can credit the right account."""
    url = config.CHECKOUT_URLS.get(pack_id)
    if not url:
        raise HTTPException(404, "此方案未開放線上付款")
    sep = "&" if "?" in url else "?"
    return {"url": f"{url}{sep}checkout[custom][user_id]={user.id}&checkout[email]={user.email}"}


@app.post("/api/webhooks/lemonsqueezy")
async def lemonsqueezy_webhook(request: Request):
    """Credits a pack on `order_created`. Verifies X-Signature (HMAC-SHA256 of the raw body)."""
    body = await request.body()
    if not config.LS_WEBHOOK_SECRET:
        raise HTTPException(503, "webhook not configured")
    sig = request.headers.get("X-Signature", "")
    expected = hmac.new(config.LS_WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(401, "bad signature")
    ev = json.loads(body)
    if ev.get("meta", {}).get("event_name") != "order_created":
        return {"ignored": True}
    attrs = ev["data"]["attributes"]
    order_id = str(ev["data"]["id"])
    user_id = (ev["meta"].get("custom_data") or {}).get("user_id")
    variant = str((attrs.get("first_order_item") or {}).get("variant_id"))
    pack_id = config.LS_VARIANTS.get(variant)
    if not user_id or not pack_id or pack_id not in pricing.PACKS:
        log.warning("webhook: unmapped order %s variant=%s user=%s", order_id, variant, user_id)
        return {"ignored": True}
    async with Session() as s:  # idempotent on order id
        dup = (await s.execute(select(CreditTx).where(CreditTx.meta.contains(f'"order_id": "{order_id}"')))).first()
    if dup:
        return {"duplicate": True}
    pack = pricing.PACKS[pack_id]
    await add_credits(user_id, pack["points"], "purchase", f"lemonsqueezy {pack_id}", amount_twd=pack["twd"],
                      meta={"order_id": order_id, "total": attrs.get("total"), "currency": attrs.get("currency")})
    return {"ok": True}


# ---- projects --------------------------------------------------------------------
class NewProject(BaseModel):
    name: str


async def _own(project_id: str, user: User) -> Project:
    async with Session() as s:
        p = await s.get(Project, project_id)
    if not p or p.user_id != user.id:
        raise HTTPException(404, "project not found")
    return p


@app.get("/api/projects")
async def list_projects(user: User = CurrentUser):
    async with Session() as s:
        rows = (await s.execute(select(Project).where(Project.user_id == user.id).order_by(Project.updated_at.desc()))).scalars()
        return [{"id": p.id, "name": p.name, "updated_at": p.updated_at.isoformat(), "exports": p.exports,
                 "final_version": p.final_version} for p in rows]


@app.post("/api/projects")
async def create_project(body: NewProject, user: User = CurrentUser):
    async with Session() as s:
        p = Project(user_id=user.id, name=body.name.strip()[:200] or "未命名")
        s.add(p)
        await s.flush()
        u = await s.get(User, user.id)
        free = False
        if u.free_project_id is None:  # the first project runs on the free-trial allowance
            u.free_project_id = p.id
            free = True
        await s.commit()
    project_dir(p.id)
    return {"id": p.id, "name": p.name, "free": free}


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str, user: User = CurrentUser):
    p = await _own(project_id, user)
    async with Session() as s:
        msgs = (await s.execute(select(Message).where(Message.project_id == p.id).order_by(Message.id))).scalars()
        assets = (await s.execute(select(Asset).where(Asset.project_id == p.id).order_by(Asset.created_at))).scalars()
        out_msgs = [_public_message(m) for m in msgs]
        comments = (await s.execute(select(ShareComment).where(ShareComment.project_id == p.id).order_by(ShareComment.id))).scalars()
        client_comments = [{"id": c.id, "name": c.name, "text": c.text, "created_at": c.created_at.isoformat()} for c in comments]
    st = await Store(user.id).credit_state(p.id)
    return {"id": p.id, "name": p.name, "messages": [m for m in out_msgs if m],
            "assets": [asset_dict(a) for a in assets], "running": project_id in _turns and not _turns[project_id]["task"].done(),
            "credits": st, "final_version": p.final_version, "exports": p.exports, "client_comments": client_comments}


def _public_message(m: Message) -> dict | None:
    """Flatten API content blocks into what the UI shows: user text, assistant text, tool calls."""
    blocks = json.loads(m.content)
    parts = []
    for b in blocks:
        t = b.get("type")
        if t == "text" and b.get("text", "").strip():
            parts.append({"type": "text", "text": b["text"]})
        elif t == "tool_use":
            parts.append({"type": "tool", "name": b["name"]})
        elif t == "tool_result":
            return None  # internal
    if not parts:
        return None
    return {"id": m.id, "role": m.role, "parts": parts, "created_at": m.created_at.isoformat()}


# ---- uploads ----------------------------------------------------------------------
_SAFE = re.compile(r"[^\w.\-一-鿿]+")


@app.post("/api/projects/{project_id}/upload")
async def upload(project_id: str, files: list[UploadFile], user: User = CurrentUser):
    await _own(project_id, user)
    root = project_dir(project_id)
    saved = []
    for f in files:
        name = _SAFE.sub("_", Path(f.filename or "clip.mp4").name)
        dest = safe_join(root, f"raw/uploads/{name}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        size = 0
        with open(dest, "wb") as w:
            while chunk := await f.read(1 << 20):
                size += len(chunk)
                if size > config.MAX_UPLOAD_MB << 20:
                    w.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(413, f"{name} 超過 {config.MAX_UPLOAD_MB}MB")
                w.write(chunk)
        saved.append({"name": name, "mb": round(size / 2**20, 1)})
    return {"saved": saved}


# ---- chat ----------------------------------------------------------------------------
class Turn(BaseModel):
    text: str


@app.post("/api/projects/{project_id}/messages")
async def send_message(project_id: str, body: Turn, user: User = CurrentUser):
    await _own(project_id, user)
    t = _turns.get(project_id)
    if t and not t["task"].done():
        raise HTTPException(409, "上一回合還在進行中")
    if config.USER_BUDGET_USD:
        async with Session() as s:
            spent = (await s.execute(select(func.coalesce(func.sum(Usage.cost_usd), 0.0)).where(Usage.user_id == user.id))).scalar()
        if spent >= config.USER_BUDGET_USD:
            raise HTTPException(402, "已達用量上限")
    _turns[project_id] = {"task": None, "subs": set(), "events": []}
    runner = TurnRunner(project_id, project_dir(project_id), Store(user.id), _broadcast(project_id))
    blocks = [{"type": "text", "text": body.text}]

    async def go():
        try:
            await runner.run(blocks)
        except Exception as e:
            log.exception("turn failed")
            await _broadcast(project_id)({"type": "error", "message": f"{type(e).__name__}: {str(e)[:300]}"})
            await _broadcast(project_id)({"type": "done"})

    _turns[project_id]["task"] = asyncio.create_task(go())
    return {"ok": True}


@app.post("/api/projects/{project_id}/cancel")
async def cancel(project_id: str, user: User = CurrentUser):
    await _own(project_id, user)
    t = _turns.get(project_id)
    if t and not t["task"].done():
        t["task"].cancel()
        await _broadcast(project_id)({"type": "error", "message": "已取消"})
        await _broadcast(project_id)({"type": "done"})
    return {"ok": True}


@app.get("/api/projects/{project_id}/stream")
async def stream(project_id: str, request: Request, user: User = CurrentUser):
    await _own(project_id, user)

    async def gen():
        t = _turns.get(project_id)
        if not t:
            yield _sse({"type": "idle"})
            return
        q: asyncio.Queue = asyncio.Queue()
        for ev in t["events"]:  # replay what this turn already produced
            yield _sse(ev)
        if t["task"].done():
            return
        t["subs"].add(q)
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield _sse(ev)
                if ev.get("type") == "done":
                    return
                if await request.is_disconnected():
                    return
        finally:
            t["subs"].discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _sse(ev: dict) -> str:
    return f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"


# ---- deliverables & client share links ------------------------------------------------------
def _versions(assets: list[Asset]) -> list[dict]:
    """Group deliverable assets (exports + covers) by version, newest first."""
    by: dict[int, dict] = {}
    for a in assets:
        if a.version is None:
            continue
        v = by.setdefault(a.version, {"version": a.version, "created_at": a.created_at.isoformat(), "videos": [], "covers": []})
        d = asset_dict(a)
        (v["covers"] if a.kind == "image" else v["videos"]).append(d)
        v["created_at"] = max(v["created_at"], a.created_at.isoformat())
    for v in by.values():
        order = {"upload": 0, "master": 1, "preview": 2}
        v["videos"].sort(key=lambda x: order.get(x.get("role") or "", 9))
        v["main"] = next((x for x in v["videos"] if x.get("role") == "upload"), v["videos"][0] if v["videos"] else None)
    return [by[k] for k in sorted(by, reverse=True)]


def _share_dict(sh: Share) -> dict:
    return {"id": sh.id, "token": sh.token, "url": f"/s/{sh.token}", "version": sh.version, "allow_download": sh.allow_download,
            "note": sh.note, "expires_at": sh.expires_at.isoformat() if sh.expires_at else None, "revoked": sh.revoked,
            "views": sh.views, "created_at": sh.created_at.isoformat()}


@app.get("/api/projects/{project_id}/deliverables")
async def deliverables(project_id: str, user: User = CurrentUser):
    p = await _own(project_id, user)
    async with Session() as s:
        assets = (await s.execute(select(Asset).where(Asset.project_id == p.id).order_by(Asset.created_at))).scalars().all()
        shares = (await s.execute(select(Share).where(Share.project_id == p.id).order_by(Share.created_at.desc()))).scalars().all()
    return {"project": {"id": p.id, "name": p.name, "final_version": p.final_version, "exports": p.exports},
            "versions": _versions(assets), "shares": [_share_dict(x) for x in shares]}


class FinalBody(BaseModel):
    version: int | None


@app.post("/api/projects/{project_id}/final")
async def set_final(project_id: str, body: FinalBody, user: User = CurrentUser):
    await _own(project_id, user)
    async with Session() as s:
        p = await s.get(Project, project_id)
        p.final_version = body.version
        await s.commit()
    return {"ok": True, "final_version": body.version}


class ShareBody(BaseModel):
    version: int | None = None       # None = follow the project's final version
    allow_download: bool = True
    expires_days: int | None = None  # None = never
    note: str = ""


@app.post("/api/projects/{project_id}/share")
async def create_share(project_id: str, body: ShareBody, user: User = CurrentUser):
    await _own(project_id, user)
    sh = Share(token=secrets.token_urlsafe(12), project_id=project_id, version=body.version, allow_download=body.allow_download,
               note=body.note.strip()[:1000],
               expires_at=(datetime.now(timezone.utc) + timedelta(days=body.expires_days)) if body.expires_days else None)
    async with Session() as s:
        s.add(sh)
        await s.commit()
    return _share_dict(sh)


@app.post("/api/projects/{project_id}/share/{share_id}/revoke")
async def revoke_share(project_id: str, share_id: str, user: User = CurrentUser):
    await _own(project_id, user)
    async with Session() as s:
        sh = await s.get(Share, share_id)
        if not sh or sh.project_id != project_id:
            raise HTTPException(404)
        sh.revoked = True
        await s.commit()
    return {"ok": True}


async def _share_by_token(token: str) -> tuple[Share, Project]:
    async with Session() as s:
        sh = (await s.execute(select(Share).where(Share.token == token))).scalar_one_or_none()
        if not sh or sh.revoked:
            raise HTTPException(404, "連結不存在或已停用")
        exp = sh.expires_at
        if exp is not None and exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp and exp < datetime.now(timezone.utc):
            raise HTTPException(410, "連結已過期")
        p = await s.get(Project, sh.project_id)
    return sh, p


def _share_versions(sh: Share, p: Project, assets: list[Asset]) -> list[dict]:
    vs = _versions(assets)
    want = sh.version if sh.version is not None else p.final_version
    if want is not None:
        vs = [v for v in vs if v["version"] == want]
    elif vs:
        vs = vs[:1]  # nothing marked final yet: show the latest
    for v in vs:  # rewrite urls to the public file endpoint
        for a in v["videos"] + v["covers"]:
            a["url"] = f"/api/s/{sh.token}/file/{a['id']}"
        if v.get("main"):
            v["main"]["url"] = f"/api/s/{sh.token}/file/{v['main']['id']}"
    return vs


@app.get("/api/s/{token}")
async def share_view(token: str):
    sh, p = await _share_by_token(token)
    async with Session() as s:
        assets = (await s.execute(select(Asset).where(Asset.project_id == p.id).order_by(Asset.created_at))).scalars().all()
        row = await s.get(Share, sh.id)
        row.views = (row.views or 0) + 1
        await s.commit()
    return {"project_name": p.name, "note": sh.note, "allow_download": sh.allow_download,
            "brand": {"name": "人客多", "tagline": "專業旅遊剪輯 AI"}, "versions": _share_versions(sh, p, assets)}


@app.get("/api/s/{token}/file/{asset_id}")
async def share_file(token: str, asset_id: str, download: int = 0):
    sh, p = await _share_by_token(token)
    async with Session() as s:
        a = await s.get(Asset, asset_id)
        assets = (await s.execute(select(Asset).where(Asset.project_id == p.id))).scalars().all()
    if not a or a.project_id != p.id or a.version is None:
        raise HTTPException(404)
    allowed = {x["id"] for v in _share_versions(sh, p, assets) for x in v["videos"] + v["covers"]}
    if a.id not in allowed:
        raise HTTPException(404)
    if download and not sh.allow_download:
        raise HTTPException(403, "此連結不允許下載")
    path = safe_join(project_dir(p.id), a.rel_path)
    nice = f"{p.name}_v{a.version}_{a.name}{path.suffix}".replace("/", "-")
    return FileResponse(path, filename=nice if download else None, content_disposition_type="attachment" if download else "inline")


class CommentBody(BaseModel):
    name: str = ""
    text: str


@app.post("/api/s/{token}/comment")
async def share_comment(token: str, body: CommentBody):
    sh, p = await _share_by_token(token)
    text_ = body.text.strip()
    if not text_:
        raise HTTPException(400, "留言不能是空的")
    async with Session() as s:
        s.add(ShareComment(project_id=p.id, share_id=sh.id, name=body.name.strip()[:80], text=text_[:2000]))
        await s.commit()
    return {"ok": True}


@app.get("/api/gallery")
async def gallery(user: User = CurrentUser):
    """Every project's delivered (or latest) version with its cover, for the 作品庫 wall."""
    async with Session() as s:
        projects = (await s.execute(select(Project).where(Project.user_id == user.id).order_by(Project.updated_at.desc()))).scalars().all()
        assets = (await s.execute(select(Asset).where(Asset.project_id.in_([p.id for p in projects]) if projects else False)
                                  .order_by(Asset.created_at))).scalars().all()
    by_proj: dict[str, list[Asset]] = {}
    for a in assets:
        by_proj.setdefault(a.project_id, []).append(a)
    out = []
    for p in projects:
        vs = _versions(by_proj.get(p.id, []))
        if not vs:
            continue
        v = next((x for x in vs if x["version"] == p.final_version), vs[0])
        out.append({"project_id": p.id, "name": p.name, "version": v["version"], "final": v["version"] == p.final_version,
                    "cover": v["covers"][-1] if v["covers"] else None, "video": v.get("main"), "updated_at": p.updated_at.isoformat()})
    return out


# ---- assets -----------------------------------------------------------------------------
@app.get("/api/projects/{project_id}/assets/{asset_id}")
async def asset_file(project_id: str, asset_id: str, user: User = CurrentUser):
    await _own(project_id, user)
    async with Session() as s:
        a = await s.get(Asset, asset_id)
    if not a or a.project_id != project_id:
        raise HTTPException(404)
    p = safe_join(project_dir(project_id), a.rel_path)
    return FileResponse(p, filename=p.name)


_voices_cache: dict = {"at": 0.0, "data": []}


@app.get("/api/voices")
async def voices(user: User = CurrentUser):
    """Voices the UI offers up front: configured presets first, then Taiwanese-accent voices from the
    Voice Library, each with a preview clip. Cached for an hour."""
    import time
    if time.time() - _voices_cache["at"] < 3600 and _voices_cache["data"]:
        return _voices_cache["data"]
    out = [dict(v) for v in config.VOICE_PRESETS]
    try:
        found = await asyncio.to_thread(eleven.search_voices, "", "zh", "taiwanese", 12)
    except Exception as e:
        log.warning("voice search failed: %s", e)
        found = []
    by_id = {v["voice_id"]: v for v in found}
    for v in out:
        if not v.get("preview_url"):
            if v["voice_id"] in by_id:
                v["preview_url"] = by_id[v["voice_id"]].get("preview_url")
            else:
                try:
                    v["preview_url"] = (await asyncio.to_thread(eleven.voice_info, v["voice_id"])).get("preview_url")
                except Exception:
                    v["preview_url"] = None
    seen = {v["voice_id"] for v in out}
    for v in found:
        if v["voice_id"] not in seen and len(out) < 6:
            name, _, tail = v["name"].partition(" - ")  # "Kuo Yu - Taiwan Mandarin Narrator" → name + tagline
            out.append({"voice_id": v["voice_id"], "name": name.strip(), "gender": v.get("gender"),
                        "description": (tail or v.get("description") or "")[:40], "preview_url": v.get("preview_url")})
            seen.add(v["voice_id"])
    _voices_cache.update(at=time.time(), data=out)
    return out


class ClientLog(BaseModel):
    event: str
    detail: dict = {}


@app.post("/api/client-log")
async def client_log(body: ClientLog, user: User = CurrentUser):
    """Browser-side diagnostics (upload picker/progress/errors) so phone problems show up in the server log."""
    log.info("client %s %s %s", user.email, body.event[:40], json.dumps(body.detail, ensure_ascii=False)[:1500])
    return {"ok": True}


@app.get("/api/health")
async def health():
    return {"ok": True, "model": config.ANTHROPIC_MODEL, "elevenlabs": bool(config.ELEVENLABS_API_KEY)}
