"""Lakeze Editor API: auth, projects, uploads, chat turns streamed over SSE, asset files."""
import asyncio
import json
import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, select

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from . import config, pricing
from .admin import router as admin_router
from .agent import analyze
from .agent.runner import TurnRunner
from .auth import CurrentUser, check_pw, clear_session, hash_pw, set_session
from .oauth import router as oauth_router
from .pipeline import footage
from .db import (GB, Asset, CreditTx, Message, Project, Session, Share, ShareComment, Store, Usage, User, add_credits, asset_dict,
                 backfill_sizes, backfill_versions, balance, has_paid, init_db, storage_quota_bytes, storage_state, storage_used)
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
                uu.storage_plan = "free"
            await s.commit()
    return {"renewed": renewed, "lapsed": lapsed}


async def _storage_loop():
    while True:
        try:
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
    """Owner of the share link a new user arrived through, or None."""
    token = (token or "").strip()[:64]
    if not token:
        return None
    async with Session() as s:
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
            "provider": user.provider or None, "name": user.display_name,
            "test_account": user.email in config.TEST_EMAILS}   # purchases are credited directly, no payment


def _is_test(user: User) -> bool:
    return user.email in config.TEST_EMAILS


async def _can_clone(user: User) -> bool:
    return pricing.has_feature(user.subscription, pricing.OWN_VOICE, paying=await has_paid(user.id))


# ---- own voice (instant clone) -------------------------------------------------------------------
def _custom_voice(u: User) -> dict | None:
    if not u.voice_id:
        return None
    return {"voice_id": u.voice_id, "name": u.voice_name or "我的聲音", "gender": None, "description": "你自己的聲音", "preview_url": None, "custom": True}


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
            "features": s.get("features", []),
            "period_start": u.sub_period_start.isoformat() if u.sub_period_start else None,
            "renews_at": u.sub_renews_at.isoformat() if u.sub_renews_at else None}


async def _expire_subscription_points(u: User) -> int:
    """End of a subscription period: whatever is left of that period's included points expires.
    Charges during the period are attributed to the included points first, so top-up points
    (which never expire) are only touched after the included ones are used up."""
    if not u.subscription or not u.sub_period_start:
        return 0
    granted = pricing.SUBSCRIPTIONS.get(u.subscription, {}).get("points", 0)
    start = u.sub_period_start if u.sub_period_start.tzinfo else u.sub_period_start.replace(tzinfo=timezone.utc)
    async with Session() as s:
        used = -int((await s.execute(select(func.coalesce(func.sum(CreditTx.delta), 0))
                                     .where(CreditTx.user_id == u.id, CreditTx.kind == "charge", CreditTx.created_at >= start))).scalar() or 0)
    expire = min(max(0, granted - used), await balance(u.id))
    if expire > 0:
        await add_credits(u.id, -expire, "expire", "expire", meta={"plan": u.subscription, "granted": granted, "used": used})
    return expire


async def activate_subscription(user_id: str, plan_id: str, *, paid_twd: int = 0, meta: dict | None = None) -> dict:
    """Start (or renew) a subscription period: expire the previous period's leftover, grant this
    period's points, bundle the storage. Called by the payment webhook or by an admin."""
    sub = pricing.SUBSCRIPTIONS[plan_id]
    now = datetime.now(timezone.utc)
    async with Session() as s:
        u = await s.get(User, user_id)
    if not u:
        raise HTTPException(404, "user not found")
    expired = await _expire_subscription_points(u)
    await add_credits(user_id, sub["points"], "subscription", f"subscription {plan_id}", amount_twd=paid_twd,
                      meta={"plan": plan_id, **(meta or {})})
    async with Session() as s:
        u = await s.get(User, user_id)
        u.subscription = plan_id
        u.sub_period_start = now
        u.sub_renews_at = now + timedelta(days=pricing.SUBSCRIPTION_PERIOD_DAYS)
        if pricing.STORAGE_PLANS[sub["storage_plan"]]["gb"] >= storage_quota_bytes(u) // GB or u.storage_plan == "free":
            u.storage_plan = sub["storage_plan"]
            u.storage_renews_at = None   # bundled: the storage loop never charges it
        await s.commit()
    return {"expired": expired, "granted": sub["points"], "subscription": _sub_dict(u)}


