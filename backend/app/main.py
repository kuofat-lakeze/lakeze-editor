"""Lakeze Editor API: auth, projects, uploads, chat turns streamed over SSE, asset files."""
import asyncio
import json
import logging
import re
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, select

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from . import config, payuni, pricing, quick
from .admin import router as admin_router
from .agent import analyze, tools
from .agent.runner import TurnRunner
from .auth import CurrentUser, check_pw, clear_session, hash_pw, set_session
from .oauth import router as oauth_router
from .pipeline import footage
from .db import (GB, Asset, CreditTx, Message, Order, Project, Session, Share, ShareComment, Store, Usage, User, add_credits, asset_dict,
                 backfill_sizes, backfill_versions, balance, deliverable_expiry, get_setting, has_paid, init_db, storage_quota_bytes, storage_state, storage_used)
from .pipeline import eleven, ff
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


async def renew_storage_plans(now: datetime | None = None) -> dict:
    """Charge every paid storage plan whose period has ended. A user who can't pay drops to the free
    plan: files stay, but exports are blocked while usage is above the free quota."""
    now = now or datetime.now(timezone.utc)
    renewed, lapsed = 0, 0
    async with Session() as s:
        due = (await s.execute(select(User).where(User.storage_plan != "free", User.storage_renews_at <= now))).scalars().all()
    for u in due:
        plan = pricing.STORAGE_PLANS.get(u.storage_plan)
        if not plan or not plan["points"]:
            continue
        if await balance(u.id) >= plan["points"]:
            await add_credits(u.id, -plan["points"], "charge", "storage", meta={"plan": u.storage_plan, "renewal": True})
            nxt = (u.storage_renews_at or now) + timedelta(days=pricing.STORAGE_PERIOD_DAYS)
            renewed += 1
        else:
            nxt = None
            lapsed += 1
            log.info("storage: %s lapsed from %s (balance too low)", u.email, u.storage_plan)
        async with Session() as s:
            uu = await s.get(User, u.id)
            uu.storage_renews_at = nxt
            if nxt is None:
                uu.storage_plan = "free"; uu.storage_free_since = now
            await s.commit()
    return {"renewed": renewed, "lapsed": lapsed}


async def purge_free_deliverables(now: datetime | None = None) -> dict:
    """Free plan: deliverables live FREE_RETENTION_DAYS. Remove the expired ones (files + rows),
    revoke share links to the versions that are gone, and unset a final version that disappeared."""
    now = now or datetime.now(timezone.utc)
    removed, freed = 0, 0
    async with Session() as s:
        rows = (await s.execute(select(Asset, Project, User).join(Project, Project.id == Asset.project_id)
                                .join(User, User.id == Project.user_id).where(Asset.version.is_not(None)))).all()
        gone: dict[str, set[int]] = {}
        for a, p, u in rows:
            exp = deliverable_expiry(u, a.created_at)
            if exp is None or exp > now:
                continue
            f = project_dir(p.id) / a.rel_path
            if f.exists():
                freed += f.stat().st_size
                f.unlink()
            await s.delete(a)
            removed += 1
            gone.setdefault(p.id, set()).add(a.version)
        left = {(pid, v) for a, p, u in rows if (pid := p.id) in gone and (v := a.version) in gone[pid]
                and (exp := deliverable_expiry(u, a.created_at)) is not None and exp > now}
        for pid, vs in gone.items():
            vs = {v for v in vs if (pid, v) not in left}   # a version is gone only when none of its files are left
            for sh in (await s.execute(select(Share).where(Share.project_id == pid, Share.version.in_(vs)))).scalars().all():
                sh.revoked = True
            p = await s.get(Project, pid)
            if p.final_version in vs:
                p.final_version = None
        await s.commit()
    return {"removed": removed, "freed_bytes": freed}


