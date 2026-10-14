"""Fonts used for burned-in captions. Downloaded once into DATA_DIR/fonts."""
import subprocess

from ..config import FONTS_DIR

FONTS = {
    # Voice-over captions: heavy sans
    "NotoSansCJKtc-Black.otf":
        "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@Sans2.004/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Black.otf",
    # Super titles: rounded display face
    "jf-openhuninn-2.1.ttf":
        "https://cdn.jsdelivr.net/gh/justfont/open-huninn-font@v2.1/font/jf-openhuninn-2.1.ttf",
}
VO_FONT = "Noto Sans CJK TC Black"
SUPER_FONT = "jf open 粉圓 2.1"


def ensure_fonts() -> str:
    FONTS_DIR.mkdir(parents=True, exist_ok=True)
    for name, url in FONTS.items():
        p = FONTS_DIR / name
        if p.exists() and p.stat().st_size > 100_000:
            continue
        subprocess.run(["curl", "-sSLf", "--retry", "3", "-o", str(p), url], check=True, timeout=300)
    return str(FONTS_DIR)
