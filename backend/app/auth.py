"""Email + password accounts with a signed cookie session."""
import bcrypt
from fastapi import Depends, HTTPException, Request, Response
from itsdangerous import BadSignature, TimestampSigner
from sqlalchemy import select

from . import config
from .db import Session, User

signer = TimestampSigner(config.SECRET_KEY)
COOKIE = "lk_session"
MAX_AGE = 30 * 24 * 3600


def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def check_pw(pw: str, h: str) -> bool:
    return bcrypt.checkpw(pw.encode(), h.encode())


def set_session(resp: Response, user_id: str, secure: bool) -> None:
    resp.set_cookie(COOKIE, signer.sign(user_id).decode(), max_age=MAX_AGE, httponly=True,
                    samesite="lax", secure=secure)


def clear_session(resp: Response) -> None:
    resp.delete_cookie(COOKIE)


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
    return u


CurrentUser = Depends(current_user)