async def _storage_loop():
    while True:
        try:
            r = await purge_free_deliverables()
            if r["removed"]:
                log.info("free retention: removed %d deliverables (%d MB)", r["removed"], r["freed_bytes"] >> 20)
            r = await renew_storage_plans()
            if r["renewed"] or r["lapsed"]:
                log.info("storage renewals: %s", r)
            n = await lapse_subscriptions()
            if n:
                log.info("subscriptions lapsed: %d", n)
        except Exception:
            log.exception("storage/subscription renewal failed")
        await asyncio.sleep(3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    try:   # the NT$ price of a point is an admin setting (dashboard → 定價)
        v = await get_setting("point_twd")
        if v:
            pricing.apply_point_price(float(v))
    except Exception:
        log.exception("loading point price failed; using the default")
    try:
        n = await backfill_versions()
        if n:
            log.info("backfilled version on %d legacy deliverable assets", n)
        n = await backfill_sizes()
        if n:
            log.info("backfilled size on %d assets", n)
    except Exception:
        log.exception("deliverable backfill failed")
    try:
        await asyncio.to_thread(ensure_fonts)
    except Exception as e:  # fonts can be fetched later; don't block startup
        log.warning("font download failed: %s", e)
    try:   # accounts listed as admins get the flag even if they registered before being listed
        async with Session() as s:
            rows = (await s.execute(select(User).where(User.email.in_(list(config.ADMIN_EMAILS)), User.is_admin.is_(False)))).scalars().all()
            for u in rows:
                u.is_admin = True
            if rows:
                await s.commit()
                log.info("promoted %d admin(s): %s", len(rows), ", ".join(u.email for u in rows))
    except Exception:
        log.exception("admin promotion failed")
    tasks = [asyncio.create_task(_storage_loop())]
    if config.RAW_RETENTION_DAYS > 0:
        tasks.append(asyncio.create_task(_cleanup_loop()))
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Lakeze Editor", lifespan=lifespan)
app.include_router(admin_router)
app.include_router(oauth_router)

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
    ref: str = ""   # share-page token the person came from (朋友推薦)


async def referrer_from_share(token: str) -> str | None:
    """Owner of the share link a new user arrived through (ref=<share token>), or the person whose personal
    推薦連結 it was (ref=u-<user id>), or None."""
    token = (token or "").strip()[:64]
    if not token:
        return None
    async with Session() as s:
        if token.startswith("u-"):
            u = await s.get(User, token[2:])
            return u.id if u and not u.disabled else None
        sh = (await s.execute(select(Share).where(Share.token == token))).scalar_one_or_none()
        if not sh:
            return None
        p = await s.get(Project, sh.project_id)
        return p.user_id if p else None


@app.post("/api/auth/signup")
async def signup(c: Creds, request: Request):
    if not config.ALLOW_SIGNUP:
        raise HTTPException(403, "signup disabled")
    if len(c.password) < 8:
        raise HTTPException(400, "密碼至少 8 碼")
    async with Session() as s:
        if (await s.execute(select(User).where(User.email == c.email.lower()))).scalar_one_or_none():
            raise HTTPException(409, "email 已註冊")
        u = User(email=c.email.lower(), pw_hash=hash_pw(c.password), is_admin=c.email.lower() in config.ADMIN_EMAILS,
                 referrer_id=await referrer_from_share(c.ref))
        s.add(u)
        await s.commit()
    await add_credits(u.id, pricing.SIGNUP_POINTS, "grant", "signup", meta={"welcome": True})   # 註冊送點
    resp = JSONResponse({"id": u.id, "email": u.email})
    set_session(resp, u.id, request.url.scheme == "https", request.headers.get("host"))
    return resp


@app.post("/api/auth/login")
async def login(c: Creds, request: Request):
    async with Session() as s:
        u = (await s.execute(select(User).where(User.email == c.email.lower()))).scalar_one_or_none()
        if u and u.email in config.ADMIN_EMAILS and not u.is_admin:
            u.is_admin = True
            await s.commit()
    if u and not u.pw_hash:   # signed up with Google / Facebook: no password on file
        raise HTTPException(401, f"這個帳號是用 {'Google' if u.provider == 'google' else 'Facebook'} 註冊的，請按上方按鈕登入")
    if not u or not check_pw(c.password, u.pw_hash):
        raise HTTPException(401, "email 或密碼錯誤")
    if u.disabled:
        raise HTTPException(403, "帳號已停用")
    resp = JSONResponse({"id": u.id, "email": u.email})
    set_session(resp, u.id, request.url.scheme == "https", request.headers.get("host"))
    return resp


@app.post("/api/auth/logout")
async def logout(request: Request):
    resp = JSONResponse({"ok": True})
    clear_session(resp, request.headers.get("host"))
    return resp


@app.get("/api/me")
async def me(user: User = CurrentUser):
    if user.disabled:
        raise HTTPException(403, "帳號已停用")
    return {"id": user.id, "email": user.email, "is_admin": user.is_admin, "balance": await balance(user.id),
            "free_project_id": user.free_project_id, "storage": await storage_state(user.id),
            "subscription": _sub_dict(user), "can_clone_voice": await _can_clone(user),
            "tier": (tier := user.subscription or ("payg" if await has_paid(user.id) else "free")),
            "voice": {"voice_id": user.voice_id, "name": user.voice_name or "我的聲音"} if user.voice_id else None,
            # on the free tier the clone may narrate up to TRIAL_VOICE_SECONDS of speech
            "voice_trial": {"used": round(user.voice_trial_seconds or 0.0, 1), "limit": pricing.TRIAL_VOICE_SECONDS} if tier == "free" else None,
            "provider": user.provider or None, "name": user.display_name, "ui_mode": user.ui_mode or "pro",
            "test_account": user.email in config.TEST_EMAILS}   # purchases are credited directly, no payment


@app.get("/api/referral")
async def referral(user: User = CurrentUser):
    """推薦好友: the personal link, what a friend is worth right now, and how each referred friend is doing."""
    async with Session() as s:
        friends = (await s.execute(select(User).where(User.referrer_id == user.id).order_by(User.created_at.desc()))).scalars().all()
        ids = [f.id for f in friends]
        ex = dict((await s.execute(select(Project.user_id, func.coalesce(func.sum(Project.exports), 0)).where(Project.user_id.in_(ids)).group_by(Project.user_id))).all()) if ids else {}
        paid = dict((await s.execute(select(CreditTx.reason, CreditTx.delta).where(CreditTx.user_id == user.id, CreditTx.reason.like("referral %")))).all())
    def mask(e: str) -> str:
        name, _, dom = e.partition("@")
        return f"{name[:2]}{'＊' * max(1, min(4, len(name) - 2))}@{dom}"
    rows = [{"email": mask(f.email), "name": (f.display_name or "")[:20] or None, "joined_at": f.created_at.isoformat(),
             "made_video": int(ex.get(f.id, 0) or 0) > 0, "points": paid.get(f"referral {f.id}")} for f in friends]
    return {"link": f"/signup?ref=u-{user.id}", "points": pricing.REFERRAL_POINTS, "points_sub": pricing.REFERRAL_POINTS_SUB,
            "subscribed": bool(user.subscription), "earned": sum(p for p in paid.values() if p), "friends": rows,
            "signup_points": pricing.SIGNUP_POINTS, "fb_app_id": config.FACEBOOK_APP_ID or None}


class ModeBody(BaseModel):
    mode: str


@app.patch("/api/me/mode")
async def set_mode(body: ModeBody, user: User = CurrentUser):
    """輕鬆模式 / 導演模式 is an account setting, so it follows the person across devices."""
    if body.mode not in ("easy", "pro"):
        raise HTTPException(400, "mode 要是 easy 或 pro")
    async with Session() as s:
        u = await s.get(User, user.id)
        u.ui_mode = body.mode
        await s.commit()
    return {"ui_mode": body.mode}


def _is_test(user: User) -> bool:
    return user.email in config.TEST_EMAILS


async def _can_clone(user: User) -> bool:
    return pricing.has_feature(user.subscription, pricing.OWN_VOICE, paying=await has_paid(user.id))


# ---- own voice (instant clone) -------------------------------------------------------------------
PREVIEW_LINE = "嗨，這是我用自己的聲音配的旁白。推開窗就是一整片海，今晚就來住一晚吧！"


def _custom_voice(u: User) -> dict | None:
    if not u.voice_id:
        return None
    v = u.voice_id[-6:]   # cache-buster: a re-recorded voice gets a new id
    return {"voice_id": u.voice_id, "name": u.voice_name or "我的聲音", "gender": None, "description": "你自己的聲音",
            "preview_url": f"/api/voice/clone/preview?v={v}", "sample_url": f"/api/voice/clone/sample?v={v}", "custom": True}


async def _clone_preview(u: User) -> Path:
    """A short line in the cloned voice, made once per voice (re-recording replaces it)."""
    d = config.DATA_DIR / "voices" / u.id
    dest = d / f"preview_{u.voice_id}.mp3"
    if not dest.exists():
        d.mkdir(parents=True, exist_ok=True)
        for old in d.glob("preview_*.mp3"):
            old.unlink(missing_ok=True)
        await asyncio.to_thread(eleven.tts_line, PREVIEW_LINE, u.voice_id, dest)
    return dest


@app.get("/api/voice/clone/preview")
async def clone_preview(user: User = CurrentUser):
    if not user.voice_id:
        raise HTTPException(404, "還沒有自己的聲音")
    try:
        f = await _clone_preview(user)
    except Exception as e:
        raise HTTPException(502, f"試聽生成失敗：{str(e)[:160]}")
    return FileResponse(f, media_type="audio/mpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/voice/clone/sample")
async def clone_sample(user: User = CurrentUser):
    """The user's own recording the clone was made from."""
    f = config.DATA_DIR / "voices" / user.id / "sample.mp3"
    if not user.voice_id or not f.exists():
        raise HTTPException(404, "找不到原始錄音")
    return FileResponse(f, media_type="audio/mpeg", headers={"Cache-Control": "private, no-cache"})


@app.post("/api/voice/clone")
async def clone_voice(file: UploadFile, name: str = Form("我的聲音"), user: User = CurrentUser):
    """Make (or replace) the user's own narration voice from one recording. Subscription feature."""
    if not await _can_clone(user):
        raise HTTPException(403, "這個方案不能用自己的聲音配音")
    d = config.DATA_DIR / "voices" / user.id
    d.mkdir(parents=True, exist_ok=True)
    suffix = Path(file.filename or "sample.webm").suffix.lower() or ".webm"
    raw = d / f"sample_raw{suffix}"
    size = 0
    with open(raw, "wb") as w:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > 60 << 20:
                raise HTTPException(413, "錄音檔超過 60 MB")
            w.write(chunk)
    mp3 = d / "sample.mp3"
    try:
        await asyncio.to_thread(ff.ffmpeg, "-y", "-i", str(raw), "-vn", "-ac", "1", "-ar", "44100", "-b:a", "128k", str(mp3))
        dur = await asyncio.to_thread(ff.duration, mp3)
    except Exception as e:
        raise HTTPException(400, f"讀不懂這個聲音檔：{str(e)[:200]}")
    if dur < 20:
        raise HTTPException(400, f"錄音只有 {dur:.0f} 秒，請至少錄 30 秒（越長越像）")
    if dur > 600:
        raise HTTPException(400, "錄音請在 10 分鐘內")
    label = (name or "我的聲音").strip()[:40] or "我的聲音"
    if user.voice_id:
        try:
            await asyncio.to_thread(eleven.delete_voice, user.voice_id)
        except Exception:
            pass
    try:
        vid = await asyncio.to_thread(eleven.add_voice, f"{label} · {user.email}", mp3, "旅剪 用戶自訂聲音")
    except Exception as e:
        raise HTTPException(502, f"聲音建立失敗：{str(e)[:200]}")
    async with Session() as s:
        u = await s.get(User, user.id)
        u.voice_id, u.voice_name = vid, label
        await s.commit()
    try:   # make the preview now so 「試聽」 plays at once
        await _clone_preview(u)
    except Exception:
        log.warning("clone preview failed for %s", user.id)
    return {"ok": True, "voice": _custom_voice(u), "seconds": round(dur)}


@app.delete("/api/voice/clone")
async def delete_clone(user: User = CurrentUser):
    if user.voice_id:
        try:
            await asyncio.to_thread(eleven.delete_voice, user.voice_id)
        except Exception:
            pass
    async with Session() as s:
        u = await s.get(User, user.id)
        u.voice_id, u.voice_name = None, None
        await s.commit()
    return {"ok": True}


# ---- subscriptions ------------------------------------------------------------------------------
def _sub_dict(u: User) -> dict | None:
    if not u.subscription or u.subscription not in pricing.SUBSCRIPTIONS:
        return None
    s = pricing.SUBSCRIPTIONS[u.subscription]
    return {"id": u.subscription, "label": s["label"], "points": s["points"], "videos": s["videos"], "storage_gb": s["storage_gb"],
            "base": s.get("base", u.subscription), "billing": s.get("billing", "month"), "point_twd": s.get("point_twd"),
            "features": s.get("features", []),
            "period_start": u.sub_period_start.isoformat() if u.sub_period_start else None,
            "renews_at": u.sub_renews_at.isoformat() if u.sub_renews_at else None}


async def activate_subscription(user_id: str, plan_id: str, *, paid_twd: int = 0, meta: dict | None = None) -> dict:
    """Start (or renew) a subscription period: grant this period's points (unused points from earlier
    periods stay; nothing expires), bundle the storage. Called by the payment webhook or by an admin."""
    sub = pricing.SUBSCRIPTIONS[plan_id]
    now = datetime.now(timezone.utc)
    async with Session() as s:
        u = await s.get(User, user_id)
    if not u:
        raise HTTPException(404, "user not found")
    expired = 0   # unused points carry over: nothing expires when a period ends or a plan is cancelled
    await add_credits(user_id, sub["points"], "subscription", f"subscription {plan_id}", amount_twd=paid_twd,
                      meta={"plan": plan_id, **(meta or {})})
    async with Session() as s:
        u = await s.get(User, user_id)
        # renewing early (PAYUNi is paid per period) adds the new 30 days after the current ones, so nothing is lost
        cur = u.sub_renews_at if u.sub_renews_at is None or u.sub_renews_at.tzinfo else u.sub_renews_at.replace(tzinfo=timezone.utc)
        start = cur if (u.subscription == plan_id and cur and cur > now) else now
        u.subscription = plan_id
        u.sub_period_start = start
        u.sub_renews_at = start + timedelta(days=sub.get("period_days", pricing.SUBSCRIPTION_PERIOD_DAYS))
        if pricing.STORAGE_PLANS[sub["storage_plan"]]["gb"] >= storage_quota_bytes(u) // GB or u.storage_plan == "free":
            u.storage_plan = sub["storage_plan"]
            u.storage_renews_at = None   # bundled: the storage loop never charges it
        await s.commit()
    return {"expired": expired, "granted": sub["points"], "subscription": _sub_dict(u)}


async def cancel_subscription(user_id: str) -> dict:
    """End the subscription now: the points stay with the user, storage goes back to free."""
    async with Session() as s:
        u = await s.get(User, user_id)
    if not u or not u.subscription:
        return {"expired": 0}
    expired = 0   # unused points carry over: nothing expires when a period ends or a plan is cancelled
    async with Session() as s:
        u = await s.get(User, user_id)
        u.subscription = ""; u.sub_period_start = None; u.sub_renews_at = None
        if u.storage_renews_at is None:   # storage came with the subscription
            u.storage_plan = "free"
        u.storage_free_since = datetime.now(timezone.utc)   # free retention starts counting now, not from creation
        await s.commit()
    return {"expired": expired}


async def lapse_subscriptions(now: datetime | None = None) -> int:
    """Subscriptions whose renewal payment didn't arrive within the grace period end."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=pricing.SUBSCRIPTION_GRACE_DAYS)
    async with Session() as s:
        due = (await s.execute(select(User).where(User.subscription != "", User.sub_renews_at <= cutoff))).scalars().all()
    for u in due:
        log.info("subscription: %s lapsed from %s", u.email, u.subscription)
        await cancel_subscription(u.id)
    return len(due)


# ---- deliverable storage ---------------------------------------------------------------------
def _plan_dict(pid: str) -> dict:
    p = pricing.STORAGE_PLANS[pid]
    return {"id": pid, "gb": p["gb"], "extra_gb": p["extra"], "points": p["points"], "label": p["label"],
            "twd": p["points"] * pricing.POINT_TWD}


@app.get("/api/storage")
async def storage_summary(user: User = CurrentUser):
    """Deliverable storage: usage against quota, per-project breakdown, plans."""
    st = await storage_state(user.id)
    async with Session() as s:
        rows = (await s.execute(select(Project.id, Project.name, Project.final_version, func.coalesce(func.sum(Asset.size_bytes), 0),
                                       func.count(func.distinct(Asset.version)))
                                .join(Asset, Asset.project_id == Project.id).where(Project.user_id == user.id, Asset.version.is_not(None))
                                .group_by(Project.id).order_by(func.sum(Asset.size_bytes).desc()))).all()
    return {**st, "balance": await balance(user.id), "period_days": pricing.STORAGE_PERIOD_DAYS,
            "raw_retention_days": config.RAW_RETENTION_DAYS, "override_gb": user.storage_quota_gb,
            "plans": [_plan_dict(k) for k in pricing.STORAGE_PLANS],
            "projects": [{"id": i, "name": n, "final_version": fv, "bytes": int(b), "versions": int(v)} for i, n, fv, b, v in rows]}


class PlanBody(BaseModel):
    plan: str


@app.post("/api/storage/plan")
async def set_storage_plan(body: PlanBody, user: User = CurrentUser):
    """Switch plan. A paid plan is charged now and renews every 30 days; moving to free takes effect
    immediately (no refund for the rest of the period, files are never deleted)."""
    plan = pricing.STORAGE_PLANS.get(body.plan)
    if not plan:
        raise HTTPException(404, "unknown plan")
    async with Session() as s:
        cur = await s.get(User, user.id)
    if body.plan == cur.storage_plan:
        return {"ok": True, "storage": await storage_state(user.id)}
    if cur.subscription and plan["gb"] <= pricing.STORAGE_PLANS[pricing.SUBSCRIPTIONS[cur.subscription]["storage_plan"]]["gb"]:
        raise HTTPException(400, "訂閱方案已內含這個空間")
    now = datetime.now(timezone.utc)
    if plan["points"]:
        bal = await balance(user.id)
        if bal < plan["points"]:
            raise HTTPException(402, f"點數不足：此方案每月 {plan['points']} 點，目前 {bal} 點")
        await add_credits(user.id, -plan["points"], "charge", "storage", meta={"plan": body.plan, "renewal": False})
    async with Session() as s:
        u = await s.get(User, user.id)
        u.storage_plan = body.plan
        u.storage_renews_at = (now + timedelta(days=pricing.STORAGE_PERIOD_DAYS)) if plan["points"] else None
        if not plan["points"]:
            u.storage_free_since = now
        await s.commit()
    return {"ok": True, "storage": await storage_state(user.id), "balance": await balance(user.id)}


@app.delete("/api/projects/{project_id}/versions/{version}")
async def delete_version(project_id: str, version: int, user: User = CurrentUser):
    """Remove one deliverable version (videos + covers) to free storage. The final version must be
    un-marked first so a client link can't suddenly point at nothing."""
    p = await _own(project_id, user)
    if p.final_version == version:
        raise HTTPException(409, "這一版是最終版，先取消最終版再刪除")
    root = project_dir(project_id)
    freed = 0
    async with Session() as s:
        rows = (await s.execute(select(Asset).where(Asset.project_id == project_id, Asset.version == version))).scalars().all()
        if not rows:
            raise HTTPException(404, "version not found")
        for a in rows:
            f = root / a.rel_path
            if f.exists():
                freed += f.stat().st_size
                f.unlink()
            await s.delete(a)
        shares = (await s.execute(select(Share).where(Share.project_id == project_id, Share.version == version))).scalars().all()
        for sh in shares:
            sh.revoked = True
        await s.commit()
    return {"ok": True, "freed_bytes": freed, "storage": await storage_state(user.id)}


@app.get("/api/pricing")
async def get_pricing():
    packs = []
    for pid, p in pricing.PACKS.items():   # "<pack>m" is the member-price checkout for the same pack
        packs.append({"id": pid, **p, "checkout_url": None, "member_checkout_url": {}})
    subs = [{**s, "checkout_url": None} for s in pricing.public_pricing()["subscriptions"]]
    return {**pricing.public_pricing(), "menu": [{"item": i, "points": p} for i, p in pricing.MENU],
            "free_revision_turns": pricing.FREE_REVISION_TURNS, "packs": packs, "subscriptions": subs,
            "provider_configured": payuni.configured(), "note": config.TOPUP_NOTE}


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
    free_info = None
    if user.free_project_id:
        fp = next((p for p in projects if p.id == user.free_project_id), None)
        if fp:
            st = await Store(user.id).credit_state(fp.id)
            free_info = {"id": fp.id, "name": fp.name, "exports": fp.exports, "in_free": st["in_free"],
                         "free_revisions_left": st["free_revisions_left"]}
    return {
        "balance": balance_now, "purchased": purchased, "refunded": refunded, "used": used, "waived": waived, "free_project": free_info,
        "revision_points": pricing.REVISION_POINTS, "first_video_points": pricing.FIRST_VIDEO_POINTS,
        "categories": [{"id": c, "label": l} for c, l in pricing.CATEGORIES],
        "tool_labels": pricing.TOOL_LABELS,
        "projects": [{"id": p.id, "name": p.name, "exports": p.exports, "revision_turns": p.revision_turns,
                      "free": user.free_project_id == p.id, "updated_at": p.updated_at.isoformat(),
                      **by_proj.get(p.id, {"used": 0, "waived": 0, "by_category": {c: 0 for c, _ in pricing.CATEGORIES}, "by_tool": {}})}
                     for p in projects],
        "daily": [daily.get(d, {"date": d, "used": 0, "waived": 0}) for d in days],
    }


# ---- 付款流程: order → pay (card / transfer) → result ---------------------------------------------------
TOPUP_PREFIX = "pts:"   # 自訂儲值: "pts:<points>"


def _topup_points(item: str) -> int | None:
    if not item.startswith(TOPUP_PREFIX):
        return None
    try:
        n = int(item[len(TOPUP_PREFIX):])
    except ValueError:
        raise HTTPException(400, "點數要是整數")
    if n < pricing.MIN_TOPUP_POINTS:
        raise HTTPException(400, f"最少儲值 {pricing.MIN_TOPUP_POINTS} 點")
    if n > pricing.MAX_TOPUP_POINTS:
        raise HTTPException(400, f"一次最多儲值 {pricing.MAX_TOPUP_POINTS:,} 點")
    return n


def _item(item: str, user: User) -> dict:
    n = _topup_points(item)
    if n is not None:
        t = pricing.topup(n, user.subscription or "")
        plan = f"（{pricing.SUBSCRIPTIONS[t['member']]['label']}價 1 點 NT${t['point_twd']:g}）" if t["member"] else ""
        return {"kind": "pack", "label": f"{n:,} 點" + (f" + 送 {t['bonus']}" if t["bonus"] else "") + plan,
                "points": t["total"], "amount_twd": t["twd"], "list_twd": t["list_twd"], "member": t["member"]}
    if item in pricing.PACKS:
        pk = pricing.PACKS[item]
        member = user.subscription if user.subscription in pk.get("member_bonus", {}) else ""
        extra = pk["member_bonus"][member] if member else 0
        return {"kind": "pack", "label": pk["label"] + (f" + {pricing.SUBSCRIPTIONS[member]['label']}價多 {extra}" if extra else ""), "points": pricing.pack_points(pk, member),
                "amount_twd": pk["twd"], "list_twd": pk["twd"], "member": member}
    if item in pricing.SUBSCRIPTIONS:
        sb = pricing.SUBSCRIPTIONS[item]
        return {"kind": "sub", "label": f"{sb['label']}（{'季繳' if sb.get('billing') == 'quarter' else '月繳'}）", "points": sb["points"], "amount_twd": sb["twd"], "list_twd": sb["payg_twd"], "member": ""}
    raise HTTPException(404, "沒有這個方案")


def _order_note(o: Order) -> dict:
    try:
        return json.loads(o.note or "{}")
    except Exception:
        return {}


def _order_dict(o: Order) -> dict:
    note = _order_note(o)
    return {"id": o.id, "item": o.item, "kind": o.kind, "label": o.label, "points": o.points, "amount_twd": o.amount_twd,
            "method": o.method, "status": o.status, "transfer_ref": o.transfer_ref, "created_at": o.created_at.isoformat(),
            "paid_at": o.paid_at.isoformat() if o.paid_at else None,
            "atm": note.get("atm"), "invoice": note.get("invoice")}


@app.get("/api/pay/methods")
async def pay_methods(item: str = "", user: User = CurrentUser):
    """Which ways to pay are open right now (the confirm page only shows these)."""
    on = payuni.configured()
    return {"card": on, "atm": on, "transfer": bool(config.BANK_TRANSFER), "test": _is_test(user),
            "invoice": on and config.PAYUNI_INVOICE, "note": config.TOPUP_NOTE}


class OrderBody(BaseModel):
    item: str
    method: str = "card"


async def _fulfil(o: Order, meta: dict | None = None) -> None:
    """Credit an order once (idempotent): points for a pack, a period for a subscription."""
    async with Session() as s:
        row = await s.get(Order, o.id)
        if row.status == "paid":
            return
        row.status, row.paid_at = "paid", datetime.now(timezone.utc)
        await s.commit()
    m = {"order": o.id, "method": o.method, **(meta or {})}
    if o.kind == "sub":
        await activate_subscription(o.user_id, o.item, paid_twd=0 if o.method == "test" else o.amount_twd, meta=m)
    else:
        await add_credits(o.user_id, o.points, "purchase", f"{o.method} {o.item}", amount_twd=0 if o.method == "test" else o.amount_twd, meta=m)


@app.post("/api/orders")
async def create_order(body: OrderBody, user: User = CurrentUser):
    it = _item(body.item, user)
    method = "test" if _is_test(user) else body.method
    if method in ("card", "atm") and not payuni.configured():
        raise HTTPException(400, "線上付款尚未開通，請改用其他方式")
    if method == "transfer" and not config.BANK_TRANSFER:
        raise HTTPException(400, "銀行轉帳尚未開通")
    if method not in ("card", "atm", "transfer", "test"):
        raise HTTPException(400, "不支援的付款方式")
    async with Session() as s:
        o = Order(user_id=user.id, item=body.item, kind=it["kind"], label=it["label"], points=it["points"], amount_twd=it["amount_twd"], method=method)
        s.add(o)
        await s.commit()
    nxt: dict = {}
    if method == "test":
        await _fulfil(o, {"test": True})
        o.status = "paid"
    elif method in ("card", "atm"):   # PAYUNi's page: the browser posts this form there
        api_base = f"{config.PUBLIC_URL}/api/pay/payuni"
        nxt = {"form": payuni.upp_form(order_id_=o.id, amount=o.amount_twd, desc=f"旅剪 Tripcut {o.label}", email=user.email, method=method,
                                       return_url=f"{api_base}/return", notify_url=f"{api_base}/notify",
                                       back_url=f"{config.PUBLIC_URL}/pay/result?order={o.id}")}
    else:
        nxt = {"bank": config.BANK_TRANSFER, "amount_twd": o.amount_twd}
    return {"order": _order_dict(o), **nxt}


@app.get("/api/orders/{order_id}")
async def get_order(order_id: str, user: User = CurrentUser):
    async with Session() as s:
        o = await s.get(Order, order_id)
    if not o or o.user_id != user.id:
        raise HTTPException(404, "找不到這筆訂單")
    return {"order": _order_dict(o), "balance": await balance(user.id),
            "bank": config.BANK_TRANSFER if o.method == "transfer" else None}


@app.get("/api/orders")
async def my_orders(user: User = CurrentUser):
    async with Session() as s:
        rows = (await s.execute(select(Order).where(Order.user_id == user.id).order_by(Order.created_at.desc()).limit(50))).scalars().all()
    return [_order_dict(o) for o in rows]


class TransferBody(BaseModel):
    ref: str


@app.post("/api/orders/{order_id}/transfer")
async def report_transfer(order_id: str, body: TransferBody, user: User = CurrentUser):
    """The buyer says 我已轉帳 with the last 5 digits; an admin confirms it in the dashboard."""
    ref = re.sub(r"\s+", "", body.ref)[:20]
    if not ref:
        raise HTTPException(400, "請填帳號末五碼")
    async with Session() as s:
        o = await s.get(Order, order_id)
        if not o or o.user_id != user.id or o.method != "transfer":
            raise HTTPException(404, "找不到這筆訂單")
        if o.status in ("paid", "cancelled"):
            raise HTTPException(409, "這筆訂單已結束")
        o.transfer_ref, o.status = ref, "reported"
        await s.commit()
        d = _order_dict(o)
    log.info("transfer reported: %s order %s NT$%s ref %s", user.email, order_id, d["amount_twd"], ref)
    return {"order": d}


@app.post("/api/orders/{order_id}/cancel")
async def cancel_order(order_id: str, user: User = CurrentUser):
    async with Session() as s:
        o = await s.get(Order, order_id)
        if not o or o.user_id != user.id:
            raise HTTPException(404, "找不到這筆訂單")
        if o.status in ("pending", "reported", "failed"):
            o.status = "cancelled"
            await s.commit()
        d = _order_dict(o)
    return {"order": d}


@app.get("/api/checkout/{pack_id}")
async def checkout(pack_id: str, user: User = CurrentUser):
    """Hosted checkout link with the user id attached so the webhook can credit the right account.
    A subscriber asking for a pack gets the member-price checkout when one is configured.
    Test accounts skip the payment provider: the pack or plan is credited on the spot."""
    if _is_test(user):
        if pack_id in pricing.SUBSCRIPTIONS:
            await activate_subscription(user.id, pack_id, paid_twd=0, meta={"test": True})
            return {"url": None, "test": True, "subscription": pack_id, "balance": await balance(user.id)}
        if pack_id in pricing.PACKS:
            pack = pricing.PACKS[pack_id]
            got = pricing.pack_points(pack, user.subscription)
            bal = await add_credits(user.id, got, "purchase", f"test {pack_id}", amount_twd=0, meta={"test": True, "bonus": got - pack["points"]})
            return {"url": None, "test": True, "granted": got, "balance": bal}
        raise HTTPException(404, "unknown pack")
    raise HTTPException(410, "請從「點數與方案」頁購買")


async def _payuni_apply(d: dict, via: str) -> str | None:
    """Apply a verified PAYUNi result to its order. Returns our order id. Only a paid result credits points;
    an ATM number-issued result stores the account to pay into; failures mark the order failed."""
    oid = payuni.order_id(d.get("MerTradeNo", ""))
    async with Session() as s:
        o = await s.get(Order, oid)
        if not o:
            log.warning("payuni %s: unknown order %s", via, d.get("MerTradeNo"))
            return None
        note = _order_note(o)
        note.setdefault("payuni", {}).update({k: d.get(k) for k in ("TradeNo", "PaymentType", "TradeStatus", "PayTime", "Card4No", "AuthCode") if d.get(k)})
        if (atm := payuni.atm_info(d)):
            note["atm"] = atm
        if (inv := payuni.invoice_info(d)):
            note["invoice"] = inv
        o.note = json.dumps(note, ensure_ascii=False)
        status, trade = d.get("Status", ""), d.get("TradeStatus", "")
        paid = status == "SUCCESS" and trade == "1"
        if paid and str(d.get("TradeAmt", "")).split(".")[0] != str(o.amount_twd):
            log.error("payuni %s: amount mismatch on %s (got %s, want %s)", via, oid, d.get("TradeAmt"), o.amount_twd)
            paid = False
        if not paid and o.status == "pending" and (trade in ("2", "3", "4") or (status and status != "SUCCESS")):
            o.status = "failed"   # declined, cancelled or the ATM account expired
        await s.commit()
    if paid and via == "notify":   # the server-to-server notify is the one that credits
        await _fulfil(o, {"payuni_trade": d.get("TradeNo"), "payment_type": payuni.PAYMENT_TYPES.get(d.get("PaymentType", ""), d.get("PaymentType"))})
    return oid


@app.post("/api/pay/payuni/notify")
async def payuni_notify(request: Request):
    """PAYUNi → us: payment results (card authorised, ATM paid, expired) and invoice notices."""
    from fastapi.responses import PlainTextResponse
    if not payuni.configured():
        raise HTTPException(503, "payuni not configured")
    form = dict(await request.form())
    try:
        d = payuni.parse_result(form)
    except payuni.Invalid as e:
        log.warning("payuni notify rejected: %s", e)
        raise HTTPException(400, "invalid")
    await _payuni_apply(d, "notify")
    return PlainTextResponse("OK")


@app.post("/api/pay/payuni/return")
async def payuni_return(request: Request):
    """The buyer's browser coming back from PAYUNi (a form post): record what it says, then show the result
    page, which keeps polling until the notify has credited the order."""
    form = dict(await request.form())
    oid = ""
    try:
        d = payuni.parse_result(form)
        oid = await _payuni_apply(d, "return") or ""
    except payuni.Invalid as e:
        log.warning("payuni return rejected: %s", e)
    return RedirectResponse(f"/pay/result?order={oid}" if oid else "/pay/result", status_code=303)


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
        await s.commit()
    project_dir(p.id)
    return {"id": p.id, "name": p.name, "free": False}   # the welcome credit replaced the free-project waiver


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str, user: User = CurrentUser):
    p = await _own(project_id, user)
    async with Session() as s:
        msgs = (await s.execute(select(Message).where(Message.project_id == p.id).order_by(Message.id))).scalars()
        assets = (await s.execute(select(Asset).where(Asset.project_id == p.id).order_by(Asset.created_at))).scalars()
        out_msgs = [_public_message(m) for m in msgs]
        comments = (await s.execute(select(ShareComment).where(ShareComment.project_id == p.id).order_by(ShareComment.id))).scalars().all()
        shares = {sh.id: sh for sh in (await s.execute(select(Share).where(Share.project_id == p.id))).scalars()}
        client_comments = [_comment_dict(c, shares.get(c.share_id)) for c in comments]
    st = await Store(user.id).credit_state(p.id)
    an = analyze.load(project_dir(p.id))
    if an:
        an["estimate"] = analyze.estimate(st["balance"])
    return {"id": p.id, "name": p.name, "messages": [m for m in out_msgs if m],
            "assets": [asset_dict(a) for a in assets], "running": project_id in _turns and not _turns[project_id]["task"].done(),
            "credits": st, "final_version": p.final_version, "exports": p.exports, "client_comments": client_comments,
            "analysis": an}


