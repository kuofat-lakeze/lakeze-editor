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
    # Deliverable storage plan (pricing.STORAGE_PLANS); paid plans renew from points every 30 days.
    storage_plan: Mapped[str] = mapped_column(String(20), default="free")
    storage_renews_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    storage_quota_gb: Mapped[int | None] = mapped_column(Integer, nullable=True)  # admin override of the plan's quota
    # Monthly subscription (pricing.SUBSCRIPTIONS): included points are granted per period and the
    # unused part expires when the next period starts; storage is bundled.
    subscription: Mapped[str] = mapped_column(String(20), default="")
    sub_period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sub_renews_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # A clone of the customer's own voice (ElevenLabs voice id), available on subscriptions with the own_voice feature.
    voice_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    voice_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    voice_trial_seconds: Mapped[float] = mapped_column(Float, default=0.0)  # speech generated with the clone while on the free tier
    # Third-party sign-in: "google" / "facebook" and the provider's user id. pw_hash is "" for such accounts
    # until they set a password.
    provider: Mapped[str] = mapped_column(String(20), default="")
    provider_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    display_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # CRM: free-form tags ("vip,民宿,宜蘭") and the last authenticated request (refreshed every few minutes).
    tags: Mapped[str] = mapped_column(String(200), default="")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(12), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    exports: Mapped[int] = mapped_column(Integer, default=0)          # export_video calls so far
    revision_turns: Mapped[int] = mapped_column(Integer, default=0)   # revision turns (with tool work) after the first export
    final_version: Mapped[int | None] = mapped_column(Integer, nullable=True)  # the export marked as the delivered one


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
    # Deliverables (exported videos, covers) are grouped into versions: v1 = first export, v2 = next…
    version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)  # counted against the owner's storage quota when version is set


class Share(Base):
    """A client-facing link to a project's deliverables. No login: the token is the credential."""
    __tablename__ = "shares"
    id: Mapped[str] = mapped_column(String(12), primary_key=True, default=uid)
    token: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    version: Mapped[int | None] = mapped_column(Integer, nullable=True)  # None = the project's final version
    allow_download: Mapped[bool] = mapped_column(Boolean, default=True)
    note: Mapped[str] = mapped_column(Text, default="")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    views: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ShareComment(Base):
    """What the client wrote on the share page. Shown to the owner in the project; not fed to the agent."""
    __tablename__ = "share_comments"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    share_id: Mapped[str] = mapped_column(String(12))
    name: Mapped[str] = mapped_column(String(80), default="")
    text: Mapped[str] = mapped_column(Text)
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
    ("projects", "final_version", "INTEGER"), ("assets", "version", "INTEGER"),
    ("users", "storage_plan", "VARCHAR(20) DEFAULT 'free'"), ("users", "storage_renews_at", "DATETIME"),
    ("users", "storage_quota_gb", "INTEGER"), ("assets", "size_bytes", "INTEGER DEFAULT 0"),
    ("users", "subscription", "VARCHAR(20) DEFAULT ''"), ("users", "sub_period_start", "DATETIME"), ("users", "sub_renews_at", "DATETIME"),
    ("users", "voice_id", "VARCHAR(64)"), ("users", "voice_name", "VARCHAR(80)"), ("users", "voice_trial_seconds", "FLOAT DEFAULT 0"),
    ("users", "provider", "VARCHAR(20) DEFAULT ''"), ("users", "provider_id", "VARCHAR(80)"), ("users", "display_name", "VARCHAR(120)"),
    ("users", "tags", "VARCHAR(200) DEFAULT ''"), ("users", "last_seen_at", "DATETIME"),
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


EXPORT_NAMES = {"母帶": "master", "上傳用 1080p": "upload", "預覽 720p": "preview"}


async def backfill_versions() -> int:
    """Assets created before versioning have version NULL. Replay each project's asset history: every
    母帶 (the first file of an export) starts a new version; covers belong to the current version."""
    n = 0
    async with Session() as s:
        rows = (await s.execute(select(Asset).order_by(Asset.project_id, Asset.created_at, Asset.id))).scalars().all()
        by_proj: dict[str, list[Asset]] = {}
        for a in rows:
            by_proj.setdefault(a.project_id, []).append(a)
        for pid, assets in by_proj.items():
            if not any(a.version is None and (a.name in EXPORT_NAMES or a.name.startswith("封面")) for a in assets):
                continue
            v = 0
            for a in assets:
                meta = json.loads(a.meta or "{}")
                if a.name in EXPORT_NAMES:
                    if a.name == "母帶":
                        v += 1
                    if a.version is None:
                        a.version = max(v, 1)
                        meta.update(role=EXPORT_NAMES[a.name], deliverable=True)
                        a.meta = json.dumps(meta, ensure_ascii=False); n += 1
                    else:
                        v = max(v, a.version)
                elif a.name.startswith("封面") and a.version is None:
                    a.version = max(v, 1)
                    meta.update(role="cover", cover=True)
                    a.meta = json.dumps(meta, ensure_ascii=False); n += 1
            p = await s.get(Project, pid)
            if p and (p.exports or 0) < v:
                p.exports = v
        await s.commit()
    return n


