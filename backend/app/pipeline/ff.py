"""Thin ffmpeg / ffprobe helpers shared by the pipeline."""
import json
import subprocess
from pathlib import Path


class FFError(RuntimeError):
    pass


def run(args: list[str], timeout: int = 1800) -> str:
    """Run ffmpeg/ffprobe quietly; raise FFError with stderr tail on failure."""
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise FFError(p.stderr.strip()[-1500:] or f"exit {p.returncode}: {' '.join(args[:4])}")
    return p.stdout


def ffmpeg(*args: str, timeout: int = 1800) -> None:
    run(["ffmpeg", "-v", "error", "-y", *args], timeout=timeout)


def duration(path: Path) -> float:
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
    return float(out.strip() or 0)


def video_info(path: Path) -> dict:
    j = json.loads(run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,pix_fmt:stream_side_data=rotation:format=duration",
        "-of", "json", str(path)]))
    s = j["streams"][0]
    rot = next((sd.get("rotation") for sd in s.get("side_data_list", []) if "rotation" in sd), 0)
    w, h = s["width"], s["height"]
    if abs(int(rot)) % 180 == 90:
        w, h = h, w
    return {"width": w, "height": h, "fps": s["r_frame_rate"], "pix_fmt": s.get("pix_fmt"),
            "rotation": rot, "duration": float(j["format"]["duration"])}


def image_size(path: Path) -> tuple[int, int]:
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
               "-of", "csv=p=0", str(path)])
    w, h = out.strip().split(",")[:2]
    return int(w), int(h)


def fit_image(path: Path, max_px: int = 7800) -> Path:
    """Shrink an image in place so neither side exceeds max_px (the Claude API rejects images > 8000 px)."""
    w, h = image_size(path)
    if max(w, h) <= max_px:
        return path
    tmp = path.with_name(path.stem + "_fit" + path.suffix)
    ffmpeg("-i", str(path), "-vf", f"scale='min(iw,{max_px})':'min(ih,{max_px})':force_original_aspect_ratio=decrease",
           "-frames:v", "1", str(tmp))
    tmp.replace(path)
    return path


def silences(path: Path, noise_db: float = -40, min_dur: float = 0.12) -> list[tuple[float, float]]:
    """Return (start, end) silence spans detected by silencedetect."""
    p = subprocess.run(["ffmpeg", "-i", str(path), "-af", f"silencedetect=n={noise_db}dB:d={min_dur}",
                        "-f", "null", "-"], capture_output=True, text=True)
    starts, ends = [], []
    for line in p.stderr.splitlines():
        if "silence_start:" in line:
            starts.append(float(line.split("silence_start:")[1].split()[0]))
        elif "silence_end:" in line:
            ends.append(float(line.split("silence_end:")[1].split()[0]))
    return list(zip(starts, ends))


def mean_volume(path: Path, start: float, end: float) -> float:
    p = subprocess.run(["ffmpeg", "-ss", str(start), "-to", str(end), "-i", str(path),
                        "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True)
    for line in p.stderr.splitlines():
        if "mean_volume:" in line:
            return float(line.split("mean_volume:")[1].split()[0])
    return -99.0