# ---- 先解析素材 ---------------------------------------------------------------------
class AnalyzeBody(BaseModel):
    brief: str = ""
    drive_url: str = ""


def _has_footage(root: Path) -> bool:
    raw = root / "raw"
    return raw.exists() and any(p.is_file() and p.suffix.lower() in footage.VIDEO_EXT + footage.IMAGE_EXT
                                and (raw / ".stills") not in p.parents for p in raw.rglob("*"))


class DriveBody(BaseModel):
    url: str


@app.post("/api/projects/{project_id}/drive/check")
async def drive_check(project_id: str, body: DriveBody, user: User = CurrentUser):
    """Resolve any cloud share link (Google / Dropbox / iCloud / OneDrive / direct) without downloading,
    so the wizard can confirm it works and show what's inside before anything is charged."""
    from .pipeline import links
    await _own(project_id, user)
    url = body.url.strip()
    try:
        r = await asyncio.wait_for(asyncio.to_thread(links.resolve, url, project_dir(project_id)), timeout=90)
    except asyncio.TimeoutError:
        raise HTTPException(504, "讀取連結逾時，請再試一次")
    except links.LinkError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        msg = str(e)
        if "shared" in msg or "empty" in msg or "permission" in msg.lower() or "403" in msg:
            raise HTTPException(400, "打不開這個資料夾。請把分享設定改成「知道連結的使用者」都能檢視，再貼一次。")
        log.warning("link check failed for %s: %s", links.provider(url), msg[:200])
        raise HTTPException(400, f"讀不到這個連結：{msg[:160]}")
    items = r["items"]
    zipped = any(it.get("zip") for it in items)
    media = [it for it in items if it.get("zip") or Path(it["path"]).suffix.lower() in footage.VIDEO_EXT + footage.IMAGE_EXT]
    videos = sum(1 for it in media if Path(it["path"]).suffix.lower() in footage.VIDEO_EXT)
    return {"ok": True, "provider": r["provider"], "label": r["label"], "files": len(items), "media": len(media), "videos": videos,
            "photos": len(media) - videos - (1 if zipped else 0), "folder_zip": zipped,
            "names": [Path(it["path"]).name for it in media[:8]], "other": len(items) - len(media)}


