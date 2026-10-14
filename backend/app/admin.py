"""Back office: users, balances, cost vs revenue, manual credit grants."""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select

from .auth import current_user
from .db import CreditTx, Message, Project, Session, Usage, User, add_credits, now

router = APIRouter(prefix="/api/admin")


async def admin_user(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(403, "admin only")
    return user


Admin = Depends(admin_user)


@router.get("/stats")
async def stats(_: User = Admin):
    async with Session() as s:
        users = (await s.execute(select(func.count(User.id)))).scalar()
        new7 = (await s.execute(select(func.count(User.id)).where(User.created_at >= now() - timedelta(days=7)))).scalar()
        projects = (await s.execute(select(func.count(Project.id)))).scalar()
        exports = (await s.execute(select(func.coalesce(func.sum(Project.exports), 0)))).scalar()
        revenue = (await s.execute(select(func.coalesce(func.sum(CreditTx.amount_twd), 0)).where(CreditTx.kind == "purchase"))).scalar()
        sold = (await s.execute(select(func.coalesce(func.sum(CreditTx.delta), 0)).where(CreditTx.kind.in_(("purchase", "grant"))))).scalar()
        used = -(await s.execute(select(func.coalesce(func.sum(CreditTx.delta), 0)).where(CreditTx.kind == "charge"))).scalar()
        waived = (await s.execute(select(func.coalesce(func.sum(CreditTx.points_waived), 0)))).scalar()
        cost = (await s.execute(select(func.coalesce(func.sum(Usage.cost_usd), 0.0)))).scalar()
        claude = (await s.execute(select(func.coalesce(func.sum(Usage.cost_usd), 0.0)).where(Usage.kind == "claude_tokens"))).scalar()
    return {"users": users, "new_users_7d": new7, "projects": projects, "exports": exports,
            "revenue_twd": revenue, "points_sold": sold, "points_used": used, "points_waived": waived,
            "cost_usd": round(cost, 2), "claude_cost_usd": round(claude, 2), "eleven_cost_usd": round(cost - claude, 2)}


@router.get("/users")
async def users(q: str = "", _: User = Admin):
    async with Session() as s:
        bal = select(CreditTx.user_id, func.sum(CreditTx.delta).label("bal"), func.sum(CreditTx.points_waived).label("waived"),
                     func.sum(CreditTx.amount_twd).label("paid")).group_by(CreditTx.user_id).subquery()
        cost = select(Usage.user_id, func.sum(Usage.cost_usd).label("cost")).group_by(Usage.user_id).subquery()
        proj = select(Project.user_id, func.count(Project.id).label("n"), func.sum(Project.exports).label("ex")).group_by(Project.user_id).subquery()
        stmt = (select(User, bal.c.bal, bal.c.waived, bal.c.paid, cost.c.cost, proj.c.n, proj.c.ex)
                .outerjoin(bal, bal.c.user_id == User.id).outerjoin(cost, cost.c.user_id == User.id)
                .outerjoin(proj, proj.c.user_id == User.id).order_by(User.created_at.desc()))
        if q:
            stmt = stmt.where(User.email.contains(q.lower()))
        rows = (await s.execute(stmt.limit(500))).all()
    return [{"id": u.id, "email": u.email, "created_at": u.created_at.isoformat(), "is_admin": u.is_admin,
             "disabled": u.disabled, "note": u.note, "balance": int(b or 0), "waived": int(w or 0), "paid_twd": int(p or 0),
             "cost_usd": round(c or 0, 2), "projects": int(n or 0), "exports": int(e or 0)} for u, b, w, p, c, n, e in rows]


@router.get("/users/{user_id}")
async def user_detail(user_id: str, _: User = Admin):
    async with Session() as s:
        u = await s.get(User, user_id)
        if not u:
            raise HTTPException(404)
        tx = (await s.execute(select(CreditTx).where(CreditTx.user_id == user_id).order_by(CreditTx.id.desc()).limit(200))).scalars()
        ps = (await s.execute(select(Project).where(Project.user_id == user_id).order_by(Project.updated_at.desc()))).scalars()
        pc = dict((await s.execute(select(Usage.project_id, func.sum(Usage.cost_usd)).where(Usage.user_id == user_id)
                                   .group_by(Usage.project_id))).all())
        ledger = [{"id": t.id, "delta": t.delta, "waived": t.points_waived, "kind": t.kind, "reason": t.reason,
                   "amount_twd": t.amount_twd, "project_id": t.project_id, "created_at": t.created_at.isoformat()} for t in tx]
        projects = [{"id": p.id, "name": p.name, "exports": p.exports, "revision_turns": p.revision_turns,
                     "free": u.free_project_id == p.id, "cost_usd": round(pc.get(p.id, 0) or 0, 2),
                     "updated_at": p.updated_at.isoformat()} for p in ps]
    return {"id": u.id, "email": u.email, "is_admin": u.is_admin, "disabled": u.disabled, "note": u.note,
            "created_at": u.created_at.isoformat(), "ledger": ledger, "projects": projects}


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
    reset_free_project: bool = False


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
            u.note = p.note
        if p.reset_free_project:  # give another free trial
            u.free_project_id = None
        await s.commit()
    return {"ok": True}


@router.get("/projects/{project_id}/messages")
async def project_messages(project_id: str, _: User = Admin):
    """Read a user's conversation for support/debugging (text only)."""
    async with Session() as s:
        rows = (await s.execute(select(Message).where(Message.project_id == project_id).order_by(Message.id))).scalars()
        out = []
        import json
        for m in rows:
            for b in json.loads(m.content):
                if b.get("type") == "text":
                    out.append({"role": m.role, "text": b["text"][:2000], "at": m.created_at.isoformat()})
                elif b.get("type") == "tool_use":
                    out.append({"role": m.role, "tool": b["name"], "at": m.created_at.isoformat()})
    return out