async def cancel_subscription(user_id: str) -> dict:
    """End the subscription now: leftover included points expire, storage goes back to free."""
    async with Session() as s:
        u = await s.get(User, user_id)
    if not u or not u.subscription:
        return {"expired": 0}
    expired = await _expire_subscription_points(u)
    async with Session() as s:
        u = await s.get(User, user_id)
        u.subscription = ""; u.sub_period_start = None; u.sub_renews_at = None
        if u.storage_renews_at is None:   # storage came with the subscription
            u.storage_plan = "free"
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
        packs.append({"id": pid, **p, "checkout_url": config.CHECKOUT_URLS.get(pid),
                      "member_checkout_url": {"sub5": config.CHECKOUT_URLS.get(pid + "m"), "sub15": config.CHECKOUT_URLS.get(pid + "m2")}})
    subs = [{**s, "checkout_url": config.CHECKOUT_URLS.get(s["id"])} for s in pricing.public_pricing()["subscriptions"]]
    return {**pricing.public_pricing(), "menu": [{"item": i, "points": p} for i, p in pricing.MENU],
            "free_revision_turns": pricing.FREE_REVISION_TURNS, "packs": packs, "subscriptions": subs,
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
            bal = await add_credits(user.id, pack["points"], "purchase", f"test {pack_id}", amount_twd=0, meta={"test": True})
            return {"url": None, "test": True, "granted": pack["points"], "balance": bal}
        raise HTTPException(404, "unknown pack")
    if pack_id in pricing.PACKS and user.subscription:   # member checkout: p500m (專業旅人 rate) / p500m2 (超級玩家 rate)
        key = pack_id + ("m2" if user.subscription == "sub15" else "m")
        if config.CHECKOUT_URLS.get(key):
            pack_id = key
    url = config.CHECKOUT_URLS.get(pack_id)   # packs, member packs and subscriptions share the map
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
    event = ev.get("meta", {}).get("event_name")
    if event not in ("order_created", "subscription_payment_success"):
        return {"ignored": True}
    attrs = ev["data"]["attributes"]
    order_id = str(ev["data"]["id"])
    user_id = (ev["meta"].get("custom_data") or {}).get("user_id")
    variant = str((attrs.get("first_order_item") or {}).get("variant_id") or (attrs.get("first_subscription_item") or {}).get("variant_id")
                  or attrs.get("variant_id"))
    plan_id = config.LS_VARIANTS.get(variant) or ""
    member = ""   # which plan's rate a member pack was bought at
    for suffix, sub_id in (("m2", "sub15"), ("m", "sub5")):
        if plan_id.endswith(suffix) and plan_id[: -len(suffix)] in pricing.PACKS:
            member, plan_id = sub_id, plan_id[: -len(suffix)]
            break
    if not user_id or not plan_id or (plan_id not in pricing.PACKS and plan_id not in pricing.SUBSCRIPTIONS):
        log.warning("webhook: unmapped %s %s variant=%s user=%s", event, order_id, variant, user_id)
        return {"ignored": True}
    async with Session() as s:  # idempotent on order / invoice id
        dup = (await s.execute(select(CreditTx).where(CreditTx.meta.contains(f'"order_id": "{event}:{order_id}"')))).first()
    if dup:
        return {"duplicate": True}
    meta = {"order_id": f"{event}:{order_id}", "total": attrs.get("total"), "currency": attrs.get("currency")}
    if plan_id in pricing.SUBSCRIPTIONS:
        await activate_subscription(user_id, plan_id, paid_twd=pricing.SUBSCRIPTIONS[plan_id]["twd"], meta=meta)
        return {"ok": True, "subscription": plan_id}
    pack = pricing.PACKS[plan_id]
    await add_credits(user_id, pack["points"], "purchase", f"lemonsqueezy {plan_id}{' member' if member else ''}",
                      amount_twd=pack["member_twd"][member] if member else pack["twd"], meta={**meta, "member": member})
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
            items = await asyncio.to_thread(footage.list_drive_folder, body.drive_url.strip(), root)
            await asyncio.to_thread(footage.download_drive, items, root)
        except Exception as e:
            raise HTTPException(400, f"Drive 資料夾讀不到：{str(e)[:200]}")
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


@app.get("/api/projects/{project_id}/frame/{n}")
async def frame(project_id: str, n: int, t: float = 0.0, user: User = CurrentUser):
    """One frame of clip #n at second t (cached), for the storyboard the analysis shows."""
    await _own(project_id, user)
    root = project_dir(project_id)
    try:
        rel = footage.load_index(root)[n]
    except (FileNotFoundError, KeyError):
        raise HTTPException(404, "no such clip")
    t = max(0.0, min(float(t), 36000.0))
    dest = root / "sheets" / "frames" / f"{n:02d}_{t:.1f}.jpg"
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(ff.ffmpeg, "-ss", f"{t:.2f}", "-i", str(root / "raw" / rel), "-frames:v", "1",
                                "-vf", "scale=-2:360", "-q:v", "4", str(dest))
    return FileResponse(dest, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


def _comment_dict(c: ShareComment, sh: Share | None = None, project_name: str | None = None) -> dict:
    d = {"id": c.id, "project_id": c.project_id, "name": c.name, "text": c.text, "created_at": c.created_at.isoformat(),
         "read": c.read_at is not None, "owner": bool(c.owner), "version": sh.version if sh else None, "share_note": sh.note if sh else ""}
    if project_name is not None:
        d["project_name"] = project_name
    return d


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
    _uploads[uid] = {"project": project_id, "name": name, "size": body.size, "received": 0, "part": part}
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
    if offset > st["received"]:
        raise HTTPException(409, f"gap: have {st['received']}, got offset {offset}")
    # offset < received happens when the browser retries a chunk whose response was lost: overwrite in place
    size = offset
    with open(st["part"], "r+b") as w:
        w.seek(offset)
        async for piece in request.stream():
            size += len(piece)
            if size > st["size"]:
                w.close(); st["part"].unlink(missing_ok=True); _uploads.pop(upload_id, None)
                raise HTTPException(413, "more bytes than announced")
            w.write(piece)
    st["received"] = max(st["received"], size)
    return {"received": st["received"]}


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
    runner = TurnRunner(project_id, project_dir(project_id), Store(user.id), _broadcast(project_id))
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
            "brand": {"name": "人客多", "tagline": "專業旅遊剪輯 AI"}, "versions": _share_versions(sh, p, assets),
            "signup_url": f"/signup?ref={sh.token}", "signup_points": pricing.SIGNUP_POINTS, **await _thread(p.id)}


async def _thread(project_id: str) -> dict:
    """The public conversation under a shared video: every friend's message and the owner's replies,
    oldest first, capped at THREAD_LIMIT per project."""
    async with Session() as s:
        rows = (await s.execute(select(ShareComment).where(ShareComment.project_id == project_id)
                                .order_by(ShareComment.id).limit(THREAD_LIMIT))).scalars().all()
    return {"comments": [{"id": c.id, "name": c.name, "text": c.text, "created_at": c.created_at.isoformat(), "owner": bool(c.owner)} for c in rows],
            "comments_limit": THREAD_LIMIT, "comments_full": len(rows) >= THREAD_LIMIT}


@app.get("/api/s/{token}/comments")
async def share_thread(token: str):
    _sh, p = await _share_by_token(token)
    return await _thread(p.id)


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
        n = (await s.execute(select(func.count(ShareComment.id)).where(ShareComment.project_id == p.id))).scalar()
        if n >= THREAD_LIMIT:
            raise HTTPException(409, f"這支影片的留言已達 {THREAD_LIMIT} 則上限，沒辦法再留了")
        c = ShareComment(project_id=p.id, share_id=sh.id, name=body.name.strip()[:80], text=text_[:2000])
        s.add(c)
        await s.commit()
    return {"ok": True, "comment": {"id": c.id, "name": c.name, "text": c.text, "created_at": c.created_at.isoformat(), "owner": False}}


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
            out.append({"voice_id": v["voice_id"], "name": name.strip(), "gender": v.get("gender"),
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