@app.post("/api/projects/{project_id}/analyze")
async def analyze_project(project_id: str, body: AnalyzeBody, user: User = CurrentUser):
    """Before the brief is written: selling points, storyboard, narration draft and the point estimate.
    Costs the probe fee once; the agent's own probe_footage is then free for this project."""
    await _own(project_id, user)
    t = _turns.get(project_id)
    if t and not t["task"].done():
        raise HTTPException(409, "剪輯師正在工作中，等這回合結束再解析")
    root = project_dir(project_id)
    if body.drive_url.strip():
        try:
            from .pipeline import links
            r = await asyncio.to_thread(links.resolve, body.drive_url.strip(), root)
            res = await asyncio.to_thread(footage.download_link, r["items"], root)
            if not any(x.startswith("ok") or x.startswith("skip") for x in res):
                raise RuntimeError("沒有任何檔案下載成功")
        except Exception as e:
            raise HTTPException(400, f"雲端連結讀不到：{str(e)[:200]}")
    if not _has_footage(root):
        raise HTTPException(400, "還沒有素材：先上傳影片或照片，或貼 Drive 連結")
    store = Store(user.id)
    ok, bal = await store.charge(project_id, analyze.ANALYZE_POINTS, "probe_footage")
    if not ok:
        return JSONResponse({"detail": f"點數不足：解析需要 {analyze.ANALYZE_POINTS} 點，目前 {bal} 點", "needed": analyze.ANALYZE_POINTS, "balance": bal}, 402)
    try:
        data = await analyze.run(root, body.brief, record_usage=lambda k, u, c, m: store.record_usage(project_id, k, u, c, m))
    except Exception as e:
        log.exception("analyze failed")
        await add_credits(user.id, analyze.ANALYZE_POINTS, "refund", "analyze_failed", project_id=project_id)   # not their fault
        raise HTTPException(500, f"解析失敗，點數已退回：{type(e).__name__}: {str(e)[:200]}")
    data["estimate"] = analyze.estimate(await balance(user.id))
    data["charged"] = analyze.ANALYZE_POINTS
    return data


