"""Two-layer burned-in captions.

Layer VO    : what the narrator says, word-for-word, gold with white highlight words, bottom.
Layer Super : information the narration does not say, rounded white-on-blue chip, top.
Plus an optional animated price counter and a darkened price window.
"""
from pathlib import Path

from . import ff
from .fonts import SUPER_FONT, VO_FONT, ensure_fonts

# 字幕樣式 presets: the VO line style and its **highlight** colour. Colours are ASS &HAABBGGRR.
CAPTION_STYLES = {
    "gold":  {"label": "金字醒目", "size": 100, "style": "&H0037C0F5,&H000000FF,&H00101C2E,&H96000000,-1,0,0,0,100,100,2,0,1,9,5", "hl": "FFFFFF"},
    "white": {"label": "白字黑邊", "size": 100, "style": "&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,2,0,1,8,4", "hl": "37C0F5"},
    "box":   {"label": "黃底黑字", "size": 92,  "style": "&H00141414,&H000000FF,&H0000DCFF,&H00000000,-1,0,0,0,100,100,2,0,3,16,0", "hl": "1E1EE6"},
    "soft":  {"label": "清爽細字", "size": 84,  "style": "&H00FFFFFF,&H000000FF,&H00303030,&H64000000,0,0,0,0,100,100,1,0,1,4,2", "hl": "B4E6FF"},
}
DEFAULT_STYLE = "gold"


def _head(style: str = DEFAULT_STYLE) -> str:
    st = CAPTION_STYLES.get(style, CAPTION_STYLES[DEFAULT_STYLE])
    return f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: VO,{VO_FONT},{st["size"]},{st["style"]},5,50,50,0,1
Style: Super,{SUPER_FONT},76,&H00FFFFFF,&H000000FF,&H00A88F0E,&H00000000,0,0,0,0,100,100,4,0,3,18,0,5,60,60,0,1
Style: Title,{VO_FONT},200,&H0037C0F5,&H000000FF,&H00101C2E,&H8C000000,-1,0,0,0,100,100,6,0,1,12,10,5,40,40,0,1
Style: Sub,{VO_FONT},92,&H00FFFFFF,&H000000FF,&H00101C2E,&H8C000000,-1,0,0,0,100,100,4,0,1,8,6,5,40,40,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


HEAD = _head()
_COLORS = {"gold": "3FD8FF", "white": "FFFFFF", "red": "3C3CFF", "blue": "F5A623"}  # ASS &HBBGGRR&
POP = r"{\fad(50,50)\fscx118\fscy118\t(0,120,\fscx100\fscy100)}"


def _t(s: float) -> str:
    s = max(0.0, s)
    return f"{int(s // 3600)}:{int(s % 3600 // 60):02d}:{s % 60:05.2f}"


def _markup(text: str, hl_size: int = 124, hl: str = "FFFFFF") -> str:
    """'**word**' → enlarged white highlight inside a VO caption."""
    out, bold = "", False
    for part in text.split("**"):
        if bold:
            out += r"{\fs%d\c&H%s&}%s{\r}" % (hl_size, hl, part)
        else:
            out += part
        bold = not bold
    return out.replace("\n", "\\N")


def build_ass(vo: list[dict], supers: list[dict], counter: dict | None, dest: Path, vo_scale: float = 1.0, style: str = DEFAULT_STYLE) -> Path:
    """vo: [{start,end,text,y?}]  supers: [{start,end,text,y?}]
    counter: {start,end,amount,prefix,label,y?} – animated count-up (price reveal).  style: a CAPTION_STYLES key."""
    ev = []
    st = CAPTION_STYLES.get(style, CAPTION_STYLES[DEFAULT_STYLE])
    base = st["size"]
    fs = f"\\fs{int(round(base * vo_scale))}" if abs(vo_scale - 1.0) > 1e-3 else ""
    for c in vo:
        y = int(c.get("y", 1300))
        ev.append(f"Dialogue: 1,{_t(c['start'])},{_t(c['end'])},VO,,0,0,0,,{{\\pos(540,{y}){fs}}}{POP}{_markup(c['text'], int(round(base * 1.24 * vo_scale)), st['hl'])}")
    for s in supers:
        y = int(s.get("y", 330))
        txt = s["text"].replace("**", "").replace("\n", "\\N")  # highlight markup is VO-only
        ev.append(f"Dialogue: 0,{_t(s['start'])},{_t(s['end'])},Super,,0,0,0,,{{\\pos(540,{y})\\fad(150,150)}}{txt}")
    if counter:
        a0, end = float(counter["start"]), float(counter["end"])
        amount = int(counter["amount"])
        prefix = counter.get("prefix", "NT$")
        y = int(counter.get("y", 1000))
        size = int(counter.get("size", 210))
        color = _COLORS.get(str(counter.get("color", "gold")).lower(), _COLORS["gold"])
        if counter.get("label"):
            ev.append(f"Dialogue: 1,{_t(a0 - 0.6)},{_t(end)},VO,,0,0,0,,{{\\pos(540,{y - 220})}}{POP}{_markup(counter['label'], int(round(base * 1.24)), st['hl'])}")
        steps = 30
        dt = min(0.9, max(0.3, end - a0 - 0.4)) / steps
        for i in range(steps + 1):
            v = round(amount * (1 - (1 - i / steps) ** 3) / 10) * 10 if i < steps else amount
            a = a0 + i * dt
            b = a + dt if i < steps else end
            ev.append(f"Dialogue: 1,{_t(a)},{_t(b)},VO,,0,0,0,,{{\\pos(540,{y})}}{POP if i == 0 else ''}"
                      f"{{\\fs{size}\\c&H{color}&}}{prefix}{v:,}")
    dest.write_text(_head(style) + "\n".join(ev) + "\n")
    return dest


def burn(base: Path, ass: Path, dest: Path, dark_window: tuple[float, float] | None = None) -> Path:
    fonts = ensure_fonts()
    vf = ""
    if dark_window:
        vf += f"eq=brightness=-0.12:saturation=0.8:enable='between(t,{dark_window[0]},{dark_window[1]})',"
    vf += f"ass={ass}:fontsdir={fonts}"
    ff.ffmpeg("-i", str(base), "-vf", vf, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", str(dest))
    return dest
