"""Photos in raw/ become 5-second clips and are listed next to the videos."""
import os
import shutil
import subprocess
from pathlib import Path

os.environ.setdefault("DATA_DIR", "/tmp/lk-test-data")

import pytest  # noqa: E402

from app.pipeline import footage  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def test_photo_becomes_clip(tmp_path: Path, monkeypatch):
    root = tmp_path
    for d in ("raw", "sheets/thumbs"):
        (root / d).mkdir(parents=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=orange:s=640x480", "-frames:v", "1", str(root / "raw/IMG_1.jpg")], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=320x240:r=30", "-t", "1", "-pix_fmt", "yuv420p", str(root / "raw/DJI_1.mp4")], check=True)
    monkeypatch.setattr(footage, "_thumb", lambda *a, **k: None)   # needs the CJK font; not the point here
    rows = footage.probe_footage(root)
    assert [r["path"] for r in rows] == ["DJI_1.mp4", "IMG_1.jpg"]
    photo = rows[1]
    assert photo["photo"] and photo["w"] == 1080 and photo["h"] == 1920 and 4.8 <= photo["dur"] <= 5.2
    assert (root / "raw/.stills/IMG_1.mp4").exists()
    index = (root / "sheets/index.tsv").read_text()
    assert ".stills/IMG_1.mp4" in index and "DJI_1.mp4" in index
    # a second probe reuses the rendered still and doesn't list it twice
    assert len(footage.probe_footage(root)) == 2


def test_heic_photo(tmp_path: Path, monkeypatch):
    pytest.importorskip("pillow_heif")
    from PIL import Image
    from pillow_heif import register_heif_opener
    register_heif_opener()
    root = tmp_path
    for d in ("raw", "sheets/thumbs"):
        (root / d).mkdir(parents=True)
    Image.new("RGB", (800, 600), (230, 120, 40)).save(root / "raw/IMG_7.HEIC", format="HEIF")
    monkeypatch.setattr(footage, "_thumb", lambda *a, **k: None)
    rows = footage.probe_footage(root)
    assert rows[0]["photo"] and "error" not in rows[0] and rows[0]["w"] == 1080
    assert (root / "raw/.stills/IMG_7.jpg").exists() and (root / "raw/.stills/IMG_7.mp4").exists()
