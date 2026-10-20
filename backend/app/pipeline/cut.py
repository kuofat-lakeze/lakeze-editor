"""Assemble the picture cut: a list of (clip, start, duration) → base.mp4 at 1080x1920/30fps."""
import json
from pathlib import Path

from . import ff
from .fonts import FONTS_DIR
from .footage import load_index

W, H = 1080, 1920


def build_cut(root: Path, segments: list[dict], crf: int = 16) -> dict:
    """segments: [{clip, start, dur, crop_x?}] where crop_x in 0..1 picks the horizontal
    crop centre for landscape sources (0.5 = centre). Portrait sources are scaled to fill."""
    idx = load_index(root)
    seg_dir = root / "work" / "seg"
    for old in seg_dir.glob("*.mp4"):
        old.unlink()
    lst = []
    total = 0.0
    for i, s in enumerate(segments):
        src = root / "raw" / idx[int(s["clip"])]
        out = seg_dir / f"{i:02d}.mp4"
        cx = float(s.get("crop_x", 0.5))
        vf = (f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,"
              f"crop={W}:{H}:(iw-ow)*{cx}:(ih-oh)/2,fps=30,format=yuv420p,setsar=1")
        ff.ffmpeg("-ss", str(s["start"]), "-i", str(src), "-t", str(s["dur"]), "-an", "-vf", vf,
                  "-c:v", "libx264", "-preset", "fast", "-crf", str(crf), str(out))
        lst.append(f"file '{out}'\n")
        total += float(s["dur"])
    (seg_dir / "list.txt").write_text("".join(lst))
    at, shots = 0.0, []
    for i, s in enumerate(segments):   # timeline positions, for the 校對台's shot strip and the 時間軸 re-cut
        shot = {"i": i, "clip": int(s["clip"]), "start": float(s["start"]), "dur": float(s["dur"]), "at": round(at, 2)}
        if "crop_x" in s:
            shot["crop_x"] = float(s["crop_x"])
        shots.append(shot)
        at += float(s["dur"])
    (root / "work" / "cut.json").write_text(json.dumps(shots, ensure_ascii=False))
    base = root / "work" / "base.mp4"
    ff.ffmpeg("-f", "concat", "-safe", "0", "-i", str(seg_dir / "list.txt"), "-c", "copy", str(base))
    return {"path": base, "duration": round(ff.duration(base), 2), "planned": round(total, 2)}


def storyboard(video: Path, times: list[float], dest: Path, height: int = 266) -> Path:
    """One frame per time, labelled, stitched horizontally — used to check a cut or captions."""
    ins, fc = [], ""
    for i, t in enumerate(times):
        ins += ["-ss", str(t), "-i", str(video)]
        fc += (f"[{i}:v]scale=-2:{height},drawtext=fontfile={FONTS_DIR / 'NotoSansCJKtc-Black.otf'}:"
               f"text='{t}':x=4:y=4:fontsize=22:fontcolor=yellow:borderw=2[v{i}];")
    fc += "".join(f"[v{i}]" for i in range(len(times))) + f"hstack={len(times)}[o]"
    ff.ffmpeg(*ins, "-filter_complex", fc, "-map", "[o]", "-frames:v", "1", str(dest))
    return dest