# ---- 校對台 (導演模式): the latest narration script, a one-line voice check, the revision message ----
SCRIPT_BLOCK_RE = re.compile(r"```(?:旁白|旁白稿|vo|narration)[^\n]*\n([\s\S]*?)```")
SCRIPT_LINE_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*s?\s*[-–~～到]\s*(\d+(?:\.\d+)?)\s*s?\s*[|｜:：·]?\s*(.+?)\s*$")


def _script_lines(body: str) -> list[dict]:
    out, prev = [], 0.0
    for raw in body.split("\n"):
        m = SCRIPT_LINE_RE.match(raw)
        if m:
            out.append({"start": float(m.group(1)), "end": float(m.group(2)), "text": m.group(3).strip("「」\"")})
        elif raw.strip():
            t = raw.strip()
            out.append({"start": prev, "end": round(prev + max(1.2, len(t) / 3.5), 1), "text": t})
        prev = out[-1]["end"] if out else prev
    for i, l in enumerate(out, 1):
        l["n"] = i
    return out


@app.get("/api/projects/{project_id}/script")
async def project_script(project_id: str, user: User = CurrentUser):
    """The newest 旁白 block the editor wrote, plus the voice it used — what the 校對台 starts from."""
    await _own(project_id, user)
    async with Session() as s:
        rows = (await s.execute(select(Message).where(Message.project_id == project_id).order_by(Message.id.desc()))).scalars().all()
    lines: list[dict] = []
    voice_id = ""
    from_plan = quick.script_lines(project_dir(project_id))
    plan = tools.plan_load(project_dir(project_id))
    caps = plan.get("captions") or {}
    comp = plan.get("compose") or {}
    caption_style = caps.get("style", "gold")
    if from_plan:
        lines = from_plan
        voice_id = (tools.plan_load(project_dir(project_id)).get("voice") or {}).get("voice_id", "")
    for m in rows:
        try:
            content = json.loads(m.content)
        except Exception:
            continue
        texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"] if isinstance(content, list) else [str(content)]
        joined = "\n".join(texts)
        if not voice_id and (vm := re.findall(r"voice_id[\s=:：]*([A-Za-z0-9]{10,})", joined)):
            voice_id = vm[-1]
        if not lines and m.role == "assistant":
            blocks = SCRIPT_BLOCK_RE.findall(joined)
            if blocks:
                lines = _script_lines(blocks[-1])
        if lines and voice_id:
            break
    # the owner's own line recordings (R<n>) so the editors can replay them right away (改完馬上聽), also after a reload
    takes: dict[str, str] = {}
    async with Session() as s:
        for a in (await s.execute(select(Asset).where(Asset.project_id == project_id, Asset.kind == "audio").order_by(Asset.created_at))).scalars().all():
            meta = json.loads(a.meta or "{}")
            if meta.get("role") == "line_take" and meta.get("key"):
                takes[meta["key"]] = f"/api/projects/{project_id}/assets/{a.id}"
    shots: list[dict] = []
    recut = False
    try:
        if from_plan and (src := await asyncio.to_thread(quick.shot_sources, project_dir(project_id))):
            shots, recut = src, True    # the 時間軸 can re-cut: originals are still here
        else:
            shots = json.loads((project_dir(project_id) / "work" / "cut.json").read_text())
    except Exception:
        pass
    return {"lines": lines, "voice_id": voice_id or user.voice_id or (config.VOICE_PRESETS[0]["voice_id"] if config.VOICE_PRESETS else ""),
            "say_points": pricing.VOICE_SAMPLE_POINTS, "shots": shots, "quick": bool(from_plan), "caption_style": caption_style,
            "recut": recut, "font": caps.get("font", "black"), "super_style": caps.get("super_style", "chip"), "caption_scale": caps.get("scale", 1.0),
            "supers": [{"i": k, "start": c["start"], "end": c["end"], "text": c["text"].replace("**", "")} for k, c in enumerate(caps.get("supers") or [])],
            "counter": caps.get("counter"), "music": bool(comp.get("music")), "music_gain": comp.get("music_gain", 0.55),
            "speed": next((float(p.get("tempo", 1.0)) for p in comp.get("placements") or []), 1.0),
            "sfx": [{"name": x.get("name"), "at": x.get("at")} for x in comp.get("sfx") or []], "duration": comp.get("duration"), "takes": takes}


class QuickBody(BaseModel):
    lines: list[dict] = []
    shots: list[dict] = []
    order: list[int] | None = None
    supers: list[dict] = []
    font: str | None = None
    super_style: str | None = None
    voice_id: str | None = None
    music_gain: float | None = None
    speed: float | None = None
    caption_scale: float | None = None
    caption_style: str | None = None
    counter_color: str | None = None


@app.post("/api/projects/{project_id}/quick")
async def quick_render(project_id: str, body: QuickBody, user: User = CurrentUser):
    """微調: re-render from the recipe without an editor turn. Charged quietly: 1 點 per re-voiced line and
    1 點 for the render (the render is free on a subscription). Produces a new version."""
    await _own(project_id, user)
    root = project_dir(project_id)
    edits = body.model_dump(exclude_none=True)
    try:
        info = quick.plan_changes(root, edits)
    except quick.QuickError as e:
        raise HTTPException(400, str(e))
    store = Store(user.id)
    st = await store.storage_state()
    if st["over"]:
        raise HTTPException(409, "成品空間已滿，先刪掉舊版本或升級空間")
    export_pts = 0 if user.subscription else pricing.QUICK_EXPORT_POINTS
    line_pts = pricing.QUICK_LINE_POINTS * len(info["revoice"])
    charged: list[tuple[int, str]] = []
    for pts, reason in ((line_pts, "quick_voice"), (export_pts, "quick_export")):
        if pts:
            ok, bal = await store.charge(project_id, pts, reason)
            if not ok:
                for p2, r2 in charged:
                    await add_credits(user.id, p2, "refund", f"{r2}_failed", project_id=project_id)
                return JSONResponse({"detail": f"點數不足：需要 {line_pts + export_pts} 點，目前 {bal} 點", "needed": line_pts + export_pts, "balance": bal}, 402)
            charged.append((pts, reason))
    loop = asyncio.get_running_loop()
    try:
        r = await asyncio.to_thread(quick.render, root, edits, record_usage=lambda k, u, m: asyncio.run_coroutine_threadsafe(
            store.record_usage(project_id, k, u, 0.0, m), loop).result())
    except Exception as e:
        for p2, r2 in charged:
            await add_credits(user.id, p2, "refund", f"{r2}_failed", project_id=project_id)
        log.exception("quick render failed")
        raise HTTPException(502, f"微調失敗，點數已退回：{type(e).__name__}: {str(e)[:200]}")
    sizes = {k: round(p.stat().st_size / 2**20, 1) for k, p in r["files"].items()}
    names = {"master": "母帶", "upload": "上傳用 1080p", "preview": "預覽 720p"}
    for k, p in r["files"].items():
        await store.add_asset(project_id, p, "video", names[k], {"size_mb": sizes[k], "role": k, "deliverable": True, "quick": True})
    await store.note_export(project_id)
    return {"ok": True, "revoiced": r["revoiced"], "charged": sum(p for p, _ in charged), "balance": await balance(user.id)}


@app.post("/api/projects/{project_id}/take")
async def line_take(project_id: str, audio: UploadFile, n: int = Form(...), voice_id: str = Form(""), mode: str = Form("ai"), user: User = CurrentUser):
    """One line read by the owner. Two very different things:
      mode=raw  我親自一句一句配音 — the recording itself becomes that line's narration (key R<n>, free).
      mode=ai   唸給 AI 聽 — speech-to-speech turns it into the video's AI voice, keeping their pronunciation
                (key L<n>, costs a sample line).
    Saved under work/vo so the recipe can place it instead of a generated line."""
    import tempfile
    await _own(project_id, user)
    data = await audio.read()
    if not data:
        raise HTTPException(400, "沒有收到錄音")
    if len(data) > 8 * 2**20:
        raise HTTPException(413, "錄音太大")
    root = project_dir(project_id)
    vo = root / "work" / "vo"
    vo.mkdir(parents=True, exist_ok=True)
    store = Store(user.id)
    if mode == "raw":
        key = f"R{max(1, min(int(n), 99))}"
        try:
            with tempfile.TemporaryDirectory() as td:
                src = Path(td) / ("in" + (Path(audio.filename or "a.webm").suffix or ".webm"))
                src.write_bytes(data)
                wav = Path(td) / "take.wav"
                await asyncio.to_thread(ff.ffmpeg, "-i", str(src), "-vn", "-ac", "1", "-ar", "44100",
                                        "-af", "highpass=f=80,afftdn=nf=-25,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.25,areverse,loudnorm=I=-16:TP=-1.5", str(wav))
                seconds = await asyncio.to_thread(ff.duration, wav)
                if seconds < 0.5:
                    raise HTTPException(400, "錄音太短，再唸一次")
                await asyncio.to_thread(ff.ffmpeg, "-i", str(wav), "-c:a", "libmp3lame", "-b:a", "128k", str(vo / f"{key}.mp3"))
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(502, f"處理錄音失敗：{str(e)[:160]}")
        a = await store.add_asset(project_id, vo / f"{key}.mp3", "audio", f"我親自唸的第 {n} 句", {"role": "line_take", "key": key, "line": int(n), "raw": True})
        return {"key": key, "seconds": round(seconds, 1), "url": a["url"], "balance": await balance(user.id)}
    voice = re.sub(r"[^A-Za-z0-9]", "", voice_id) or user.voice_id or (config.VOICE_PRESETS[0]["voice_id"] if config.VOICE_PRESETS else "")
    if not voice:
        raise HTTPException(400, "沒有可用的聲音")
    key = f"L{max(1, min(int(n), 99))}"
    ok, bal = await store.charge(project_id, pricing.VOICE_SAMPLE_POINTS, "voice_sample")
    if not ok:
        return JSONResponse({"detail": f"點數不足：需要 {pricing.VOICE_SAMPLE_POINTS} 點，目前 {bal} 點", "needed": pricing.VOICE_SAMPLE_POINTS, "balance": bal}, 402)
    try:
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / ("in" + (Path(audio.filename or "a.webm").suffix or ".webm"))
            src.write_bytes(data)
            wav = Path(td) / "take.wav"
            await asyncio.to_thread(ff.ffmpeg, "-i", str(src), "-vn", "-ac", "1", "-ar", "44100", "-af", "highpass=f=80,loudnorm=I=-16:TP=-1.5", str(wav))
            seconds = await asyncio.to_thread(ff.duration, wav)
            if seconds < 0.5:
                raise HTTPException(400, "錄音太短")
            await asyncio.to_thread(eleven.speech_to_speech, wav, voice, vo / f"{key}.mp3")
    except HTTPException:
        await add_credits(user.id, pricing.VOICE_SAMPLE_POINTS, "refund", "take_failed", project_id=project_id)
        raise
    except Exception as e:
        await add_credits(user.id, pricing.VOICE_SAMPLE_POINTS, "refund", "take_failed", project_id=project_id)
        raise HTTPException(502, f"轉換失敗，點數已退回：{str(e)[:160]}")
    a = await store.add_asset(project_id, vo / f"{key}.mp3", "audio", f"我唸的第 {n} 句（已換成影片的聲音）", {"role": "line_take", "key": key, "line": int(n)})
    return {"key": key, "seconds": round(seconds, 1), "url": a["url"], "balance": await balance(user.id)}


