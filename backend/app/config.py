"""Runtime settings, all from environment variables."""
import json
import os
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


DATA_DIR = Path(_env("DATA_DIR", "/data")).resolve()
FONTS_DIR = DATA_DIR / "fonts"
DATABASE_URL = _env("DATABASE_URL", f"sqlite+aiosqlite:///{DATA_DIR}/lakeze.db")
SECRET_KEY = _env("SECRET_KEY", "dev-secret-change-me")
ANTHROPIC_MODEL = _env("ANTHROPIC_MODEL", "claude-opus-5-5")
# Required when ANTHROPIC_API_KEY is an organization-scoped user key (sk-ant-usr-…): the API then
# demands an `anthropic-workspace-id` header. Leave empty for workspace-scoped keys.
ANTHROPIC_WORKSPACE_ID = _env("ANTHROPIC_WORKSPACE_ID")
ANTHROPIC_EFFORT = _env("ANTHROPIC_EFFORT", "high")
ELEVENLABS_API_KEY = _env("ELEVENLABS_API_KEY")
# Voices offered in the UI before the first message (JSON list of {voice_id, name, gender, description}).
# Taiwanese-accent voices found live in the Voice Library are appended after these.
VOICE_PRESETS = json.loads(_env("VOICE_PRESETS_JSON", json.dumps([
    {"voice_id": "xrDmUzhnE51Df8z38r1M", "name": "薇薇安", "gender": "female", "description": "台灣腔女聲，自然、有活力"},
])))
# Chinese display names for Voice Library voices (voice_id → name); voices not listed get one from a pool.
VOICE_NAMES = json.loads(_env("VOICE_NAMES_JSON", "{}"))
# Max parallel ElevenLabs requests (Starter tier allows 3).
ELEVENLABS_CONCURRENCY = int(_env("ELEVENLABS_CONCURRENCY", "3"))
ALLOW_SIGNUP = _env("ALLOW_SIGNUP", "true").lower() == "true"
# Cap per-user spend recorded in usage events (USD); 0 disables the cap.
USER_BUDGET_USD = float(_env("USER_BUDGET_USD", "0"))
MAX_UPLOAD_MB = int(_env("MAX_UPLOAD_MB", "1024"))  # per file; the UI enforces the same 1 GB and at most 6 files per pick
# Delete raw footage and intermediate files of projects idle for this many days (0 = never).
# Deliverables (out/), thumbnails and the conversation are kept.
RAW_RETENTION_DAYS = int(_env("RAW_RETENTION_DAYS", "7"))
# Emails that are admins (dashboard access): the built-in owners plus anything in ADMIN_EMAILS.
DEFAULT_ADMIN_EMAILS = {"kuofat@gmail.com", "lodestar0115@gmail.com"}
ADMIN_EMAILS = DEFAULT_ADMIN_EMAILS | {e.strip().lower() for e in _env("ADMIN_EMAILS").split(",") if e.strip()}
# Lemon Squeezy: hosted checkout URL per pack (JSON {"p500": "https://...buy/..."}), variant→pack map,
# and the webhook signing secret. Leave empty to sell manually (admin grants credits).
CHECKOUT_URLS = json.loads(_env("CHECKOUT_URLS", "{}"))
LS_VARIANTS = json.loads(_env("LS_VARIANTS", "{}"))
LS_WEBHOOK_SECRET = _env("LEMONSQUEEZY_WEBHOOK_SECRET")
# 自訂點數刷卡: a checkout is created per order through the Lemon Squeezy API with a custom price on one
# "points" variant. Needs an API key, the store id and that variant id; without them card is off for it.
LS_API_KEY = _env("LEMONSQUEEZY_API_KEY")
LS_STORE_ID = _env("LEMONSQUEEZY_STORE_ID")
LS_TOPUP_VARIANT = _env("LEMONSQUEEZY_TOPUP_VARIANT")
# Bank transfer details shown on the payment page (JSON {"bank": "...", "code": "812", "account": "...", "name": "..."}).
# Empty = transfer not offered.
BANK_TRANSFER = json.loads(_env("BANK_TRANSFER_JSON", "{}"))
# Shown on the top-up page when no checkout URL is configured (bank transfer / LINE Pay instructions).
TOPUP_NOTE = _env("TOPUP_NOTE", "儲值請聯絡客服，入帳後點數會自動出現在側欄。")
# Public origin of the app, used to build OAuth redirect URIs (must match what is registered at Google / Meta).
PUBLIC_URL = _env("PUBLIC_URL", "https://editor.lakeze.com").rstrip("/")
# Session cookie domain. Empty = derived from PUBLIC_URL (".editor.lakeze.com", shared with the dashboard host).
COOKIE_DOMAIN = _env("COOKIE_DOMAIN")
# Third-party sign-in. A provider's buttons appear only when both values are set.
GOOGLE_CLIENT_ID = _env("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = _env("GOOGLE_CLIENT_SECRET")
FACEBOOK_APP_ID = _env("FACEBOOK_APP_ID")
FACEBOOK_APP_SECRET = _env("FACEBOOK_APP_SECRET")
# Test accounts: "buying" a pack or a subscription credits the account directly, no payment provider involved.
DEFAULT_TEST_EMAILS = {"kuofat@gmail.com", "lodestar0115@gmail.com"}
TEST_EMAILS = DEFAULT_TEST_EMAILS | {e.strip().lower() for e in _env("TEST_EMAILS").split(",") if e.strip()}
