"""Sign in with Google / Facebook (OAuth 2.0 authorization-code flow, server side).

/api/auth/providers            → which buttons to show
/api/auth/{provider}/start     → redirect to the provider (state in a signed, short-lived cookie)
/api/auth/{provider}/callback  → exchange the code, find-or-create the user by verified email, set the session

Accounts are matched by email, so someone who signed up with a password can also sign in with Google
on the same address. A brand-new account gets the same welcome points as an email signup.
"""
import asyncio
import logging
import secrets
from urllib.parse import quote, urlencode

import requests
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, TimestampSigner
from sqlalchemy import select

from . import config, pricing
from .auth import set_session
from .db import Session, User, add_credits

log = logging.getLogger("oauth")
router = APIRouter()
_state = TimestampSigner(config.SECRET_KEY, salt="oauth-state")
STATE_COOKIE = "lk_oauth"

PROVIDERS = {
    "google": {
        "auth": "https://accounts.google.com/o/oauth2/v2/auth",
        "token": "https://oauth2.googleapis.com/token",
        "me": "https://openidconnect.googleapis.com/v1/userinfo",
        "scope": "openid email profile",
        "id": lambda: config.GOOGLE_CLIENT_ID, "secret": lambda: config.GOOGLE_CLIENT_SECRET,
    },
    "facebook": {
        "auth": "https://www.facebook.com/v19.0/dialog/oauth",
        "token": "https://graph.facebook.com/v19.0/oauth/access_token",
        "me": "https://graph.facebook.com/v19.0/me?fields=id,name,email",
        "scope": "public_profile,email",
        "id": lambda: config.FACEBOOK_APP_ID, "secret": lambda: config.FACEBOOK_APP_SECRET,
    },
}


def configured(name: str) -> bool:
    p = PROVIDERS.get(name)
    return bool(p and p["id"]() and p["secret"]())


def redirect_uri(name: str) -> str:
    return f"{config.PUBLIC_URL}/api/auth/{name}/callback"


@router.get("/api/auth/providers")
async def providers():
    return {name: configured(name) for name in PROVIDERS}


def _safe_next(url: str) -> str:
    """Where to land after sign-in: a path on this app, or an absolute URL on the app's own domain
    (e.g. the dashboard host). Anything else falls back to /."""
    url = (url or "").strip()
    if url.startswith("/") and not url.startswith("//"):
        return url
    base = config.PUBLIC_URL.split("://", 1)[-1].split("/")[0].lower()
    if url.startswith("https://"):
        host = url[8:].split("/")[0].split(":")[0].lower()
        if host == base or host.endswith("." + base):
            return url
    return "/"


@router.get("/api/auth/{name}/start")
async def start(name: str, request: Request, mode: str = "login", next: str = "/", ref: str = ""):
    if not configured(name):
        raise HTTPException(404, "此登入方式未開放")
    p = PROVIDERS[name]
    nonce = secrets.token_urlsafe(24)
    q = {"client_id": p["id"](), "redirect_uri": redirect_uri(name), "response_type": "code", "scope": p["scope"], "state": nonce}
    if name == "google":
        q.update(access_type="online", prompt="select_account")
    resp = RedirectResponse(f"{p['auth']}?{urlencode(q)}", status_code=302)
    resp.set_cookie(STATE_COOKIE, _state.sign(f"{nonce}:{name}:{mode}:{ref.strip()[:64].replace(chr(58), '')}:{_safe_next(next)}").decode(), max_age=600, httponly=True,
                    samesite="lax", secure=request.url.scheme == "https")
    return resp


def _fail(reason: str) -> RedirectResponse:
    r = RedirectResponse(f"/login?oauth_error={quote(reason)}", status_code=302)
    r.delete_cookie(STATE_COOKIE)
    return r


def _fetch_profile(name: str, code: str) -> dict:
    """Code → access token → {email, email_verified, name, id}. Runs in a worker thread."""
    p = PROVIDERS[name]
    data = {"client_id": p["id"](), "client_secret": p["secret"](), "code": code, "redirect_uri": redirect_uri(name),
            "grant_type": "authorization_code"}
    r = requests.post(p["token"], data=data, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"token exchange failed: HTTP {r.status_code}")
    token = r.json().get("access_token")
    if not token:
        raise RuntimeError("no access token")
    r = requests.get(p["me"], headers={"Authorization": f"Bearer {token}"}, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"profile fetch failed: HTTP {r.status_code}")
    j = r.json()
    if name == "google":
        return {"id": j.get("sub"), "email": j.get("email"), "verified": bool(j.get("email_verified")), "name": j.get("name")}
    return {"id": j.get("id"), "email": j.get("email"), "verified": bool(j.get("email")), "name": j.get("name")}


@router.get("/api/auth/{name}/callback")
async def callback(name: str, request: Request, code: str = "", state: str = "", error: str = ""):
    if not configured(name):
        raise HTTPException(404, "此登入方式未開放")
    if error or not code:
        return _fail("你取消了登入" if error in ("access_denied", "user_denied") else "登入沒有完成，請再試一次")
    try:
        raw = _state.unsign(request.cookies.get(STATE_COOKIE, ""), max_age=600).decode()
        nonce, pname, _mode, ref, nxt = raw.split(":", 4)
    except (BadSignature, ValueError):
        return _fail("登入逾時，請再試一次")
    if nonce != state or pname != name:
        return _fail("登入驗證失敗，請再試一次")
    try:
        prof = await asyncio.to_thread(_fetch_profile, name, code)
    except Exception as e:
        log.warning("%s oauth failed: %s", name, e)
        return _fail("跟 Google / Facebook 連線失敗，請再試一次")
    email = (prof.get("email") or "").strip().lower()
    if not email or not prof.get("verified"):
        return _fail("沒有拿到你的 Email（Facebook 帳號需要有已驗證的 Email），請改用 Email 註冊")
    label = "Google" if name == "google" else "Facebook"
    async with Session() as s:
        u = (await s.execute(select(User).where(User.email == email))).scalar_one_or_none()
        created = u is None
        if created:
            if not config.ALLOW_SIGNUP:
                return _fail("目前暫停註冊")
            from .main import referrer_from_share
            u = User(email=email, pw_hash="", is_admin=email in config.ADMIN_EMAILS, provider=name,
                     provider_id=str(prof.get("id") or ""), display_name=(prof.get("name") or "")[:120] or None,
                     referrer_id=await referrer_from_share(ref))
            s.add(u)
        else:
            if u.disabled:
                return _fail("帳號已停用")
            if not u.provider:
                u.provider, u.provider_id = name, str(prof.get("id") or "")
            if not u.display_name and prof.get("name"):
                u.display_name = prof["name"][:120]
            if email in config.ADMIN_EMAILS:
                u.is_admin = True
        await s.commit()
        uid = u.id
    if created:
        await add_credits(uid, pricing.SIGNUP_POINTS, "grant", "signup", meta={"welcome": True, "provider": name})
        log.info("new %s account %s", label, email)
    resp = RedirectResponse(_safe_next(nxt), status_code=302)
    resp.delete_cookie(STATE_COOKIE)
    set_session(resp, uid, request.url.scheme == "https", request.headers.get("host"))
    return resp