class SayBody(BaseModel):
    text: str
    voice_id: str = ""


@app.post("/api/projects/{project_id}/say")
async def project_say(project_id: str, body: SayBody, user: User = CurrentUser):
    """One narration line in a voice, for checking a 唸法 before re-exporting. Costs a voice sample."""
    await _own(project_id, user)
    text = body.text.strip()[:120]
    if not text:
        raise HTTPException(400, "沒有文字")
    voice = re.sub(r"[^A-Za-z0-9]", "", body.voice_id) or user.voice_id or (config.VOICE_PRESETS[0]["voice_id"] if config.VOICE_PRESETS else "")
    if not voice:
        raise HTTPException(400, "沒有可用的聲音")
    root = project_dir(project_id)
    dest = root / "work" / "proof" / f"{hashlib.sha1(f'{voice}|{text}'.encode()).hexdigest()[:16]}.mp3"
    if not dest.exists():
        store = Store(user.id)
        ok, bal = await store.charge(project_id, pricing.VOICE_SAMPLE_POINTS, "voice_sample")
        if not ok:
            return JSONResponse({"detail": f"點數不足：試聽需要 {pricing.VOICE_SAMPLE_POINTS} 點，目前 {bal} 點", "needed": pricing.VOICE_SAMPLE_POINTS, "balance": bal}, 402)
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            await asyncio.to_thread(eleven.tts_line, text, voice, dest)
        except Exception as e:
            await add_credits(user.id, pricing.VOICE_SAMPLE_POINTS, "refund", "say_failed", project_id=project_id)
            raise HTTPException(502, f"試聽生成失敗，點數已退回：{str(e)[:160]}")
    return {"url": f"/api/projects/{project_id}/proof/{dest.name}", "balance": await balance(user.id)}


@app.get("/api/projects/{project_id}/proof/{name}")
async def project_proof_file(project_id: str, name: str, user: User = CurrentUser):
    await _own(project_id, user)
    f = safe_join(project_dir(project_id) / "work" / "proof", name)
    if not f.exists():
        raise HTTPException(404, "not found")
    return FileResponse(f, media_type="audio/mpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/projects/{project_id}/frame/{n}")
