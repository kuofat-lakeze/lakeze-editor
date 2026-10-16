"""Cover image: a debanded frame + the same two-layer typography as the video."""
from pathlib import Path

from . import ff
from .fonts import ensure_fonts
from .footage import load_index
from .subs import HEAD, _markup

W, H = 1080, 1920


STYLES = ("bold", "magazine", "minimal")
BRAND, INK, GOLD, WHITE = "&H1E5AEC&", "&H2E2622&", "&H37C0F5&", "&HFFFFFF&"   # ASS colours are &HBBGGRR&


def _rect(x: int, y: int, w: int, h: int, colour: str, alpha: str = "&H00&", r: int = 0) -> str:
    """A filled (optionally rounded) rectangle as an ASS vector drawing, top-left at (x, y)."""
    if r:
        path = (f"m {r} 0 l {w - r} 0 b {w} 0 {w} 0 {w} {r} l {w} {h - r} b {w} {h} {w} {h} {w - r} {h} "
                f"l {r} {h} b 0 {h} 0 {h} 0 {h - r} l 0 {r} b 0 0 0 0 {r} 0")
    else:
        path = f"m 0 0 l {w} 0 l {w} {h} l 0 {h}"
    return f"Dialogue: 0,0:00:00.00,0:00:05.00,Sub,,0,0,0,,{{\\an7\\pos({x},{y})\\bord0\\shad0\\1c{colour}\\1a{alpha}\\p1}}{path}{{\\p0}}"


def _events(style: str, super_text: str, title: list[str], sub_text: str, price_text: str) -> list[str]:
    """Three layouts that look clearly different, all inside the 4:5 (y 285–1635) and 3:4 safe areas."""
    d = "Dialogue: 1,0:00:00.00,0:00:05.00"
    ev: list[str] = []
    if style == "magazine":
        # solid brand band with the shop name, big left-aligned title over the photo, price in a tag
        if super_text:
            ev += [_rect(0, 300, 1080, 150, BRAND),
                   f"{d},Super,,0,0,0,,{{\\an4\\pos(70,375)\\bord0\\shad0\\fs68\\fsp6\\c{WHITE}}}{super_text}"]
        for i, line in enumerate(title[:2]):
            ev.append(f"{d},Title,,0,0,0,,{{\\an1\\pos(64,{1150 + 175 * i})\\fs165\\bord0\\shad7\\4a&H60&\\c{WHITE if i == 0 else GOLD}}}{_markup(line, 180)}")
        if sub_text:
            ev.append(f"{d},Sub,,0,0,0,,{{\\an7\\pos(70,1350)\\fs66\\bord0\\shad4}}{sub_text}")
        if price_text:
            ev += [_rect(64, 1450, 560, 160, BRAND, r=28),
                   f"{d},Title,,0,0,0,,{{\\an4\\pos(104,1530)\\fs118\\bord0\\shad0\\c{WHITE}}}{price_text}"]
    elif style == "minimal":
        # thin white frame, a light card in the lower third, dark type, price in a pill
        ev.append(f"Dialogue: 0,0:00:00.00,0:00:05.00,Sub,,0,0,0,,{{\\an7\\pos(40,40)\\1a&HFF&\\bord5\\3c{WHITE}\\shad0\\p1}}m 0 0 l 1000 0 l 1000 1840 l 0 1840{{\\p0}}")
        ev.append(_rect(90, 1040, 900, 560, WHITE, "&H14&", r=36))
        if super_text:
            ev.append(f"{d},Sub,,0,0,0,,{{\\an5\\pos(540,1110)\\fs52\\fsp8\\bord0\\shad0\\c{BRAND}}}{super_text}")
        for i, line in enumerate(title[:2]):
            ev.append(f"{d},Title,,0,0,0,,{{\\an5\\pos(540,{1215 + 140 * i})\\fs118\\bord0\\shad0\\c{INK if i == 0 else BRAND}}}{line.replace('**', '')}")
        if sub_text:
            ev.append(f"{d},Sub,,0,0,0,,{{\\an5\\pos(540,1430)\\fs56\\bord0\\shad0\\c&H6E6A66&}}{sub_text}")
        if price_text:
            ev += [_rect(330, 1475, 420, 100, BRAND, r=50),
                   f"{d},Title,,0,0,0,,{{\\an5\\pos(540,1527)\\fs76\\bord0\\shad0\\c{WHITE}}}{price_text}"]
    else:   # bold: the video's own typography, big gold/white title in the upper half
        if super_text:
            ev.append(f"{d},Super,,0,0,0,,{{\\pos(540,360)}}{super_text}")
        for i, line in enumerate(title[:2]):
            color = "" if i == 0 else r"{\c&HFFFFFF&}"
            ev.append(f"{d},Title,,0,0,0,,{{\\pos(540,{600 + 220 * i})}}{color}{_markup(line)}")
        if sub_text:
            ev.append(f"{d},Sub,,0,0,0,,{{\\pos(540,1330)}}{sub_text}")
        if price_text:
            ev.append(f"{d},Title,,0,0,0,,{{\\pos(540,1475)\\fs190}}{price_text}")
    return ev


