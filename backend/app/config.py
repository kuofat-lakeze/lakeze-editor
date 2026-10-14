"""Runtime settings, all from environment variables."""
import os
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


DATA_DIR = Path(_env("DATA_DIR", "/data")).resolve()
FONTS_DIR = DATA_DIR / "fonts"
DATABASE_URL = _env("DATABASE_URL", f"sqlite+aiosqlite:///{DATA_DIR}/lakeze.db")
SECRET_KEY = _env("SECRET_KEY", "dev-secret-change-me")
ANTHROPIC_MODEL = _env("ANTHROPIC_MODEL", "claude-opus-5-5")
ANTHROPIC_EFFORT = _env("ANTHROPIC_EFFORT", "high")
ELEVENLABS_API_KEY = _env("ELEVENLABS_API_KEY")
# Max parallel ElevenLabs requests (Starter tier allows 3).
ELEVENLABS_CONCURRENCY = int(_env("ELEVENLABS_CONCURRENCY", "3"))
ALLOW_SIGNUP = _env("ALLOW_SIGNUP", "true").lower() == "true"
# Cap per-user spend recorded in usage events (USD); 0 disables the cap.
USER_BUDGET_USD = float(_env("USER_BUDGET_USD", "0"))
MAX_UPLOAD_MB = int(_env("MAX_UPLOAD_MB", "4096"))