async def frame(project_id: str, n: int, t: float = 0.0, hq: int = 0, user: User = CurrentUser):
    """One frame of clip #n at second t (cached), for the storyboard the analysis shows; hq=1 renders it at
    full height for the cover preview."""
    await _own(project_id, user)
    root = project_dir(project_id)
    try:
        rel = footage.load_index(root)[n]
    except (FileNotFoundError, KeyError):
        raise HTTPException(404, "no such clip")
    t = max(0.0, min(float(t), 36000.0))
    dest = root / "sheets" / "frames" / f"{n:02d}_{t:.1f}{'_hq' if hq else ''}.jpg"
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(ff.ffmpeg, "-ss", f"{t:.2f}", "-i", str(root / "raw" / rel), "-frames:v", "1",
                                "-vf", "scale=-2:1080" if hq else "scale=-2:360", "-q:v", "2" if hq else "4", str(dest))
    return FileResponse(dest, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


def _comment_dict(c: ShareComment, sh: Share | None = None, project_name: str | None = None) -> dict:
    d = {"id": c.id, "project_id": c.project_id, "name": c.name, "text": c.text, "created_at": c.created_at.isoformat(),
         "read": c.read_at is not None, "owner": bool(c.owner), "version": sh.version if sh else None, "share_note": sh.note if sh else ""}
    if project_name is not None:
        d["project_name"] = project_name
    return d


# ---- 我自己唸的旁白 (owner-read narration) ------------------------------------------------------------
@app.post("/api/projects/{project_id}/narration")
async def upload_narration(project_id: str, audio: UploadFile, user: User = CurrentUser):
    """The owner reads the script with the teleprompter; the take becomes a voice-over clip the editor
    can place with compose_audio (key MY, MY2, …) instead of generating AI narration."""
    import tempfile
    await _own(project_id, user)
    data = await audio.read()
    if not data:
        raise HTTPException(400, "沒有收到錄音")
    if len(data) > 60 * 2**20:
        raise HTTPException(413, "錄音太大")
    vo = project_dir(project_id) / "work" / "vo"
    vo.mkdir(parents=True, exist_ok=True)
    n = 1
    while (vo / f"MY{'' if n == 1 else n}.wav").exists():
        n += 1
    key = f"MY{'' if n == 1 else n}"
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / ("in" + (Path(audio.filename or "a.webm").suffix or ".webm"))
        src.write_bytes(data)
        try:
            await asyncio.to_thread(ff.ffmpeg, "-i", str(src), "-vn", "-ac", "1", "-ar", "44100", "-af", "highpass=f=80,loudnorm=I=-16:TP=-1.5", str(vo / f"{key}.wav"))
            seconds = await asyncio.to_thread(ff.duration, vo / f"{key}.wav")
        except Exception as e:
            raise HTTPException(400, f"錄音檔讀不了：{str(e)[:120]}")
    if seconds < 1:
        (vo / f"{key}.wav").unlink(missing_ok=True)
        raise HTTPException(400, "錄音太短")
    a = await Store(user.id).add_asset(project_id, vo / f"{key}.wav", "audio", f"我唸的旁白 {key}", {"role": "my_narration", "key": key})
    return {"key": key, "seconds": round(seconds, 1), "asset": a}


# ---- 語音輸入 (server-side speech-to-text) -----------------------------------------------------------
STT_MAX_BYTES = 8 * 2**20
STT_MAX_SECONDS = 90


def _to_traditional(text: str) -> str:
    try:
        from opencc import OpenCC
        return OpenCC("s2twp").convert(text)
    except Exception:
        return text


@app.post("/api/stt")
async def speech_to_text(audio: UploadFile, project_id: str = Form(""), user: User = CurrentUser):
    """The browser records a short clip (MediaRecorder works everywhere, unlike the Web Speech API);
    we transcode it and transcribe with ElevenLabs Scribe. Free for the user; cost is logged."""
    import tempfile
    data = await audio.read()
    if not data:
        raise HTTPException(400, "沒有收到錄音")
    if len(data) > STT_MAX_BYTES:
        raise HTTPException(413, "錄音太長，請分段說")
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / ("in" + (Path(audio.filename or "a.webm").suffix or ".webm"))
        src.write_bytes(data)
        wav = Path(td) / "a.wav"
        try:
            await asyncio.to_thread(ff.ffmpeg, "-i", str(src), "-t", str(STT_MAX_SECONDS), "-ac", "1", "-ar", "16000", str(wav))
            seconds = await asyncio.to_thread(ff.duration, wav)
        except Exception as e:
            raise HTTPException(400, f"錄音檔讀不了：{str(e)[:120]}")
        if seconds < 0.4:
            return {"text": "", "seconds": round(seconds, 1)}
        try:
            tr = await asyncio.to_thread(eleven.transcribe, wav, "zho")
        except Exception as e:
            log.warning("stt failed: %s", e)
            raise HTTPException(502, "語音辨識暫時失敗，請再說一次")
    text_ = _to_traditional((tr.get("text") or "").strip())
    if project_id:
        try:
            await Store(user.id).record_usage(project_id, "elevenlabs_stt_sec", round(seconds), 0.0, {"stt": "voice_input"})
        except Exception:
            pass
    return {"text": text_, "seconds": round(seconds, 1)}


# ---- 朋友的反饋 (feedback inbox) ---------------------------------------------------------------------
@app.get("/api/notifications")
async def notifications(user: User = CurrentUser):
    """Unread feedback across the user's projects, newest first. Polled by the app; nothing here
    interrupts a running turn."""
    async with Session() as s:
        rows = (await s.execute(select(ShareComment, Project.name).join(Project, Project.id == ShareComment.project_id)
                                .where(Project.user_id == user.id, ShareComment.read_at.is_(None))
                                .order_by(ShareComment.id.desc()).limit(50))).all()
        total = (await s.execute(select(func.count(ShareComment.id)).join(Project, Project.id == ShareComment.project_id)
                                 .where(Project.user_id == user.id))).scalar()
    items = [_comment_dict(c, None, name) for c, name in rows]
    by_project: dict[str, int] = {}
    for it in items:
        by_project[it["project_id"]] = by_project.get(it["project_id"], 0) + 1
    return {"unread": len(items), "items": items, "by_project": by_project, "total": int(total or 0)}


THREAD_LIMIT = 100   # messages per project in the public thread (friends + owner replies)


class ReplyBody(BaseModel):
    text: str


@app.post("/api/projects/{project_id}/comments")
async def owner_reply(project_id: str, body: ReplyBody, user: User = CurrentUser):
    """The owner answers in the thread; friends see it on the share page."""
    await _own(project_id, user)
    text_ = body.text.strip()
    if not text_:
        raise HTTPException(400, "留言不能是空的")
    async with Session() as s:
        n = (await s.execute(select(func.count(ShareComment.id)).where(ShareComment.project_id == project_id))).scalar()
        if n >= THREAD_LIMIT:
            raise HTTPException(409, f"這支影片的留言已達 {THREAD_LIMIT} 則上限")
        c = ShareComment(project_id=project_id, share_id="", name=(user.display_name or "影片主人")[:80], text=text_[:2000],
                         owner=True, read_at=datetime.now(timezone.utc))
        s.add(c)
        await s.commit()
    return _comment_dict(c)


@app.post("/api/projects/{project_id}/comments/read")
async def mark_comments_read(project_id: str, user: User = CurrentUser):
    await _own(project_id, user)
    async with Session() as s:
        rows = (await s.execute(select(ShareComment).where(ShareComment.project_id == project_id, ShareComment.read_at.is_(None)))).scalars().all()
        for c in rows:
            c.read_at = datetime.now(timezone.utc)
        await s.commit()
    return {"ok": True, "marked": len(rows)}


def _public_message(m: Message) -> dict | None:
    """Flatten API content blocks into what the UI shows: user text, assistant text, tool calls."""
    blocks = json.loads(m.content)
    parts = []
    for b in blocks:
        t = b.get("type")
        if t == "text" and b.get("text", "").strip() and not b["text"].startswith(ANALYSIS_TAG):
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
        if dest.exists():  # same file name picked twice (phones do this): keep both, suffix the new one
            stem, suffix, k = dest.stem, dest.suffix, 2
            while dest.exists():
                dest = dest.with_name(f"{stem}_{k}{suffix}"); k += 1
            name = dest.name
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


# Chunked uploads. Railway's edge closes any request whose body takes longer than 5 minutes to
# arrive, which a 1 GB clip on mobile data never makes in one request. The browser sends the file
# in small pieces (one request each, each retried on its own); the server appends them to a part
# file and renames it into raw/uploads on completion. State is in memory plus the part file; a
# backend restart means the browser starts that file over.
_UPLOAD_ID = re.compile(r"^[0-9a-f]{16}$")
_uploads: dict[str, dict] = {}  # upload_id -> {project, name, size, received, part}


class UploadBegin(BaseModel):
    name: str
    size: int


def _unique_dest(root: Path, name: str) -> Path:
    dest = safe_join(root, f"raw/uploads/{name}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():  # same file name picked twice (phones do this): keep both, suffix the new one
        stem, suffix, k = dest.stem, dest.suffix, 2
        while dest.exists():
            dest = dest.with_name(f"{stem}_{k}{suffix}"); k += 1
    return dest


@app.post("/api/projects/{project_id}/upload/begin")
async def upload_begin(project_id: str, body: UploadBegin, user: User = CurrentUser):
    await _own(project_id, user)
    if body.size <= 0:
        raise HTTPException(400, "empty file")
    if body.size > config.MAX_UPLOAD_MB << 20:
        raise HTTPException(413, f"超過 {config.MAX_UPLOAD_MB}MB")
    root = project_dir(project_id)
    uid = secrets.token_hex(8)
    part = safe_join(root, f"raw/uploads/.part/{uid}")
    part.parent.mkdir(parents=True, exist_ok=True)
    part.write_bytes(b"")
    name = _SAFE.sub("_", Path(body.name or "clip.mp4").name) or "clip.mp4"
    _uploads[uid] = {"project": project_id, "name": name, "size": body.size, "received": 0, "part": part, "parts": {}}
    return {"upload_id": uid, "received": 0}


def _upload_state(project_id: str, upload_id: str) -> dict:
    st = _uploads.get(upload_id) if _UPLOAD_ID.match(upload_id) else None
    if not st or st["project"] != project_id:
        raise HTTPException(404, "upload not found, start again")
    return st


@app.put("/api/projects/{project_id}/upload/{upload_id}/chunk")
async def upload_chunk(project_id: str, upload_id: str, offset: int, request: Request, user: User = CurrentUser):
    await _own(project_id, user)
    st = _upload_state(project_id, upload_id)
    # Chunks arrive in parallel and in any order (the browser sends a few at once): each is written at its
    # own offset. A retried chunk (its response got lost) simply overwrites the same bytes.
    if offset < 0 or offset >= st["size"]:
        raise HTTPException(409, f"offset {offset} outside 0..{st['size']}")
    size = offset
    with open(st["part"], "r+b") as w:
        w.seek(offset)
        async for piece in request.stream():
            size += len(piece)
            if size > st["size"]:
                w.close(); st["part"].unlink(missing_ok=True); _uploads.pop(upload_id, None)
                raise HTTPException(413, "more bytes than announced")
            w.write(piece)
    st["parts"][offset] = size - offset
    st["received"] = _covered(st["parts"])
    return {"received": st["received"]}


def _covered(parts: dict[int, int]) -> int:
    """Bytes covered by the received chunks (overlaps counted once)."""
    total, end = 0, 0
    for off, n in sorted(parts.items()):
        if off + n > end:
            total += off + n - max(off, end)
            end = off + n
    return total


@app.post("/api/projects/{project_id}/upload/{upload_id}/complete")
async def upload_complete(project_id: str, upload_id: str, user: User = CurrentUser):
    await _own(project_id, user)
    st = _upload_state(project_id, upload_id)
    if st["received"] != st["size"]:
        raise HTTPException(409, f"incomplete: {st['received']}/{st['size']}")
    dest = _unique_dest(project_dir(project_id), st["name"])
    st["part"].rename(dest)
    _uploads.pop(upload_id, None)
    return {"saved": [{"name": dest.name, "mb": round(st["size"] / 2**20, 1)}]}


def _forget_footage_index(root: Path) -> None:
    """Clip numbers come from the sorted file list, so removing a file renumbers everything after it:
    drop the index, thumbnails, contact sheets and the 先解析 result; the next probe rebuilds them."""
    sheets = root / "sheets"
    for f in [sheets / "index.tsv", sheets / "analysis.json", *sheets.glob("sheet*.jpg")]:
        f.unlink(missing_ok=True)
    shutil.rmtree(sheets / "thumbs", ignore_errors=True)


@app.delete("/api/projects/{project_id}/uploads/{name}")
async def delete_upload(project_id: str, name: str, user: User = CurrentUser):
    """Remove one uploaded clip or photo (the user changed their mind after it finished uploading)."""
    await _own(project_id, user)
    if project_id in _turns and not _turns[project_id]["task"].done():
        raise HTTPException(409, "剪輯師正在工作，等這一輪結束再刪素材")
    root = project_dir(project_id)
    if name != _SAFE.sub("_", Path(name).name) or name.startswith("."):
        raise HTTPException(400, "bad name")
    f = safe_join(root, f"raw/uploads/{name}")
    if not f.is_file():
        raise HTTPException(404, "找不到這個素材，可能已經刪掉了")
    f.unlink()
    (root / "raw" / ".stills" / f"{f.stem}.mp4").unlink(missing_ok=True)   # a photo's rendered clip
    _forget_footage_index(root)
    return {"ok": True, "has_footage": _has_footage(root)}


# ---- chat ----------------------------------------------------------------------------
class Turn(BaseModel):
    text: str
    with_analysis: bool = False   # first message after 「先解析素材」: hand the agent the plan the user saw


ANALYSIS_TAG = "[先前解析結果]"


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
    runner = TurnRunner(project_id, project_dir(project_id), Store(user.id), _broadcast(project_id), ui_mode=user.ui_mode or "pro")
    blocks = [{"type": "text", "text": body.text}]
    if body.with_analysis and (an := analyze.load(project_dir(project_id))):
        blocks.append({"type": "text", "text": analyze.as_brief(an)})   # hidden from the thread (see _public_message)

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
VERSION_WORDS = ["初版", "第二版", "第三版", "第四版", "第五版", "第六版", "第七版", "第八版", "第九版", "第十版"]


def version_label(n: int) -> str:
    return VERSION_WORDS[n - 1] if 1 <= n <= len(VERSION_WORDS) else f"第 {n} 版"


def _version_names(p: Project) -> dict[int, str]:
    try:
        return {int(k): v for k, v in json.loads(p.version_names or "{}").items()}
    except Exception:
        return {}


def _versions(assets: list[Asset], owner: User | None = None, names: dict[int, str] | None = None, project_name: str = "") -> list[dict]:
    """Group deliverable assets (exports + covers) by version, newest first. On the free plan each
    version carries `expires_at`: when its first file is removed by the free retention. `name` is the
    version's display name (the owner's, or 專案名_初版), also used as the download filename."""
    by: dict[int, dict] = {}
    for a in assets:
        if a.version is None:
            continue
        v = by.setdefault(a.version, {"version": a.version, "label": version_label(a.version), "created_at": a.created_at.isoformat(), "videos": [], "covers": [], "expires_at": None,
                                      "name": (names or {}).get(a.version) or f"{project_name}_{version_label(a.version)}".strip("_")})
        exp = deliverable_expiry(owner, a.created_at)
        if exp is not None and (v["expires_at"] is None or exp.isoformat() < v["expires_at"]):
            v["expires_at"] = exp.isoformat()
        d = asset_dict(a)
        (v["covers"] if a.kind == "image" else v["videos"]).append(d)
        v["created_at"] = max(v["created_at"], a.created_at.isoformat())
    for v in by.values():
        order = {"upload": 0, "master": 1, "preview": 2}
        v["videos"].sort(key=lambda x: order.get(x.get("role") or "", 9))
        v["main"] = next((x for x in v["videos"] if x.get("role") == "upload"), v["videos"][0] if v["videos"] else None)
        chosen = next((c for c in v["covers"] if (c.get("meta") or {}).get("poster")), v["covers"][-1] if v["covers"] else None)
        v["poster"] = chosen["url"] if chosen else None   # the cover shown on the video before it plays
    return [by[k] for k in sorted(by, reverse=True)]


def _share_dict(sh: Share) -> dict:
    return {"id": sh.id, "token": sh.token, "url": f"/s/{sh.token}", "version": sh.version, "allow_download": sh.allow_download,
            "note": sh.note, "expires_at": sh.expires_at.isoformat() if sh.expires_at else None, "revoked": sh.revoked,
            "views": sh.views, "created_at": sh.created_at.isoformat(), "fb_app_id": config.FACEBOOK_APP_ID or None}


class PosterBody(BaseModel):
    asset_id: str


class VersionNameBody(BaseModel):
    name: str


@app.patch("/api/projects/{project_id}/versions/{version}")
async def rename_version(project_id: str, version: int, body: VersionNameBody, user: User = CurrentUser):
    """Give a version its own name (shown on the 成品 page and used as the download filename)."""
    await _own(project_id, user)
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", body.name).strip()[:80]
    async with Session() as s:
        p = await s.get(Project, project_id)
        names = _version_names(p)
        if name:
            names[version] = name
        else:
            names.pop(version, None)
        p.version_names = json.dumps({str(k): v for k, v in names.items()}, ensure_ascii=False)
        await s.commit()
    return {"ok": True, "name": name or f"{p.name}_{version_label(version)}"}


@app.post("/api/projects/{project_id}/versions/{version}/poster")
async def set_poster(project_id: str, version: int, body: PosterBody, user: User = CurrentUser):
    """Use one of a version's covers as its video's poster (deliverables page, gallery, share page)."""
    await _own(project_id, user)
    async with Session() as s:
        covers = (await s.execute(select(Asset).where(Asset.project_id == project_id, Asset.version == version,
                                                      Asset.kind == "image"))).scalars().all()
        if body.asset_id not in {a.id for a in covers}:
            raise HTTPException(404, "這一版沒有這張封面")
        for a in covers:
            m = json.loads(a.meta or "{}")
            m["poster"] = a.id == body.asset_id
            a.meta = json.dumps(m, ensure_ascii=False)
        await s.commit()
    return {"ok": True}


@app.get("/api/projects/{project_id}/deliverables")
async def deliverables(project_id: str, user: User = CurrentUser):
    p = await _own(project_id, user)
    async with Session() as s:
        assets = (await s.execute(select(Asset).where(Asset.project_id == p.id).order_by(Asset.created_at))).scalars().all()
        shares = (await s.execute(select(Share).where(Share.project_id == p.id).order_by(Share.created_at.desc()))).scalars().all()
    return {"project": {"id": p.id, "name": p.name, "final_version": p.final_version, "exports": p.exports},
            "versions": _versions(assets, user, _version_names(p), p.name), "shares": [_share_dict(x) for x in shares]}


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
    vs = _versions(assets, None, _version_names(p), p.name)
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
            "brand": {"name": "人客多", "tagline": "專業旅遊剪輯 AI"}, "versions": _share_versions(sh, p, assets),
            "signup_url": f"/signup?ref={sh.token}", "signup_points": pricing.SIGNUP_POINTS, "fb_app_id": config.FACEBOOK_APP_ID or None,
            **await _thread(p.id)}


async def _thread(project_id: str) -> dict:
    """The public conversation under a shared video: every friend's message and the owner's replies,
    oldest first, capped at THREAD_LIMIT per project."""
    async with Session() as s:
        rows = (await s.execute(select(ShareComment).where(ShareComment.project_id == project_id)
                                .order_by(ShareComment.id).limit(THREAD_LIMIT))).scalars().all()
    return {"comments": [{"id": c.id, "name": c.name, "text": c.text, "created_at": c.created_at.isoformat(), "owner": bool(c.owner), "parent_id": c.parent_id} for c in rows],
            "comments_limit": THREAD_LIMIT, "comments_full": len(rows) >= THREAD_LIMIT}


@app.get("/api/s/{token}/comments")
async def share_thread(token: str):
    _sh, p = await _share_by_token(token)
    return await _thread(p.id)


PROMO_TITLE = "{name}｜旅剪 Tripcut"
PROMO_DESC = "15 分鐘剪好的短影音。註冊送 {points} 點，第一支免費。"


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


@app.get("/api/og/s/{token}")
async def share_og(token: str):
    """What Facebook / LINE / Threads crawlers see for a share link (nginx sends bot user agents here):
    Open Graph tags with the cover and the promo copy, then a redirect for anyone else."""
    from fastapi.responses import HTMLResponse
    try:
        sh, p = await _share_by_token(token)
    except HTTPException:
        return HTMLResponse("<!doctype html><title>連結無效</title><p>這個連結已失效。</p>", status_code=404)
    async with Session() as s:
        assets = (await s.execute(select(Asset).where(Asset.project_id == p.id).order_by(Asset.created_at))).scalars().all()
    vers = _share_versions(sh, p, assets)
    cover = next((c for v in vers for c in v["covers"][::-1]), None)
    video = next((v["main"] for v in vers if v.get("main")), None)
    url = f"{config.PUBLIC_URL}/s/{token}"
    title = PROMO_TITLE.format(name=p.name)
    desc = PROMO_DESC.format(points=pricing.SIGNUP_POINTS)
    tags = [f'<meta property="og:title" content="{_esc(title)}">', f'<meta property="og:description" content="{_esc(desc)}">',
            f'<meta property="og:url" content="{_esc(url)}">', '<meta property="og:type" content="video.other">',
            '<meta property="og:site_name" content="旅剪 Tripcut · 人客多 Lakeze">', '<meta property="og:locale" content="zh_TW">',
            '<meta name="twitter:card" content="summary_large_image">', f'<meta name="description" content="{_esc(desc)}">']
    if config.FACEBOOK_APP_ID:
        tags.append(f'<meta property="fb:app_id" content="{_esc(config.FACEBOOK_APP_ID)}">')
    if cover:
        img = f"{config.PUBLIC_URL}{cover['url']}"   # already the public /api/s/<token>/file/<id> form
        tags += [f'<meta property="og:image" content="{_esc(img)}">', '<meta property="og:image:width" content="1080">', '<meta property="og:image:height" content="1920">']
    if video:
        vid = f"{config.PUBLIC_URL}{video['url']}"
        tags += [f'<meta property="og:video" content="{_esc(vid)}">', '<meta property="og:video:type" content="video/mp4">']
    html = ("<!doctype html><html lang=\"zh-Hant\"><head><meta charset=\"utf-8\">" f"<title>{_esc(title)}</title>" + "".join(tags)
            # no <meta refresh>: Facebook's crawler follows it back to /s/<token> and loses the tags; people get a JS redirect
            + f'<script>location.replace({json.dumps(url)})</script></head><body><a href="{_esc(url)}">{_esc(title)}</a></body></html>')
    return HTMLResponse(html, headers={"Cache-Control": "public, max-age=300"})


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
    nice = _download_name(p, a, path.suffix)
    return FileResponse(path, filename=nice if download else None, content_disposition_type="attachment" if download else "inline")


class CommentBody(BaseModel):
    name: str = ""
    text: str
    parent_id: int | None = None


@app.post("/api/s/{token}/comment")
async def share_comment(token: str, body: CommentBody):
    sh, p = await _share_by_token(token)
    text_ = body.text.strip()
    if not text_:
        raise HTTPException(400, "留言不能是空的")
    async with Session() as s:
        n = (await s.execute(select(func.count(ShareComment.id)).where(ShareComment.project_id == p.id))).scalar()
        if n >= THREAD_LIMIT:
            raise HTTPException(409, f"這支影片的留言已達 {THREAD_LIMIT} 則上限，沒辦法再留了")
        parent = None
        if body.parent_id:
            parent = await s.get(ShareComment, body.parent_id)
            if not parent or parent.project_id != p.id:
                raise HTTPException(404, "要回覆的留言不存在")
            if parent.parent_id:   # one level deep: a reply to a reply goes under the same top comment
                parent = await s.get(ShareComment, parent.parent_id)
        c = ShareComment(project_id=p.id, share_id=sh.id, name=body.name.strip()[:80], text=text_[:2000], parent_id=parent.id if parent else None)
        s.add(c)
        await s.commit()
    return {"ok": True, "comment": {"id": c.id, "name": c.name, "text": c.text, "created_at": c.created_at.isoformat(), "owner": False, "parent_id": c.parent_id}}


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
                    "cover": next((c for c in v["covers"] if c["url"] == v.get("poster")), v["covers"][-1] if v["covers"] else None), "video": v.get("main"), "updated_at": p.updated_at.isoformat()})
    return out


