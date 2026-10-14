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

from . import config
from .agent.runner import TurnRunner
from .auth import CurrentUser, check_pw, clear_session, hash_pw, set_session
from .db import Asset, Message, Project, Session, Store, Usage, User, asset_dict, init_db
from .pipeline.fonts import ensure_fonts
from .storage import project_dir, safe_join

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    try:
        await asyncio.to_thread(ensure_fonts)
    except Exception as e:  # fonts can be fetched later; don't block startup
        log.warning("font download failed: %s", e)
    yield


app = FastAPI(title="Lakeze Editor", lifespan=lifespan)

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
        u = User(email=c.email.lower(), pw_hash=hash_pw(c.password))
        s.add(u)
        await s.commit()
    resp = JSONResponse({"id": u.id, "email": u.email})
    set_session(resp, u.id, request.url.scheme == "https")
    return resp


@app.post("/api/auth/login")
async def login(c: Creds, request: Request):
    async with Session() as s:
        u = (await s.execute(select(User).where(User.email == c.email.lower()))).scalar_one_or_none()
    if not u or not check_pw(c.password, u.pw_hash):
        raise HTTPException(401, "email 或密碼錯誤")
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
    async with Session() as s:
        cost = (await s.execute(select(func.coalesce(func.sum(Usage.cost_usd), 0.0)).where(Usage.user_id == user.id))).scalar()
    return {"id": user.id, "email": user.email, "spent_usd": round(cost or 0, 4)}


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
        return [{"id": p.id, "name": p.name, "updated_at": p.updated_at.isoformat()} for p in rows]


@app.post("/api/projects")
async def create_project(body: NewProject, user: User = CurrentUser):
    async with Session() as s:
        p = Project(user_id=user.id, name=body.name.strip()[:200] or "未命名")
        s.add(p)
        await s.commit()
    project_dir(p.id)
    return {"id": p.id, "name": p.name}


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str, user: User = CurrentUser):
    p = await _own(project_id, user)
    async with Session() as s:
        msgs = (await s.execute(select(Message).where(Message.project_id == p.id).order_by(Message.id))).scalars()
        assets = (await s.execute(select(Asset).where(Asset.project_id == p.id).order_by(Asset.created_at))).scalars()
        out_msgs = [_public_message(m) for m in msgs]
    return {"id": p.id, "name": p.name, "messages": [m for m in out_msgs if m],
            "assets": [asset_dict(a) for a in assets], "running": project_id in _turns and not _turns[project_id]["task"].done()}


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


@app.get("/api/health")
async def health():
    return {"ok": True, "model": config.ANTHROPIC_MODEL, "elevenlabs": bool(config.ELEVENLABS_API_KEY)}
