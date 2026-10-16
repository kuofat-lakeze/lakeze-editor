"""Email + password accounts with a signed cookie session.

The cookie is scoped to the app's parent domain (".editor.lakeze.com") so the same session works on
the app and on the dashboard host (dashboard.editor.lakeze.com). On localhost / preview hosts the
cookie stays host-only.
"""
from datetime import timedelta

import bcrypt
from fastapi import Depends, HTTPException, Request, Response
from itsdangerous import BadSignature, TimestampSigner
from sqlalchemy import select

from . import config
from .db import Session, User, now

signer = TimestampSigner(config.SECRET_KEY)
COOKIE = "lk_session"
MAX_AGE = 30 * 24 * 3600
SEEN_EVERY = timedelta(minutes=10)   # how often an authenticated request refreshes users.last_seen_at


def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def check_pw(pw: str, h: str) -> bool:
    return bcrypt.checkpw(pw.encode(), h.encode())


def cookie_domain(host: str | None) -> str | None:
    """'.editor.lakeze.com' for the app and any of its sub-hosts; None (host-only) elsewhere."""
    if config.COOKIE_DOMAIN:
        return config.COOKIE_DOMAIN
    h = (host or "").split(":")[0].lower()
    base = config.PUBLIC_URL.split("://", 1)[-1].split("/")[0].split(":")[0].lower()
    if base and (h == base or h.endswith("." + base)):
        return "." + base
    return None


def set_session(resp: Response, user_id: str, secure: bool, host: str | None = None) -> None:
    resp.set_cookie(COOKIE, signer.sign(user_id).decode(), max_age=MAX_AGE, httponly=True,
                    samesite="lax", secure=secure, domain=cookie_domain(host))


def clear_session(resp: Response, host: str | None = None) -> None:
    resp.delete_cookie(COOKIE, domain=cookie_domain(host))
    resp.delete_cookie(COOKIE)   # also a host-only cookie from before the domain scoping


async def current_user(request: Request) -> User:
    raw = request.cookies.get(COOKIE)
    if not raw:
        raise HTTPException(401, "not signed in")
    try:
        user_id = signer.unsign(raw, max_age=MAX_AGE).decode()
    except BadSignature:
        raise HTTPException(401, "session invalid")
    async with Session() as s:
        u = (await s.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
        if not u:
            raise HTTPException(401, "user gone")
        t = now()
        seen = u.last_seen_at
        if seen is not None and seen.tzinfo is None:
            seen = seen.replace(tzinfo=t.tzinfo)
        if seen is None or t - seen > SEEN_EVERY:   # cheap "last active" for the CRM
            u.last_seen_at = t
            await s.commit()
    return u


CurrentUser = Depends(current_user)