# ---- assets -----------------------------------------------------------------------------
def _download_name(p: Project, a: Asset, suffix: str) -> str:
    """版本名稱 as the filename: the main video is just the name; other files add their own label."""
    if a.version is None:
        return a.name + suffix if not a.name.endswith(suffix) else a.name
    base = _version_names(p).get(a.version) or f"{p.name}_{version_label(a.version)}"
    meta = json.loads(a.meta or "{}")
    if a.kind == "video" and meta.get("role") == "upload":
        tail = ""
    else:
        tail = "_" + a.name
    return f"{base}{tail}{suffix}".replace("/", "-")


@app.get("/api/projects/{project_id}/assets/{asset_id}")
async def asset_file(project_id: str, asset_id: str, user: User = CurrentUser):
    p0 = await _own(project_id, user)
    async with Session() as s:
        a = await s.get(Asset, asset_id)
    if not a or a.project_id != project_id:
        raise HTTPException(404)
    p = safe_join(project_dir(project_id), a.rel_path)
    return FileResponse(p, filename=_download_name(p0, a, p.suffix))


_voices_cache: dict = {"at": 0.0, "data": []}


# 聲音用中文名字；只有美式／英式口音的才留英文名。Library 的名字是英文（"Kuo Yu"），所以沒設定的
# 從名字池裡依性別挑一個，用 voice_id 決定，同一個聲音每次都是同一個名字。
_VOICE_POOL = {"female": ["小晴", "雅婷", "欣怡", "語彤", "佳穎", "品妍"], "male": ["阿哲", "志豪", "承恩", "冠宇", "家豪", "柏翰"]}
_WESTERN = re.compile(r"american|british|australian|美式|英式|英文|us accent|uk accent", re.I)


def _voice_display_name(v: dict, fallback: str, taken: list[str]) -> str:
    if v["voice_id"] in config.VOICE_NAMES:
        return config.VOICE_NAMES[v["voice_id"]]
    if re.search(r"[\u4e00-\u9fff]", fallback):   # already Chinese
        return fallback
    if _WESTERN.search(f"{v.get('accent') or ''} {v.get('description') or ''} {v.get('name') or ''}"):
        return fallback
    pool = _VOICE_POOL["male" if (v.get("gender") or "").lower() == "male" else "female"]
    start = int(hashlib.sha1(v["voice_id"].encode()).hexdigest(), 16) % len(pool)
    for i in range(len(pool)):
        n = pool[(start + i) % len(pool)]
        if n not in taken:
            return n
    return fallback


@app.get("/api/voices")
async def voices(user: User = CurrentUser):
    """Voices the UI offers up front: configured presets first, then Taiwanese-accent voices from the
    Voice Library, each with a preview clip. Cached for an hour."""
    import time
    mine = [_custom_voice(user)] if user.voice_id else []
    if time.time() - _voices_cache["at"] < 3600 and _voices_cache["data"]:
        return mine + _voices_cache["data"]
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
            out.append({"voice_id": v["voice_id"], "name": _voice_display_name(v, name.strip(), [x["name"] for x in out]), "gender": v.get("gender"),
                        "description": (tail or v.get("description") or "")[:40], "preview_url": v.get("preview_url")})
            seen.add(v["voice_id"])
    _voices_cache.update(at=time.time(), data=out)
    return mine + out


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
    """Liveness plus the pieces a customer's edit depends on: ffmpeg, the CJK fonts, the voice API, HEIC decoding."""
    import importlib.util
    import shutil
    fonts = config.FONTS_DIR.exists() and any(f.stat().st_size > 100_000 for f in config.FONTS_DIR.glob("*.otf"))
    return {"ok": True, "model": config.ANTHROPIC_MODEL, "elevenlabs": bool(config.ELEVENLABS_API_KEY),
            "ffmpeg": shutil.which("ffmpeg") is not None, "fonts": fonts, "heic": importlib.util.find_spec("pillow_heif") is not None}
