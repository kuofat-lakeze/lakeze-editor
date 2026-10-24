"""CapCut 素材包: everything in the finished video as separate, editable pieces, zipped.

CapCut (手機版和電腦版), 剪映, iMovie and the rest all import plain media, so the pack is plain media
laid out the way an editor wants it: every picture segment as its own clip in order, every narration
line as its own audio file (and one narration track aligned to the timeline), the music, the captions
as SRT, the covers, a caption-free copy of the video, a timeline sheet and a one-page how-to.
Built from the recipe (plan.json) and the work files of the latest render."""
from __future__ import annotations

import csv
import io
import json
import re
import zipfile
from pathlib import Path

from . import ff
from .footage import load_index

VERSION = 1


def _srt_time(s: float) -> str:
    s = max(0.0, float(s))
    ms = int(round((s - int(s)) * 1000))
    s = int(s)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d},{ms:03d}"


def _plain(text: str) -> str:
    return re.sub(r"\s+", " ", str(text).replace("**", "").replace("\\N", "\n")).strip()


def srt(cues: list[dict]) -> str:
    """[{start,end,text}] → SRT text (markup stripped)."""
    out = []
    for i, c in enumerate(sorted(cues, key=lambda x: float(x["start"])), 1):
        out.append(f"{i}\n{_srt_time(c['start'])} --> {_srt_time(c['end'])}\n{_plain(c['text'])}\n")
    return "\n".join(out)


def _safe(name: str, n: int = 14) -> str:
    s = re.sub(r'[\\/:*?"<>|\r\n]+', " ", _plain(name)).strip()
    return s[:n] or "untitled"


def _clock(s: float) -> str:
    return f"{int(s // 60)}:{s % 60:04.1f}"


README = """旅剪 TravelCut 素材包 · 怎麼在 CapCut 裡繼續剪
================================================

這個資料夾裡是你影片的每一個零件，順序和時間都標好了。

資料夾
  01_影片/      無字幕版.mp4 — 畫面＋旁白＋配樂，沒有燒字幕（最好用這支當底，字幕自己加）
                成品.mp4 — 和下載的一樣，有字幕
  02_片段/      每一段畫面一個檔，檔名的編號就是順序
  03_旁白/      每一句旁白一個檔，檔名有句子開頭；「整軌旁白.wav」是對齊好時間的整條旁白
  04_配樂/      配樂（原影片把它壓到大約 {gain}% 音量，旁白來時再自動壓低）
  05_字幕/      旁白字幕.srt、重點字卡.srt（時間已對齊）
  06_封面/      封面圖
  時間軸.csv    每段畫面、每句旁白的開始時間，用 Excel 或 Numbers 打開

CapCut 手機版（最快）
  1. 解壓縮後，把 02_片段 全選加入相簿（iPhone：檔案 App → 選取 → 分享 → 儲存影片）。
  2. CapCut → 新專案 → 依編號順序選取片段 → 新增。
  3. 音訊 → 匯入 → 選 03_旁白/整軌旁白.wav，再匯入 04_配樂。
  4. 文字 → 自動字幕，或照 05_字幕 的內容打字。
  懶人版：只匯入 01_影片/無字幕版.mp4，在上面加字幕、貼紙就好。

CapCut 電腦版 / 剪映專業版
  1. 新專案 → 匯入，把整個資料夾拖進媒體庫。
  2. 02_片段 依序拖到影片軌；03_旁白/整軌旁白.wav 和 04_配樂 各拖到一條音軌，對齊到 0:00。
  3. 文字 → 本地字幕 → 匯入 05_字幕/旁白字幕.srt。
  4. 封面在 06_封面。

小提醒
  · 片段和整軌旁白都是從 0:00 開始對齊的，直接頭對頭放就會跟原影片一樣。
  · 想改某一句旁白，只要換掉 03_旁白 裡那一個檔。
  · 這一包對應的是「{version}」。
"""


