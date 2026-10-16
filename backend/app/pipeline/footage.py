"""Footage intake: Google Drive folder listing/download, local uploads, probing, contact sheets."""
import json
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import ff
from .fonts import FONTS_DIR

VIDEO_EXT = (".mp4", ".mov", ".m4v")
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif")
STILL_SECONDS = 5.0


def still_to_clip(img: Path, dest: Path, seconds: float = STILL_SECONDS) -> Path:
    """A photo becomes a short vertical clip with a slow push-in, so the cut can treat it like footage.
    Cover-fit to 1080x1920 (portrait is what every export uses), 30 fps, no audio."""
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    frames = int(seconds * 30)
    vf = ("scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840,"
          f"zoompan=z='min(zoom+0.0006,1.12)':d={frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30,"
          "format=yuv420p")
    ff.ffmpeg("-y", "-loop", "1", "-framerate", "30", "-i", str(img), "-vf", vf, "-t", f"{seconds}", "-an",
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", str(dest))
    return dest
DRIVE_DL = "https://drive.usercontent.google.com/download?id={id}&export=download&confirm=t"


def list_drive_folder(url: str, root: Path) -> list[dict]:
    """Return [{id, path}] for every file in a shared Drive folder (no download)."""
    import gdown  # heavy import, keep local
    m = re.search(r"folders/([\w-]+)", url)
    if not m:
        raise ValueError("not a Google Drive folder link")
    files = gdown.download_folder(f"https://drive.google.com/drive/folders/{m.group(1)}",
                                  output=str(root / "raw") + "/", skip_download=True, quiet=True)
    if not files:
        raise ValueError("folder is empty or not shared publicly (需要「知道連結的人都能檢視」)")
    out = []
    for f in files:
        rel = str(Path(f.local_path).relative_to(root / "raw"))
        out.append({"id": f.id, "path": rel})
    # Duplicate names (same folder, same filename) collide on disk: suffix with the id.
    seen: dict[str, int] = {}
    for f in out:
        seen[f["path"]] = seen.get(f["path"], 0) + 1
    for f in out:
        if seen[f["path"]] > 1:
            p = Path(f["path"])
            f["path"] = str(p.with_name(f"{p.stem}_{f['id'][:6]}{p.suffix}"))
    (root / "sheets" / "drive.json").write_text(json.dumps(out, ensure_ascii=False))
    return out


def _dl(item: dict, root: Path) -> str:
    dest = root / "raw" / item["path"]
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 1024:
        return f"skip {item['path']}"
    subprocess.run(["curl", "-sS", "-L", "--retry", "4", "-o", str(dest), DRIVE_DL.format(id=item["id"])],
                   check=True, timeout=3600)
    if dest.stat().st_size < 1024:  # HTML error page, not media
        dest.unlink()
        raise RuntimeError(f"download failed: {item['path']}")
    return f"ok {item['path']} {dest.stat().st_size // 2**20}MB"


def download_drive(items: list[dict], root: Path, parallel: int = 4) -> list[str]:
    with ThreadPoolExecutor(parallel) as ex:
        return list(ex.map(lambda it: _dl(it, root), items))


def _thumb(n: int, p: Path, d: float, th: Path) -> None:
    if th.exists():
        return
    ins, fc = [], ""
    for k in range(4):
        ins += ["-ss", f"{d * (k + 0.5) / 4:.2f}", "-i", str(p)]
        fc += f"[{k}:v]scale=-2:240,setsar=1[v{k}];"
    fc += "[v0][v1][v2][v3]hstack=4,drawtext=fontfile=%s:text='#%02d':x=8:y=8:fontsize=36:fontcolor=yellow:borderw=3[o]" % (
        FONTS_DIR / "NotoSansCJKtc-Black.otf", n)
    ff.ffmpeg(*ins, "-filter_complex", fc, "-map", "[o]", "-frames:v", "1", str(th))


def probe_footage(root: Path) -> list[dict]:
    """Index every clip under raw/, write sheets/index.tsv, make per-clip thumbnails."""
    raw = root / "raw"
    stills = raw / ".stills"   # photos rendered as clips live here; hidden from the listing below
    files = sorted(p for p in raw.rglob("*") if p.is_file() and stills not in p.parents
                   and p.suffix.lower() in VIDEO_EXT + IMAGE_EXT)
    rows = []
    for n, p in enumerate(files, 1):
        rel = str(p.relative_to(raw))
        photo = p.suffix.lower() in IMAGE_EXT
        try:
            if photo:
                p = still_to_clip(p, stills / f"{p.stem}.mp4")
            info = ff.video_info(p)
        except Exception as e:  # unreadable file: keep going, report it
            msg = str(e)[:120]
            if photo and p.suffix.lower() in (".heic", ".heif"):
                msg = "HEIC 讀不了，請在手機相簿分享時選「最相容」或改存 JPG"
            rows.append({"n": n, "path": rel, "error": msg, **({"photo": True} if photo else {})})
            continue
        rows.append({"n": n, "path": rel, "dur": round(info["duration"], 1),
                     "w": info["width"], "h": info["height"], "fps": info["fps"], "pix": info["pix_fmt"],
                     "mb": p.stat().st_size // 2**20, **({"photo": True, "clip": str(p.relative_to(raw))} if photo else {})})
        _thumb(n, p, info["duration"], root / "sheets" / "thumbs" / f"{n:02d}.jpg")
    with open(root / "sheets" / "index.tsv", "w") as f:
        for r in rows:
            if "error" in r:
                continue
            f.write(f"{r['n']:02d}\t{r['dur']}s\t{r['w']},{r['h']},{r['fps']}\t{r['mb']}MB\t{r.get('clip', r['path'])}\n")
    return rows


def contact_sheets(root: Path, per_sheet: int = 16) -> list[Path]:
    """Stack thumbnails two per row into sheet images (the agent looks at these)."""
    thumbs = sorted((root / "sheets" / "thumbs").glob("*.jpg"))
    out = []
    for g in range(0, len(thumbs), per_sheet):
        chunk = thumbs[g:g + per_sheet]
        dest = root / "sheets" / f"sheet{g // per_sheet}.jpg"
        ins, fc = [], ""
        for i, t in enumerate(chunk):
            ins += ["-i", str(t)]
            fc += f"[{i}:v]scale=-2:150,pad=iw:ih+4[p{i}];"
        rows = (len(chunk) + 1) // 2
        layout = "|".join(f"{'0' if i % 2 == 0 else 'w0'}_{'0' if i < 2 else '+'.join(['h0'] * (i // 2))}"
                          for i in range(len(chunk)))
        if len(chunk) == 1:
            fc += "[p0]copy[o]"
        else:
            fc += "".join(f"[p{i}]" for i in range(len(chunk))) + f"xstack=inputs={len(chunk)}:layout={layout}:fill=black[o]"
        ff.ffmpeg(*ins, "-filter_complex", fc, "-map", "[o]", "-frames:v", "1", str(dest))
        out.append(dest)
        _ = rows
    return out


def sample_frames(root: Path, samples: list[dict], dest: Path, height: int = 400) -> Path:
    """Stitch frames [{clip, t}] side by side, each labelled, for close inspection."""
    idx = load_index(root)
    if len(samples) > 6:  # keep the strip under the API's 8000 px limit (12 landscape frames @400px ≈ 8500 px)
        height = 240
    ins, fc = [], ""
    for i, s in enumerate(samples):
        p = root / "raw" / idx[int(s["clip"])]
        ins += ["-ss", str(s["t"]), "-i", str(p)]
        fc += (f"[{i}:v]scale=-2:{height},drawtext=fontfile={FONTS_DIR / 'NotoSansCJKtc-Black.otf'}:"
               f"text='#{int(s['clip']):02d}@{s['t']}':x=4:y=4:fontsize=24:fontcolor=yellow:borderw=2[v{i}];")
    fc += "".join(f"[v{i}]" for i in range(len(samples))) + (f"hstack={len(samples)}[o]" if len(samples) > 1 else "copy[o]")
    ff.ffmpeg(*ins, "-filter_complex", fc.replace("[v0]copy", "[v0]copy"), "-map", "[o]", "-frames:v", "1", str(dest))
    return dest


def load_index(root: Path) -> dict[int, str]:
    idx = {}
    f = root / "sheets" / "index.tsv"
    if not f.exists():
        raise FileNotFoundError("尚未分析素材，先呼叫 probe_footage")
    for line in f.read_text().splitlines():
        p = line.split("\t")
        idx[int(p[0])] = p[4]
    return idx