def make_cover(root: Path, clip: int, t: float, dest: Path, *, super_text: str = "", title: list[str] | None = None,
               sub_text: str = "", price_text: str = "", crop_x: float = 0.5, gradient_from: int | None = None,
               warm: bool = False, style: str = "bold") -> dict:
    """style: bold (big gold/white title, the video's look) | magazine (brand band, left-aligned title,
    price tag) | minimal (white frame, light card, dark type). Positions survive 4:5 / 3:4 crops."""
    style = style if style in STYLES else "bold"
    fonts = ensure_fonts()
    idx = load_index(root)
    src = root / "raw" / idx[int(clip)]
    bg = dest.with_name("bg16.png")
    # 16-bit extraction + deband removes the banding 10-bit sources show in flat skies.
    ff.ffmpeg("-ss", str(t), "-i", str(src), "-frames:v", "1", "-vf",
              f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,crop={W}:{H}:(iw-ow)*{crop_x}:(ih-oh)/2,"
              "format=rgb48le,deband=1thr=0.02:2thr=0.02:3thr=0.02:range=24:blur=1,noise=alls=3:allf=t",
              "-pix_fmt", "rgb48be", str(bg))
    ev = _events(style, super_text, title or [], sub_text, price_text)
    ass = dest.with_suffix(".ass")
    ass.write_text(HEAD + "\n".join(ev) + "\n")
    grade = "eq=saturation=1.18:contrast=1.04,colorbalance=rs=0.04:rh=0.03,vignette=PI/5," if warm else \
            "eq=saturation=1.05:contrast=1.0:brightness=0.03," if style == "minimal" else "eq=saturation=1.1:contrast=1.03,"
    if gradient_from is None:   # dark fade at the bottom where the type sits; the minimal card needs none
        gradient_from = {"bold": 1000, "magazine": 950, "minimal": H}[style]
    png = dest.with_suffix(".png")
    ff.ffmpeg("-i", str(bg), "-f", "lavfi", "-i",
              f"color=black:s={W}x{H},format=rgba,geq=r=0:g=0:b=0:a='if(lt(Y,{gradient_from}),0,min(150,(Y-{gradient_from})*0.25))'",
              "-filter_complex", f"[0:v]format=rgb48le,{grade}format=rgba[b];[b][1:v]overlay,format=rgb24,ass={ass}:fontsdir={fonts}",
              "-frames:v", "1", str(png))
    ff.ffmpeg("-i", str(png), "-q:v", "2", str(dest))
    # Crop check: full 9:16, IG grid 4:5, 3:4 side by side.
    check = dest.with_name(dest.stem + "_check.jpg")
    ff.ffmpeg("-i", str(dest), "-filter_complex",
              "[0:v]scale=-2:640[a];[0:v]crop=1080:1350:0:285,scale=-2:640[b];[0:v]crop=1080:1440:0:240,scale=-2:640[c];[a][b][c]hstack=3",
              str(check))
    return {"cover": dest, "check": check}
