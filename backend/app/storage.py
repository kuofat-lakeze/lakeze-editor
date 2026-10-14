"""Per-project working directories and safe path handling."""
from pathlib import Path

from .config import DATA_DIR

SUBDIRS = ("raw", "work", "work/seg", "work/vo", "out", "sheets", "sheets/thumbs", "cover")


def project_dir(project_id: str) -> Path:
    d = DATA_DIR / "projects" / project_id
    for s in SUBDIRS:
        (d / s).mkdir(parents=True, exist_ok=True)
    return d


def safe_join(root: Path, rel: str) -> Path:
    """Resolve rel under root; reject anything that escapes (.., absolute, symlink)."""
    p = (root / rel).resolve()
    if not p.is_relative_to(root.resolve()):
        raise ValueError(f"path escapes project: {rel}")
    return p


def rel_to(root: Path, p: Path) -> str:
    return str(p.resolve().relative_to(root.resolve()))