async def backfill_sizes() -> int:
    """Assets created before size tracking have size_bytes 0: stat the files once."""
    n = 0
    async with Session() as s:
        rows = (await s.execute(select(Asset).where((Asset.size_bytes == 0) | (Asset.size_bytes.is_(None))))).scalars().all()
        for a in rows:
            p = project_dir(a.project_id) / a.rel_path
            if p.exists():
                a.size_bytes = p.stat().st_size; n += 1
        await s.commit()
    return n


# ---- deliverable storage ------------------------------------------------------------------------
GB = 1 << 30


async def storage_used(user_id: str, session: AsyncSession | None = None) -> int:
    """Bytes of deliverables (assets with a version) across the user's projects."""
    async def q(s: AsyncSession) -> int:
        return int((await s.execute(select(func.coalesce(func.sum(Asset.size_bytes), 0)).join(Project, Project.id == Asset.project_id)
                                    .where(Project.user_id == user_id, Asset.version.is_not(None)))).scalar() or 0)
    if session is not None:
        return await q(session)
    async with Session() as s:
        return await q(s)


def storage_quota_bytes(u: User) -> int:
    from .pricing import STORAGE_PLANS
    if u.storage_quota_gb:
        return u.storage_quota_gb * GB
    return STORAGE_PLANS.get(u.storage_plan or "free", STORAGE_PLANS["free"])["gb"] * GB


async def storage_state(user_id: str) -> dict:
    async with Session() as s:
        u = await s.get(User, user_id)
        used = await storage_used(user_id, s)
    quota = storage_quota_bytes(u) if u else 0
    return {"used_bytes": used, "quota_bytes": quota, "plan": (u.storage_plan if u else "free") or "free",
            "renews_at": u.storage_renews_at.isoformat() if u and u.storage_renews_at else None, "over": used >= quota}


async def has_paid(user_id: str) -> bool:
    """True once the user has ever bought points or a subscription (the 旅行者 tier and up)."""
    async with Session() as s:
        n = (await s.execute(select(func.count(CreditTx.id)).where(CreditTx.user_id == user_id, CreditTx.kind.in_(("purchase", "subscription"))))).scalar()
    return bool(n)


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
    meta = json.loads(a.meta or "{}")
    return {"id": a.id, "kind": a.kind, "name": a.name, "meta": meta, "version": a.version, "role": meta.get("role"),
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
        meta = meta or {}
        version = None
        async with Session() as s:
            p = await s.get(Project, project_id)
            exports = (p.exports if p else 0) or 0
            if meta.get("deliverable"):      # export_video output: the export counter is bumped after the tool returns
                version = exports + 1
            elif meta.get("cover"):          # a cover belongs to the latest export (or v1 before any export)
                version = max(exports, 1)
            a = Asset(project_id=project_id, kind=kind, name=name, rel_path=str(dest.relative_to(root)),
                      meta=json.dumps(meta, ensure_ascii=False), version=version,
                      size_bytes=dest.stat().st_size if dest.exists() else 0)
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

    async def note_revision_turn(self, project_id: str) -> tuple[bool, int]:
        """Count one revision turn and charge the per-turn fee: called by the runner the first time a
        turn that started after the first export runs a chargeable tool. Turns that only answer
        questions don't consume a revision. Returns the charge result (ok, balance)."""
        from .pricing import REVISION_TURN_POINTS
        async with Session() as s:
            p = await s.get(Project, project_id)
            if p and p.exports:
                p.revision_turns += 1
                await s.commit()
        return await self.charge(project_id, REVISION_TURN_POINTS, "revision_turn")

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

    async def storage_state(self) -> dict:
        return await storage_state(self.user_id)

    # ---- own voice on the free tier -------------------------------------------------
    async def voice_trial(self, voice_id: str) -> dict | None:
        """If voice_id is this user's own clone and they are still on the free tier, the trial cap
        applies: {used, limit}. None means no cap (not their clone, or a paying user)."""
        from .pricing import TRIAL_VOICE_SECONDS
        async with Session() as s:
            u = await s.get(User, self.user_id)
        if not u or not u.voice_id or u.voice_id != voice_id or u.subscription or await has_paid(self.user_id):
            return None
        return {"used": round(u.voice_trial_seconds or 0.0, 1), "limit": TRIAL_VOICE_SECONDS}

    async def add_voice_seconds(self, seconds: float) -> None:
        async with Session() as s:
            u = await s.get(User, self.user_id)
            if u:
                u.voice_trial_seconds = (u.voice_trial_seconds or 0.0) + seconds
                await s.commit()

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
