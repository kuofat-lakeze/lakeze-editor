"""Back office / CRM: dashboard aggregates, user list with lifetime numbers, user detail, manual
credit grants, subscriptions, tags and notes, CSV export."""
import csv
import io
import json
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, select

from . import pricing, railway_cost
from .auth import current_user
from .db import Asset, CreditTx, set_setting, Message, Order, Project, Session, Usage, User, add_credits, now, storage_quota_bytes

router = APIRouter(prefix="/api/admin")
log = logging.getLogger("lakeze.admin")
TWD_PER_USD = pricing.TWD_PER_USD


async def admin_user(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(403, "admin only")
    return user


Admin = Depends(admin_user)


def _utc(d: datetime | None) -> datetime | None:
    if d is not None and d.tzinfo is None:   # SQLite hands back naive UTC
        return d.replace(tzinfo=timezone.utc)
    return d


def _iso(d: datetime | None) -> str | None:
    return _utc(d).isoformat() if d else None


def _day(d: datetime) -> str:
    return _utc(d).date().isoformat()


STAGES = {"disabled": "停用", "sub": "訂閱中", "paid": "付費用戶", "churn": "流失風險", "trial_done": "做過影片未付費",
          "trial": "試用中", "new": "註冊未使用"}


def _stage(u: User, *, purchases: int, exports: int, projects: int, last: datetime | None, ref: datetime) -> str:
    if u.disabled:
        return "disabled"
    if u.subscription:
        return "sub"
    if purchases:
        return "churn" if (last is None or ref - _utc(last) > timedelta(days=30)) else "paid"
    if exports:
        return "trial_done"
    if projects:
        return "trial"
    return "new"


# ---- dashboard ---------------------------------------------------------------------------------------
@router.get("/dashboard")
async def dashboard(days: int = 30, _: User = Admin):
    days = max(7, min(365, days))
    ref = now()
    since = ref - timedelta(days=days)
    prev_since = since - timedelta(days=days)
    async with Session() as s:
        users = (await s.execute(select(User))).scalars().all()
        tx = (await s.execute(select(CreditTx).where(CreditTx.created_at >= prev_since))).scalars().all()
        usage = (await s.execute(select(Usage.user_id, Usage.kind, Usage.cost_usd, Usage.created_at).where(Usage.created_at >= prev_since))).all()
        proj_rows = (await s.execute(select(Project.user_id, func.count(Project.id), func.sum(Project.exports), func.max(Project.updated_at))
                                     .group_by(Project.user_id))).all()
        purchases = (await s.execute(select(CreditTx.user_id, func.count(CreditTx.id), func.sum(CreditTx.amount_twd), func.max(CreditTx.created_at))
                                     .where(CreditTx.kind == "purchase").group_by(CreditTx.user_id))).all()
        bal_rows = (await s.execute(select(CreditTx.user_id, func.sum(CreditTx.delta)).group_by(CreditTx.user_id))).all()
        totals = (await s.execute(select(func.coalesce(func.sum(CreditTx.amount_twd), 0)).where(CreditTx.kind == "purchase"))).scalar()
        used_total = -(await s.execute(select(func.coalesce(func.sum(CreditTx.delta), 0)).where(CreditTx.kind == "charge"))).scalar()
        cost_total = (await s.execute(select(func.coalesce(func.sum(Usage.cost_usd), 0.0)))).scalar()
        exports_total = (await s.execute(select(func.coalesce(func.sum(Project.exports), 0)))).scalar()
        msgs = (await s.execute(select(Project.user_id, func.count(Message.id)).join(Message, Message.project_id == Project.id)
                                .where(Message.role == "user", Message.created_at >= since).group_by(Project.user_id))).all()
    by_user_proj = {uid: (n or 0, ex or 0, last) for uid, n, ex, last in proj_rows}
    by_user_pur = {uid: (n or 0, twd or 0, last) for uid, n, twd, last in purchases}
    balance = {uid: int(b or 0) for uid, b in bal_rows}
    active_users = {uid for uid, n in msgs if n}
    # period vs previous period
    def in_period(d, start, end):
        return start <= _utc(d) < end

    def agg(start, end):
        rev = sum(t.amount_twd for t in tx if t.kind == "purchase" and in_period(t.created_at, start, end))
        used = -sum(t.delta for t in tx if t.kind == "charge" and in_period(t.created_at, start, end))
        waived = sum(t.points_waived for t in tx if t.kind == "charge" and in_period(t.created_at, start, end))
        sold = sum(t.delta for t in tx if t.kind == "purchase" and in_period(t.created_at, start, end))
        granted = sum(t.delta for t in tx if t.kind == "grant" and in_period(t.created_at, start, end))
        exports = sum(1 for t in tx if t.kind == "charge" and t.reason == "export_video" and in_period(t.created_at, start, end))
        cost = sum(c or 0 for _, _, c, d in usage if in_period(d, start, end))
        signups = sum(1 for u in users if in_period(u.created_at, start, end))
        buyers = len({t.user_id for t in tx if t.kind == "purchase" and in_period(t.created_at, start, end)})
        return {"revenue_twd": int(rev), "points_used": int(used), "points_waived": int(waived), "points_sold": int(sold),
                "points_granted": int(granted), "exports": exports, "cost_usd": round(cost, 2), "cost_twd": round(cost * TWD_PER_USD),
                "signups": signups, "buyers": buyers}
    cur, prev = agg(since, ref + timedelta(seconds=1)), agg(prev_since, since)
    # Railway hosting is part of the cost, day by day (both this window and the previous one).
    rw = await railway_cost.cost(days * 2)
    rw_day = {x["date"]: x["usd"] for x in rw.get("daily", [])}
    cur_keys = {(since + timedelta(days=i + 1)).date().isoformat() for i in range(days)}
    rw_cur = sum(v for k, v in rw_day.items() if k in cur_keys) if rw_day else rw["usd"] / 2
    rw_prev = sum(v for k, v in rw_day.items() if k not in cur_keys) if rw_day else rw["usd"] / 2
    for a, v in ((cur, rw_cur), (prev, rw_prev)):
        a["railway_usd"] = round(v, 2)
        a["cost_usd"] = round(a["cost_usd"] + v, 2)
        a["cost_twd"] = round(a["cost_usd"] * TWD_PER_USD)
    cur["active_users"] = len(active_users)
    cur["margin_pct"] = round((cur["revenue_twd"] - cur["cost_twd"]) / cur["cost_twd"] * 100) if cur["cost_twd"] else None
    # daily series
    day_keys = [(since + timedelta(days=i + 1)).date().isoformat() for i in range(days)]
    daily = {k: {"date": k, "signups": 0, "revenue_twd": 0, "points_used": 0, "points_waived": 0, "cost_twd": 0.0, "exports": 0, "active": set()} for k in day_keys}
    for u in users:
        k = _day(u.created_at)
        if k in daily:
            daily[k]["signups"] += 1
    for t in tx:
        k = _day(t.created_at)
        if k not in daily:
            continue
        if t.kind == "purchase":
            daily[k]["revenue_twd"] += t.amount_twd
        if t.kind == "charge":
            daily[k]["points_used"] += -t.delta
            daily[k]["points_waived"] += t.points_waived
            daily[k]["active"].add(t.user_id)
            if t.reason == "export_video":
                daily[k]["exports"] += 1
    for k, v in daily.items():
        v["cost_twd"] += (rw_day.get(k, 0.0) if rw_day else rw_cur / days) * TWD_PER_USD
    for uid, kind, c, d in usage:
        k = _day(d)
        if k in daily:
            daily[k]["cost_twd"] += (c or 0) * TWD_PER_USD
            daily[k]["active"].add(uid)
    series = [{**v, "cost_twd": round(v["cost_twd"]), "active": len(v["active"])} for v in daily.values()]
    # tiers, funnel, categories
    tiers = {"free": 0, "payg": 0, "sub5": 0, "sub15": 0, "disabled": 0}
    for u in users:
        if u.disabled:
            tiers["disabled"] += 1
        elif u.subscription in tiers:
            tiers[u.subscription] += 1
        elif u.id in by_user_pur:
            tiers["payg"] += 1
        else:
            tiers["free"] += 1
    funnel = [("註冊", len(users)), ("建立專案", sum(1 for u in users if by_user_proj.get(u.id, (0, 0, None))[0])),
              ("輸出過影片", sum(1 for u in users if by_user_proj.get(u.id, (0, 0, None))[1])),
              ("付費", sum(1 for u in users if u.id in by_user_pur)), ("訂閱", sum(1 for u in users if u.subscription))]
    cats = defaultdict(int)
    for t in tx:
        if t.kind == "charge" and in_period(t.created_at, since, ref + timedelta(seconds=1)):
            cats[pricing.TOOL_CATEGORY.get(t.reason, "subs")] += -t.delta + t.points_waived
    by_category = [{"id": c, "label": l, "points": cats.get(c, 0)} for c, l in pricing.CATEGORIES]
    mrr = sum(pricing.SUBSCRIPTIONS[u.subscription]["twd"] for u in users if u.subscription in pricing.SUBSCRIPTIONS and not u.disabled)
    # watch lists
    def row(u: User):
        n, ex, last = by_user_proj.get(u.id, (0, 0, None))
        pn, ptwd, plast = by_user_pur.get(u.id, (0, 0, None))
        seen = max([d for d in (last, u.last_seen_at) if d], key=_utc, default=None)
        return {"id": u.id, "email": u.email, "name": u.display_name, "balance": balance.get(u.id, 0), "paid_twd": int(ptwd), "exports": ex,
                "projects": n, "subscription": u.subscription or "", "last_active": _iso(seen),
                "stage": _stage(u, purchases=pn, exports=ex, projects=n, last=seen, ref=ref)}
    rows = [row(u) for u in users if not u.disabled]
    week = ref - timedelta(days=7)
    low_balance = sorted([r for r in rows if r["balance"] < 20 and not r["subscription"] and r["last_active"] and datetime.fromisoformat(r["last_active"]) >= week],
                         key=lambda r: r["balance"])[:8]
    churn = sorted([r for r in rows if r["stage"] == "churn"], key=lambda r: -r["paid_twd"])[:8]
    used_by_user = defaultdict(int)
    for t in tx:
        if t.kind == "charge" and in_period(t.created_at, since, ref + timedelta(seconds=1)):
            used_by_user[t.user_id] += -t.delta + t.points_waived
    by_id = {r["id"]: r for r in rows}
    top = [{**by_id[uid], "points_used": p} for uid, p in sorted(used_by_user.items(), key=lambda x: -x[1])[:8] if uid in by_id]
    recent = [row(u) for u in sorted(users, key=lambda u: _utc(u.created_at), reverse=True)[:8]]
    return {"days": days, "generated_at": ref.isoformat(),
            "totals": {"users": len(users), "paying_users": len(by_user_pur), "subscribers": tiers["sub5"] + tiers["sub15"], "mrr_twd": mrr,
                       "revenue_twd": int(totals or 0), "points_used": int(used_total or 0), "exports": int(exports_total or 0),
                       "cost_usd": round(cost_total or 0, 2), "cost_twd": round((cost_total or 0) * TWD_PER_USD),
                       "conversion_pct": round(len(by_user_pur) / len(users) * 100, 1) if users else 0,
                       "points_outstanding": sum(balance.values())},
            "period": cur, "previous": prev, "daily": series, "tiers": tiers, "funnel": [{"label": l, "n": n} for l, n in funnel],
            "by_category": by_category, "low_balance": low_balance, "churn": churn, "top": top, "recent": recent,
            "stages": STAGES, "point_twd": pricing.POINT_TWD}


# ---- users -------------------------------------------------------------------------------------------
async def _user_rows(q: str = ""):
    ref = now()
    async with Session() as s:
        bal = select(CreditTx.user_id, func.sum(CreditTx.delta).label("bal"), func.sum(CreditTx.points_waived).label("waived")).group_by(CreditTx.user_id).subquery()
        pur = (select(CreditTx.user_id, func.count(CreditTx.id).label("n"), func.sum(CreditTx.amount_twd).label("twd"),
                      func.sum(CreditTx.delta).label("pts"), func.max(CreditTx.created_at).label("last"))
               .where(CreditTx.kind == "purchase").group_by(CreditTx.user_id).subquery())
        gr = select(CreditTx.user_id, func.sum(CreditTx.delta).label("pts")).where(CreditTx.kind == "grant").group_by(CreditTx.user_id).subquery()
        ch = select(CreditTx.user_id, func.sum(CreditTx.delta).label("pts")).where(CreditTx.kind == "charge").group_by(CreditTx.user_id).subquery()
        cost = select(Usage.user_id, func.sum(Usage.cost_usd).label("cost")).group_by(Usage.user_id).subquery()
        proj = select(Project.user_id, func.count(Project.id).label("n"), func.sum(Project.exports).label("ex"),
                      func.sum(Project.revision_turns).label("rv"), func.max(Project.updated_at).label("last")).group_by(Project.user_id).subquery()
        sto = (select(Project.user_id, func.sum(Asset.size_bytes).label("bytes")).join(Asset, Asset.project_id == Project.id)
               .where(Asset.version.is_not(None)).group_by(Project.user_id).subquery())
        stmt = (select(User, bal.c.bal, bal.c.waived, pur.c.n, pur.c.twd, pur.c.pts, pur.c.last, gr.c.pts, ch.c.pts, cost.c.cost,
                       proj.c.n, proj.c.ex, proj.c.rv, proj.c.last, sto.c.bytes)
                .outerjoin(bal, bal.c.user_id == User.id).outerjoin(pur, pur.c.user_id == User.id).outerjoin(gr, gr.c.user_id == User.id)
                .outerjoin(ch, ch.c.user_id == User.id).outerjoin(cost, cost.c.user_id == User.id)
                .outerjoin(proj, proj.c.user_id == User.id).outerjoin(sto, sto.c.user_id == User.id).order_by(User.created_at.desc()))
        if q:
            ql = q.lower()
            stmt = stmt.where((User.email.contains(ql)) | (User.tags.contains(ql)) | (User.note.contains(q)) | (User.display_name.contains(q)))
        rows = (await s.execute(stmt.limit(2000))).all()
    emails = {u.id: u.email for u, *_ in rows}
    out = []
    for u, b, w, pn, ptwd, ppts, plast, gpts, cpts, c, n, e, rv, last, sb in rows:
        seen = max([d for d in (last, u.last_seen_at) if d], key=_utc, default=None)
        used = -int(cpts or 0)
        out.append({"id": u.id, "email": u.email, "name": u.display_name, "provider": u.provider or "", "created_at": _iso(u.created_at),
                    "is_admin": u.is_admin, "disabled": u.disabled, "note": u.note, "tags": [t for t in (u.tags or "").split(",") if t],
                    "balance": int(b or 0), "waived": int(w or 0), "paid_twd": int(ptwd or 0), "purchases": int(pn or 0),
                    "purchased_points": int(ppts or 0), "granted_points": int(gpts or 0), "used_points": used,
                    "last_purchase_at": _iso(plast), "cost_usd": round(c or 0, 2), "cost_twd": round((c or 0) * TWD_PER_USD),
                    "projects": int(n or 0), "exports": int(e or 0), "revision_turns": int(rv or 0),
                    "last_active": _iso(seen), "storage_plan": u.storage_plan or "free", "storage_bytes": int(sb or 0),
                    "storage_quota_bytes": storage_quota_bytes(u), "subscription": u.subscription or "",
                    "sub_renews_at": _iso(u.sub_renews_at), "voice": bool(u.voice_id),
                    "referred_by": emails.get(u.referrer_id or "", u.referrer_id) if u.referrer_id else None,
                    "stage": _stage(u, purchases=int(pn or 0), exports=int(e or 0), projects=int(n or 0), last=seen, ref=ref)})
    return out


@router.get("/users")
async def users(q: str = "", _: User = Admin):
    return await _user_rows(q)


@router.get("/users.csv")
async def users_csv(q: str = "", _: User = Admin):
    rows = await _user_rows(q)
    buf = io.StringIO()
    buf.write("﻿")   # BOM so Excel opens UTF-8 correctly
    w = csv.writer(buf)
    w.writerow(["email", "名稱", "階段", "登入方式", "註冊日", "最近活動", "餘額", "累積儲值 NT$", "購買次數", "買的點數", "送的點數", "已用點數",
                "專案", "影片輸出", "修改輪", "API 成本 NT$", "訂閱", "空間方案", "標籤", "備註"])
    for r in rows:
        w.writerow([r["email"], r["name"] or "", STAGES.get(r["stage"], r["stage"]), r["provider"] or "email", (r["created_at"] or "")[:10],
                    (r["last_active"] or "")[:10], r["balance"], r["paid_twd"], r["purchases"], r["purchased_points"], r["granted_points"],
                    r["used_points"], r["projects"], r["exports"], r["revision_turns"], r["cost_twd"], r["subscription"], r["storage_plan"],
                    " ".join(r["tags"]), r["note"]])
    fname = f"lakeze-users-{now().date().isoformat()}.csv"
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@router.get("/users/{user_id}")
async def user_detail(user_id: str, _: User = Admin):
    ref = now()
    since = ref - timedelta(days=30)
    async with Session() as s:
        u = await s.get(User, user_id)
        if not u:
            raise HTTPException(404)
        tx = (await s.execute(select(CreditTx).where(CreditTx.user_id == user_id).order_by(CreditTx.id.desc()).limit(300))).scalars().all()
        ps = (await s.execute(select(Project).where(Project.user_id == user_id).order_by(Project.updated_at.desc()))).scalars().all()
        pc = dict((await s.execute(select(Usage.project_id, func.sum(Usage.cost_usd)).where(Usage.user_id == user_id)
                                   .group_by(Usage.project_id))).all())
        usage30 = (await s.execute(select(Usage.cost_usd, Usage.created_at).where(Usage.user_id == user_id, Usage.created_at >= since))).all()
        cost_all = (await s.execute(select(func.coalesce(func.sum(Usage.cost_usd), 0.0)).where(Usage.user_id == user_id))).scalar()
        sto = (await s.execute(select(func.coalesce(func.sum(Asset.size_bytes), 0)).join(Project, Project.id == Asset.project_id)
                               .where(Project.user_id == user_id, Asset.version.is_not(None)))).scalar()
        pur_rows = (await s.execute(select(func.count(CreditTx.id), func.sum(CreditTx.amount_twd), func.sum(CreditTx.delta))
                                    .where(CreditTx.user_id == user_id, CreditTx.kind == "purchase"))).one()
        sums = dict((await s.execute(select(CreditTx.kind, func.sum(CreditTx.delta)).where(CreditTx.user_id == user_id).group_by(CreditTx.kind))).all())
        waived = (await s.execute(select(func.coalesce(func.sum(CreditTx.points_waived), 0)).where(CreditTx.user_id == user_id))).scalar()
    ledger = [{"id": t.id, "delta": t.delta, "waived": t.points_waived, "kind": t.kind, "reason": t.reason, "amount_twd": t.amount_twd,
               "project_id": t.project_id, "created_at": _iso(t.created_at), "meta": json.loads(t.meta or "{}")} for t in tx]
    projects = [{"id": p.id, "name": p.name, "exports": p.exports, "revision_turns": p.revision_turns, "final_version": p.final_version,
                 "free": u.free_project_id == p.id, "cost_usd": round(pc.get(p.id, 0) or 0, 2), "created_at": _iso(p.created_at),
                 "updated_at": _iso(p.updated_at)} for p in ps]
    # 30-day activity: points used + cost per day
    keys = [(since + timedelta(days=i + 1)).date().isoformat() for i in range(30)]
    daily = {k: {"date": k, "points": 0, "cost_twd": 0.0} for k in keys}
    cats = defaultdict(int)
    for t in tx:
        if t.kind != "charge":
            continue
        cats[pricing.TOOL_CATEGORY.get(t.reason, "subs")] += -t.delta + t.points_waived
        k = _day(t.created_at)
        if k in daily:
            daily[k]["points"] += -t.delta + t.points_waived
    for c, d in usage30:
        k = _day(d)
        if k in daily:
            daily[k]["cost_twd"] += (c or 0) * TWD_PER_USD
    pn, ptwd, ppts = pur_rows
    paid = int(ptwd or 0)
    cost_twd = round((cost_all or 0) * TWD_PER_USD)
    last = max([d for d in ([p.updated_at for p in ps] + [u.last_seen_at]) if d], key=_utc, default=None)
    async with Session() as s:
        ref_user = await s.get(User, u.referrer_id) if u.referrer_id else None
        referred = (await s.execute(select(User.email).where(User.referrer_id == u.id))).scalars().all()
    return {"id": u.id, "email": u.email, "name": u.display_name, "provider": u.provider or "", "is_admin": u.is_admin, "disabled": u.disabled,
            "note": u.note, "tags": [t for t in (u.tags or "").split(",") if t], "created_at": _iso(u.created_at), "last_active": _iso(last),
            "referred_by": ref_user.email if ref_user else None, "referred": list(referred),
            "subscription": u.subscription or "", "sub_period_start": _iso(u.sub_period_start), "sub_renews_at": _iso(u.sub_renews_at),
            "storage_plan": u.storage_plan or "free", "storage_quota_gb": u.storage_quota_gb, "storage_bytes": int(sto or 0),
            "storage_quota_bytes": storage_quota_bytes(u), "voice": {"voice_id": u.voice_id, "name": u.voice_name} if u.voice_id else None,
            "voice_trial_seconds": round(u.voice_trial_seconds or 0, 1),
            "stage": _stage(u, purchases=int(pn or 0), exports=sum(p.exports for p in ps), projects=len(ps), last=last, ref=ref),
            "summary": {"balance": int(sum(sums.values()) or 0), "paid_twd": paid, "purchases": int(pn or 0), "purchased_points": int(ppts or 0),
                        "granted_points": int(sums.get("grant", 0) or 0), "used_points": -int(sums.get("charge", 0) or 0),
                        "expired_points": -int(sums.get("expire", 0) or 0), "waived_points": int(waived or 0),
                        "cost_usd": round(cost_all or 0, 2), "cost_twd": cost_twd, "profit_twd": paid - cost_twd,
                        "margin_pct": round((paid - cost_twd) / cost_twd * 100) if cost_twd else None,
                        "exports": sum(p.exports for p in ps), "revision_turns": sum(p.revision_turns for p in ps)},
            "by_category": [{"id": c, "label": l, "points": cats.get(c, 0)} for c, l in pricing.CATEGORIES],
            "daily": [{**v, "cost_twd": round(v["cost_twd"])} for v in daily.values()],
            "ledger": ledger, "projects": projects}


class Grant(BaseModel):
    delta: int
    reason: str = "manual"
    amount_twd: int = 0


@router.post("/users/{user_id}/credits")
async def grant(user_id: str, g: Grant, admin: User = Admin):
    kind = "purchase" if g.amount_twd > 0 else ("refund" if g.delta < 0 else "grant")
    bal = await add_credits(user_id, g.delta, kind, f"{g.reason} (by {admin.email})", amount_twd=g.amount_twd)
    return {"balance": bal}


class Patch(BaseModel):
    disabled: bool | None = None
    is_admin: bool | None = None
    note: str | None = None
    tags: list[str] | None = None
    reset_free_project: bool = False
    storage_quota_gb: int | None = None   # 0 clears the override (back to the plan's quota)


@router.post("/users/{user_id}")
async def patch_user(user_id: str, p: Patch, admin: User = Admin):
    async with Session() as s:
        u = await s.get(User, user_id)
        if not u:
            raise HTTPException(404)
        if p.disabled is not None and u.id != admin.id:
            u.disabled = p.disabled
        if p.is_admin is not None and u.id != admin.id:
            u.is_admin = p.is_admin
        if p.note is not None:
            u.note = p.note[:2000]
        if p.tags is not None:
            u.tags = ",".join(sorted({t.strip().replace(",", " ")[:30] for t in p.tags if t.strip()}))[:200]
        if p.reset_free_project:  # give another free trial
            u.free_project_id = None
        if p.storage_quota_gb is not None:
            u.storage_quota_gb = p.storage_quota_gb or None
        await s.commit()
    return {"ok": True}


class SubBody(BaseModel):
    plan: str = ""        # a key of pricing.SUBSCRIPTIONS, or "" to end the subscription now
    paid_twd: int = 0     # what was collected (bank transfer / LINE Pay), for the revenue figures


@router.post("/users/{user_id}/subscription")
async def set_subscription(user_id: str, b: SubBody, admin: User = Admin):
    """Start / renew / end a subscription by hand (used until the payment provider does it via webhook)."""
    from .main import activate_subscription, cancel_subscription
    if b.plan:
        if b.plan not in pricing.SUBSCRIPTIONS:
            raise HTTPException(404, "unknown plan")
        return await activate_subscription(user_id, b.plan, paid_twd=b.paid_twd, meta={"by": admin.email})
    return await cancel_subscription(user_id)


@router.get("/projects/{project_id}/messages")
async def project_messages(project_id: str, _: User = Admin):
    """Read a user's conversation for support/debugging (text only)."""
    async with Session() as s:
        rows = (await s.execute(select(Message).where(Message.project_id == project_id).order_by(Message.id))).scalars()
        out = []
        for m in rows:
            for b in json.loads(m.content):
                if b.get("type") == "text":
                    out.append({"role": m.role, "text": b["text"][:2000], "at": _iso(m.created_at)})
                elif b.get("type") == "tool_use":
                    out.append({"role": m.role, "tool": b["name"], "at": _iso(m.created_at)})
    return out


# ---- orders ---------------------------------------------------------------------------------------
@router.get("/orders")
async def orders(status: str = "", _: User = Admin):
    async with Session() as s:
        q = select(Order, User.email).join(User, User.id == Order.user_id).order_by(Order.created_at.desc()).limit(300)
        if status:
            q = q.where(Order.status == status)
        rows = (await s.execute(q)).all()
    from .main import _order_dict
    return [{**_order_dict(o), "email": email, "user_id": o.user_id} for o, email in rows]


@router.post("/orders/{order_id}/approve")
async def approve_order(order_id: str, admin: User = Admin):
    from .main import _fulfil, _order_dict
    async with Session() as s:
        o = await s.get(Order, order_id)
    if not o:
        raise HTTPException(404)
    if o.status == "paid":
        return {"order": _order_dict(o), "already": True}
    await _fulfil(o, {"approved_by": admin.email, "transfer_ref": o.transfer_ref})
    async with Session() as s:
        o = await s.get(Order, order_id)
    return {"order": _order_dict(o)}


@router.post("/orders/{order_id}/reject")
async def reject_order(order_id: str, admin: User = Admin):
    from .main import _order_dict
    async with Session() as s:
        o = await s.get(Order, order_id)
        if not o:
            raise HTTPException(404)
        if o.status != "paid":
            o.status = "failed"
            o.note = f"rejected by {admin.email}"
            await s.commit()
        return {"order": _order_dict(o)}


# ---- API 成本明細 -----------------------------------------------------------------------------------
COST_GROUPS = [
    ("claude", "Claude（剪輯師 AI）", "#D97757"),
    ("voice", "ElevenLabs 旁白", "#1B7AC3"),
    ("music", "ElevenLabs 配樂與音效", "#46B9BD"),
    ("stt", "語音辨識", "#7B3FE4"),
    ("railway", "Railway 主機", "#853BCE"),
]


def _cost_item(kind: str, meta: dict) -> tuple[str, str, str]:
    """(group, item id, item label) for one usage row."""
    if kind == "claude_tokens":
        return ("claude", "analyze", "先解析素材") if meta.get("analyze") else ("claude", "chat", "剪輯對話與工具判斷")
    if kind == "elevenlabs_tts_chars":
        return "voice", "tts", "旁白生成（含自動重錄）"
    if kind == "elevenlabs_music_sec":
        return "music", "music", "配樂"
    if kind == "elevenlabs_sfx_sec":
        return "music", "sfx", "音效"
    if kind == "elevenlabs_stt_sec":
        return ("stt", "voice_input", "語音輸入（用說的打字）") if meta.get("stt") == "voice_input" else ("stt", "check", "旁白核對與字幕對時")
    return "other", kind, kind


UNIT = {"claude_tokens": "tokens", "elevenlabs_tts_chars": "字", "elevenlabs_music_sec": "秒", "elevenlabs_sfx_sec": "秒", "elevenlabs_stt_sec": "秒"}
CLAUDE_USD = {"in": 4.0, "out": 20.0, "cache_read": 0.20}   # per million tokens, as in agent/runner.PRICE


@router.get("/costs")
async def costs(days: int = 30, _: User = Admin):
    days = max(1, min(365, days))
    ref = now()
    since = ref - timedelta(days=days)
    async with Session() as s:
        rows = (await s.execute(select(Usage, Project.name, User.email).join(Project, Project.id == Usage.project_id, isouter=True)
                                .join(User, User.id == Usage.user_id, isouter=True).where(Usage.created_at >= since))).all()
        exports = (await s.execute(select(func.count(CreditTx.id)).where(CreditTx.kind == "charge", CreditTx.reason == "export_video",
                                                                       CreditTx.created_at >= since))).scalar() or 0
        revenue = (await s.execute(select(func.coalesce(func.sum(CreditTx.amount_twd), 0)).where(CreditTx.kind == "purchase",
                                                                                                CreditTx.created_at >= since))).scalar() or 0
    groups: dict[str, dict] = {g: {"id": g, "label": l, "color": c, "usd": 0.0, "items": {}} for g, l, c in COST_GROUPS}
    groups["other"] = {"id": "other", "label": "其他", "color": "#B7BCC6", "usd": 0.0, "items": {}}
    tokens = {"in": 0, "out": 0, "cache_read": 0, "usd_in": 0.0, "usd_out": 0.0, "usd_cache_read": 0.0, "usd_cache_write": 0.0}
    keys = [(since + timedelta(days=i + 1)).date().isoformat() for i in range(days)]
    daily = {k: {"date": k, **{g: 0.0 for g in groups}} for k in keys}
    by_proj: dict[str, dict] = {}
    by_user: dict[str, dict] = {}
    for u, pname, email in rows:
        meta = json.loads(u.meta or "{}")
        g, iid, ilabel = _cost_item(u.kind, meta)
        usd = u.cost_usd or 0.0
        grp = groups[g]
        grp["usd"] += usd
        it = grp["items"].setdefault(iid, {"id": iid, "label": ilabel, "usd": 0.0, "units": 0.0, "unit": UNIT.get(u.kind, ""), "calls": 0})
        it["usd"] += usd; it["units"] += u.units or 0; it["calls"] += 1
        if u.kind == "claude_tokens":
            i_, o_, cr = int(meta.get("in") or 0), int(meta.get("out") or 0), int(meta.get("cache_read") or 0)
            tokens["in"] += i_; tokens["out"] += o_; tokens["cache_read"] += cr
            a, b, c = i_ * CLAUDE_USD["in"] / 1e6, o_ * CLAUDE_USD["out"] / 1e6, cr * CLAUDE_USD["cache_read"] / 1e6
            tokens["usd_in"] += a; tokens["usd_out"] += b; tokens["usd_cache_read"] += c
            tokens["usd_cache_write"] += max(0.0, usd - a - b - c)
        k = _day(u.created_at)
        if k in daily:
            daily[k][g] += usd
        if u.project_id:
            p = by_proj.setdefault(u.project_id, {"id": u.project_id, "name": pname or u.project_id, "email": email, "usd": 0.0, "by_group": {}})
            p["usd"] += usd; p["by_group"][g] = p["by_group"].get(g, 0.0) + usd
        us = by_user.setdefault(u.user_id, {"id": u.user_id, "email": email, "usd": 0.0})
        us["usd"] += usd
    # Railway hosting: each day's real usage from Railway's API plus that day's share of the unused part
    # of the plan fee (see railway_cost).
    rw = await railway_cost.cost(days)
    groups["railway"]["usd"] = rw["usd"]
    for it in rw["items"]:
        groups["railway"]["items"][it["id"]] = dict(it)
    rw_day = {x["date"]: x["usd"] for x in rw.get("daily", [])}
    for k, d in daily.items():
        d["railway"] += rw_day.get(k, 0.0) if rw_day else rw["usd"] / days
    total = sum(g["usd"] for g in groups.values())
    T = TWD_PER_USD

    def fmt_group(g):
        items = sorted(g["items"].values(), key=lambda x: -x["usd"])
        return {"id": g["id"], "label": g["label"], "color": g["color"], "usd": round(g["usd"], 4), "twd": round(g["usd"] * T),
                "pct": round(g["usd"] / total * 100, 1) if total else 0,
                "items": [{**it, "usd": round(it["usd"], 4), "twd": round(it["usd"] * T, 1), "units": round(it["units"], 1),
                           "pct": round(it["usd"] / g["usd"] * 100, 1) if g["usd"] else 0} for it in items]}
    out_groups = [fmt_group(g) for g in groups.values() if g["usd"] > 0 or g["id"] != "other"]
    out_groups.sort(key=lambda g: -g["usd"])
    return {"days": days, "usd": round(total, 2), "twd": round(total * T), "twd_per_usd": T,
            "exports": exports, "per_export_twd": round(total * T / exports) if exports else None,
            "revenue_twd": int(revenue), "margin_pct": round((revenue - total * T) / (total * T) * 100) if total else None,
            "groups": out_groups,
            "railway": {k: v for k, v in rw.items() if k not in ("items", "daily")},
            "claude_tokens": {**{k: v for k, v in tokens.items() if not k.startswith("usd")},
                              **{k: round(v * T, 1) for k, v in tokens.items() if k.startswith("usd")}},
            "daily": [{"date": d["date"], **{g: round(d[g] * T, 1) for g in groups}} for d in daily.values()],
            "top_projects": [{**p, "twd": round(p["usd"] * T), "by_group": {k: round(v * T) for k, v in p["by_group"].items()}}
                             for p in sorted(by_proj.values(), key=lambda x: -x["usd"])[:10]],
            "top_users": [{**x, "twd": round(x["usd"] * T)} for x in sorted(by_user.values(), key=lambda x: -x["usd"])[:10]]}


# ---- 定價：1 點值多少錢 ------------------------------------------------------------------------------
POINT_TWD_RANGE = (1.0, 20.0)


@router.get("/pricing")
async def pricing_preview(point_twd: float | None = None, _: User = Admin):
    """Current point price, or a preview at another price: every plan's NT$ price, cost and margin."""
    p = pricing.POINT_TWD if point_twd is None else point_twd
    if not POINT_TWD_RANGE[0] <= p <= POINT_TWD_RANGE[1]:
        raise HTTPException(400, f"每點價格要在 NT${POINT_TWD_RANGE[0]:g}～{POINT_TWD_RANGE[1]:g} 之間")
    return {**pricing.margins(p), "current_point_twd": pricing.POINT_TWD, "default_point_twd": pricing.DEFAULT_POINT_TWD,
            "current": pricing.margins()["rows"]}


class PointPriceBody(BaseModel):
    point_twd: float


@router.put("/pricing")
async def set_point_price(body: PointPriceBody, admin: User = Admin):
    p = round(body.point_twd, 2)
    if not POINT_TWD_RANGE[0] <= p <= POINT_TWD_RANGE[1]:
        raise HTTPException(400, f"每點價格要在 NT${POINT_TWD_RANGE[0]:g}～{POINT_TWD_RANGE[1]:g} 之間")
    await set_setting("point_twd", str(p))
    pricing.apply_point_price(p)
    log.info("point price set to NT$%s by %s", p, admin.email)
    return {**pricing.margins(), "current_point_twd": pricing.POINT_TWD, "default_point_twd": pricing.DEFAULT_POINT_TWD,
            "current": pricing.margins()["rows"]}
