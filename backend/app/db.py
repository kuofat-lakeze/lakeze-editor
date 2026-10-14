"""SQLAlchemy (async) models and the Store the agent runner talks to."""
import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from . import config
from .storage import project_dir

engine = create_async_engine(config.DATABASE_URL, echo=False)
Session = async_sessionmaker(engine, expire_on_commit=False)


def now() -> datetime:
    return datetime.now(timezone.utc)


def uid() -> str:
    return uuid.uuid4().hex[:12]


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(12), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    pw_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # The one project that runs on the free trial allowance.
    free_project_id: Mapped[str | None] = mapped_column(String(12), nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(12), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    exports: Mapped[int] = mapped_column(Integer, default=0)          # export_video calls so far
    revision_turns: Mapped[int] = mapped_column(Integer, default=0)   # user turns after the first export


class CreditTx(Base):
    """Credit ledger. Balance = sum(delta). Purchases positive, charges negative, free-trial
    charges recorded with delta 0 and points_waived so admin sees what the trial cost."""
    __tablename__ = "credit_tx"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    project_id: Mapped[str | None] = mapped_column(String(12), nullable=True)
    delta: Mapped[int] = mapped_column(Integer)
    points_waived: Mapped[int] = mapped_column(Integer, default=0)
    kind: Mapped[str] = mapped_column(String(20))   # purchase | charge | grant | refund
    reason: Mapped[str] = mapped_column(String(200))
    amount_twd: Mapped[int] = mapped_column(Integer, default=0)
    meta: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    role: Mapped[str] = mapped_column(String(10))
    content: Mapped[str] = mapped_column(Text)  # JSON list of content blocks (API shape)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Asset(Base):
    __tablename__ = "assets"
    id: Mapped[str] = mapped_column(String(12), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    kind: Mapped[str] = mapped_column(String(10))  # video | audio | image | file
    name: Mapped[str] = mapped_column(String(200))
    rel_path: Mapped[str] = mapped_column(String(500))
    meta: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Usage(Base):
    __tablename__ = "usage"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    units: Mapped[float] = mapped_column(Float)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    meta: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


# Columns added after the first release; create_all won't add them to existing tables.
_MIGRATIONS = [
    ("users", "is_admin", "BOOLEAN DEFAULT 0"), ("users", "disabled", "BOOLEAN DEFAULT 0"),
    ("users", "free_project_id", "VARCHAR(12)"), ("users", "note", "TEXT DEFAULT ''"),
    ("projects", "exports", "INTEGER DEFAULT 0"), ("projects", "revision_turns", "INTEGER DEFAULT 0"),
]


async def init_db() -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        for table, col, ddl in _MIGRATIONS:
            try:
                await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}"))
            except Exception:
                pass  # column exists


async def balance(user_id: str) -> int:
    async with Session() as s:
        return int((await s.execute(select(func.coalesce(func.sum(CreditTx.delta), 0)).where(CreditTx.user_id == user_id))).scalar() or 0)


async def add_credits(user_id: str, delta: int, kind: str, reason: str, *, project_id: str | None = None,
                      amount_twd: int = 0, waived: int = 0, meta: dict | None = None) -> int:
    async with Session() as s:
        s.add(CreditTx(user_id=user_id, project_id=project_id, delta=delta, points_waived=waived, kind=kind,
                       reason=reason, amount_twd=amount_twd, meta=json.dumps(meta or {}, ensure_ascii=False)))
        await s.commit()
    return await balance(user_id)


def asset_dict(a: Asset) -> dict:
    return {"id": a.id, "kind": a.kind, "name": a.name, "meta": json.loads(a.meta or "{}"),
            "url": f"/api/projects/{a.project_id}/assets/{a.id}", "created_at": a.created_at.isoformat()}


class Store:
    """Persistence used by TurnRunner. Each call opens its own session (runner runs in background)."""

    def __init__(self, user_id: str):
        self.user_id = user_id

    async def load_messages(self, project_id: str) -> list[dict]:
        async with Session() as s:
            rows = (await s.execute(select(Message).where(Message.project_id == project_id).order_by(Message.id))).scalars()
            return _coalesce([{"role": m.role, "content": json.loads(m.content)} for m in rows])

    async def save_message(self, project_id: str, role: str, content: list[dict]) -> None:
        async with Session() as s:
            s.add(Message(project_id=project_id, role=role, content=json.dumps(content, ensure_ascii=False)))
            p = await s.get(Project, project_id)
            if p:
                p.updated_at = now()
            await s.commit()

    async def add_asset(self, project_id: str, path: Path, kind: str, name: str, meta: dict | None = None) -> dict:
        root = project_dir(project_id)
        path = Path(path)
        # Keep deliverables under out/ with a unique name so re-exports don't overwrite history.
        dest = root / "out" / f"{uid()}_{path.name}"
        if path.resolve().parent != (root / "out").resolve() or dest.exists():
            shutil.copy2(path, dest)
        else:
            path.replace(dest)
        a = Asset(project_id=project_id, kind=kind, name=name, rel_path=str(dest.relative_to(root)),
                  meta=json.dumps(meta or {}, ensure_ascii=False))
        async with Session() as s:
            s.add(a)
            await s.commit()
        return asset_dict(a)

    async def record_usage(self, project_id: str, kind: str, units: float, cost_usd: float, meta: dict | None) -> None:
        if not cost_usd:
            from .pricing import ELEVEN_COST_USD
            cost_usd = units * ELEVEN_COST_USD.get(kind, 0.0)
        async with Session() as s:
            s.add(Usage(user_id=self.user_id, project_id=project_id, kind=kind, units=units, cost_usd=cost_usd,
                        meta=json.dumps(meta or {}, ensure_ascii=False)))
            await s.commit()

    # ---- credits ----------------------------------------------------------------
    async def credit_state(self, project_id: str) -> dict:
        """Balance plus whether this project is still inside the free-trial allowance."""
        from .pricing import FREE_REVISION_TURNS
        async with Session() as s:
            u = await s.get(User, self.user_id)
            p = await s.get(Project, project_id)
        free = bool(u and p and u.free_project_id == project_id)
        free_left = max(0, FREE_REVISION_TURNS - p.revision_turns) if (free and p.exports) else None
        in_free = free and (p.exports == 0 or p.revision_turns < FREE_REVISION_TURNS)
        return {"balance": await balance(self.user_id), "free_project": free, "in_free": in_free,
                "free_revisions_left": free_left, "exports": p.exports if p else 0}

    async def note_user_turn(self, project_id: str) -> None:
        """Called once per user message: counts revision turns after the first export."""
        async with Session() as s:
            p = await s.get(Project, project_id)
            if p and p.exports:
                p.revision_turns += 1
                await s.commit()

    async def charge(self, project_id: str, points: int, reason: str) -> tuple[bool, int]:
        """Deduct points unless the project is in its free allowance. Returns (ok, balance)."""
        st = await self.credit_state(project_id)
        if points <= 0:
            return True, st["balance"]
        if st["in_free"]:
            await add_credits(self.user_id, 0, "charge", reason, project_id=project_id, waived=points)
            return True, st["balance"]
        if st["balance"] < points:
            return False, st["balance"]
        return True, await add_credits(self.user_id, -points, "charge", reason, project_id=project_id)

    async def note_export(self, project_id: str) -> None:
        async with Session() as s:
            p = await s.get(Project, project_id)
            if p:
                p.exports += 1
                await s.commit()


def _coalesce(msgs: list[dict]) -> list[dict]:
    """Drop a trailing user message with no assistant reply (crashed turn) so history stays valid,
    and strip any stray tool_use without a following tool_result."""
    out = list(msgs)
    while out and out[-1]["role"] == "user" and any(b.get("type") == "tool_result" for b in out[-1]["content"]) is False \
            and len(out) >= 1 and (len(out) == 1 or out[-2]["role"] == "user"):
        out.pop()
    if out and out[-1]["role"] == "assistant" and any(b.get("type") == "tool_use" for b in out[-1]["content"]):
        out.pop()
    if out and out[-1]["role"] == "user" and not any(b.get("type") == "tool_result" for b in out[-1]["content"]):
        out.pop()
    return out