def build_pack(root: Path, dest: Path, *, project_name: str, version_label: str, covers: list[Path] | None = None,
               final_video: Path | None = None) -> dict:
    """Write the zip to `dest`. Returns {"files": n, "segments": n, "lines": n, "bytes": size}. Needs the
    recipe (plan.json) and work/ of the latest render; raises FileNotFoundError when they are gone."""
    from ..agent.tools import plan_load
    plan = plan_load(root)
    comp, caps, voice = plan.get("compose"), plan.get("captions") or {}, plan.get("voice") or {}
    if not comp:
        raise FileNotFoundError("這支影片沒有可拆的配方")
    work = root / "work"
    base, mixw, vo_only = work / "base.mp4", work / "mix.wav", work / "vo_only.wav"
    tmp = work / "pack"
    tmp.mkdir(parents=True, exist_ok=True)
    for old in tmp.glob("*"):
        old.unlink()
    files: list[tuple[str, Path | bytes]] = []
    n_seg = n_line = 0

    # 01 the video without captions (picture + full mix) and the finished one
    if base.exists() and mixw.exists():
        clean = tmp / "clean.mp4"
        ff.ffmpeg("-i", str(base), "-i", str(mixw), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                  "-shortest", "-movflags", "+faststart", str(clean))
        files.append(("01_影片/無字幕版.mp4", clean))
    if final_video and final_video.exists():
        files.append(("01_影片/成品.mp4", final_video))

    # 02 picture segments, in order. build_cut leaves them in work/seg; otherwise cut them out of base.mp4
    shots = []
    cutf = work / "cut.json"
    if cutf.exists():
        shots = json.loads(cutf.read_text())
    try:
        idx = load_index(root)
    except FileNotFoundError:
        idx = {}
    rows_seg = []
    for k, s in enumerate(shots):
        seg = work / "seg" / f"{k:02d}.mp4"
        if not seg.exists() and base.exists():
            seg = tmp / f"seg{k:02d}.mp4"
            ff.ffmpeg("-ss", str(s["at"]), "-i", str(base), "-t", str(s["dur"]), "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "17", str(seg))
        if seg.exists():
            files.append((f"02_片段/{k + 1:02d}.mp4", seg))
            n_seg += 1
        src = idx.get(int(s.get("clip", -1)), "")
        rows_seg.append([k + 1, _clock(float(s["at"])), f"{float(s['dur']):.1f}", Path(src).name if src else "", f"{float(s.get('start', 0)):.1f}" if src else ""])

    # 03 narration: one file per line, plus the aligned full track
    texts = voice.get("lines") or {}
    placements = sorted(comp.get("placements") or [], key=lambda x: float(x["at"]))
    rows_line = []
    for i, p in enumerate(placements, 1):
        wav = work / "vo" / f"{p['key']}.wav"
        if not wav.exists():
            continue
        text = _plain(texts.get(p["key"], p["key"]))
        mp3 = tmp / f"line{i:02d}.mp3"
        ff.ffmpeg("-i", str(wav), "-c:a", "libmp3lame", "-b:a", "128k", str(mp3))
        name = f"03_旁白/{i:02d}_{_safe(text)}.mp3"
        files.append((name, mp3))
        n_line += 1
        rows_line.append([i, _clock(float(p["at"])), text, Path(name).name])
    if vo_only.exists():
        files.append(("03_旁白/整軌旁白.wav", vo_only))

    # 04 music and sound effects
    music = work / f"{comp['music']}.mp3" if comp.get("music") else None
    if music and music.exists():
        files.append(("04_配樂/配樂.mp3", music))
    for s in comp.get("sfx") or []:
        f = work / f"sfx_{s['name']}.mp3"
        if f.exists():
            files.append((f"04_配樂/音效_{_safe(s['name'])}_{_clock(float(s['at'])).replace(':', 'm')}s.mp3", f))

    # 05 captions
    if caps.get("vo"):
        files.append(("05_字幕/旁白字幕.srt", srt(caps["vo"]).encode("utf-8")))
    if caps.get("supers"):
        files.append(("05_字幕/重點字卡.srt", srt(caps["supers"]).encode("utf-8")))

    # 06 covers
    for i, c in enumerate(covers or [], 1):
        if c.exists():
            files.append((f"06_封面/封面{i}{c.suffix.lower() or '.jpg'}", c))

    # the timeline sheet (Excel-friendly: BOM + CRLF)
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(["畫面段落", "開始", "長度(秒)", "原始素材", "素材起點(秒)"])
    w.writerows(rows_seg)
    w.writerow([])
    w.writerow(["旁白", "開始", "內容", "檔名"])
    w.writerows(rows_line)
    if caps.get("supers"):
        w.writerow([])
        w.writerow(["重點字卡", "開始", "結束", "內容"])
        for i, s in enumerate(sorted(caps["supers"], key=lambda x: float(x["start"])), 1):
            w.writerow([i, _clock(float(s["start"])), _clock(float(s["end"])), _plain(s["text"])])
    if caps.get("counter"):
        c = caps["counter"]
        w.writerow([])
        w.writerow(["價格數字", _clock(float(c["start"])), _clock(float(c["end"])), f"{c.get('prefix', 'NT$')}{c.get('amount', '')} {_plain(c.get('label', ''))}".strip()])
    files.append(("時間軸.csv", ("﻿" + buf.getvalue()).encode("utf-8")))
    gain = int(round(float(comp.get("music_gain", 0.55)) * 100))
    files.append(("讀我.txt", README.format(gain=gain, version=f"{project_name} {version_label}".strip()).encode("utf-8")))

    dest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest, "w") as z:
        for name, src in files:
            if isinstance(src, bytes):
                z.writestr(name, src, compress_type=zipfile.ZIP_DEFLATED)
            else:
                z.write(src, name, compress_type=zipfile.ZIP_STORED)   # media is already compressed
    for old in tmp.glob("*"):
        old.unlink()
    return {"files": len(files), "segments": n_seg, "lines": n_line, "bytes": dest.stat().st_size}
