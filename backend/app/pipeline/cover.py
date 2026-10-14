"""Cover image: a debanded frame + the same two-layer typography as the video."""
from pathlib import Path

from . import ff
from .fonts import ensure_fonts
from .footage import load_index
from .subs import HEAD, _markup

W, H = 1080, 1920


def make_cover(root: Path, clip: int, t: float, dest: Path, *, super_text: str = "", title: list[str] | None = None,
               sub_text: str = "", price_text: str = "", crop_x: float = 0.5, gradient_from: int = 1000,
               warm: bool = False) -> dict:
    """title: up to 2 lines; first gold, second white. Positions chosen to survive 4:5 / 3:4 crops."""
    fonts = ensure_fonts()
    idx = load_index(root)
    src = root / "raw" / idx[int(clip)]
    bg = dest.with_name("bg16.png")
    # 16-bit extraction + deband removes the banding 10-bit sources show in flat skies.
    ff.ffmpeg("-ss", str(t), "-i", str(src), "-frames:v", "1", "-vf",
              f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,crop={W}:{H}:(iw-ow)*{crop_x}:(ih-oh)/2,"
              "format=rgb48le,deband=1thr=0.02:2thr=0.02:3thr=0.02:range=24:blur=1,noise=alls=3:allf=t",
              "-pix_fmt", "rgb48be", str(bg))
    ev = []
    if super_text:
        ev.append(f"Dialogue: 0,0:00:00.00,0:00:05.00,Super,,0,0,0,,{{\\pos(540,360)}}{super_text}")
    for i, line in enumerate((title or [])[:2]):
        color = "" if i == 0 else r"{\c&HFFFFFF&}"
        ev.append(f"Dialogue: 0,0:00:00.00,0:00:05.00,Title,,0,0,0,,{{\\pos(540,{600 + 220 * i})}}{color}{_markup(line)}")
    if sub_text:
        ev.append(f"Dialogue: 0,0:00:00.00,0:00:05.00,Sub,,0,0,0,,{{\\pos(540,1330)}}{sub_text}")
    if price_text:
        ev.append(f"Dialogue: 0,0:00:00.00,0:00:05.00,Title,,0,0,0,,{{\\pos(540,1475)\\fs190}}{price_text}")
    ass = dest.with_suffix(".ass")
    ass.write_text(HEAD + "\n".join(ev) + "\n")
    grade = "eq=saturation=1.18:contrast=1.04,colorbalance=rs=0.04:rh=0.03,vignette=PI/5," if warm else \
            "eq=saturation=1.1:contrast=1.03,"
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
