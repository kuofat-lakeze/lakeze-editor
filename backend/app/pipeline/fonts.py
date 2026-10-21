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
    # 字型 presets the user can pick: 楷體 (霞鶩文楷), 明體 (Noto Serif, variable), 手寫 (芫荽)
    "LXGWWenKaiTC-Bold.ttf": "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/lxgwwenkaitc/LXGWWenKaiTC-Bold.ttf",
    "NotoSerifTC[wght].ttf": "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notoseriftc/NotoSerifTC%5Bwght%5D.ttf",
    "Iansui-Regular.ttf": "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/iansui/Iansui-Regular.ttf",
}
VO_FONT = "Noto Sans CJK TC Black"
SUPER_FONT = "jf open 粉圓 2.1"
# 字型: the family name libass sees, per preset id (the frontend shows the same ids with a preview).
FONT_PRESETS = {
    "black": {"label": "粗黑體", "family": VO_FONT, "bold": -1},
    "round": {"label": "圓體", "family": SUPER_FONT, "bold": -1},
    "kai": {"label": "楷體", "family": "LXGW WenKai TC", "bold": -1},
    "serif": {"label": "明體", "family": "Noto Serif TC", "bold": -1},
    "hand": {"label": "手寫感", "family": "Iansui", "bold": 0},
}
DEFAULT_FONT = "black"


def font_family(preset: str) -> tuple[str, int]:
    p = FONT_PRESETS.get(preset or DEFAULT_FONT, FONT_PRESETS[DEFAULT_FONT])
    return p["family"], p["bold"]


def ensure_fonts() -> str:
    FONTS_DIR.mkdir(parents=True, exist_ok=True)
    for name, url in FONTS.items():
        p = FONTS_DIR / name
        if p.exists() and p.stat().st_size > 100_000:
            continue
        try:
            subprocess.run(["curl", "-sSLf", "--retry", "3", "-o", str(p), url], check=True, timeout=300)
        except Exception:   # an optional preset font that can't be fetched falls back to the default family
            if name in ("NotoSansCJKtc-Black.otf", "jf-openhuninn-2.1.ttf"):
                raise
            p.unlink(missing_ok=True)
    return str(FONTS_DIR)
