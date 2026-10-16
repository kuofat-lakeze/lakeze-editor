"""Tool definitions the editor agent can call, and the dispatcher that runs them.

Every tool returns a list of tool_result content blocks (text and, where it helps the
model judge the picture, images). Files meant for the user are registered as assets
through ctx.add_asset and surfaced as cards by the frontend.
"""
import base64
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from ..pipeline import cover as cover_mod
from ..pipeline import cut, eleven, ff, footage, mix, subs


@dataclass
class ToolContext:
    root: Path
    add_asset: Callable[..., dict]            # (path, kind, name, meta=None) -> {id,url}
    record_usage: Callable[..., None]         # (kind, units, meta=None)
    notes: dict = field(default_factory=dict)


def _text(s: str) -> dict:
    return {"type": "text", "text": s}


def _image(p: Path) -> dict:
    ff.fit_image(p)  # the API rejects images wider/taller than 8000 px; a bad image would poison the whole history
    data = base64.standard_b64encode(p.read_bytes()).decode()
    media = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
    return {"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}


def _j(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=None)


_SEG = {"type": "object", "additionalProperties": False, "required": ["clip", "start", "dur"],
        "properties": {"clip": {"type": "integer", "description": "素材編號（probe_footage 的 #）"},
                       "start": {"type": "number", "description": "來源起點秒"},
                       "dur": {"type": "number", "description": "長度秒"},
                       "crop_x": {"type": "number", "description": "橫式素材裁切中心 0–1，預設 0.5"}}}
_CAP = {"type": "object", "additionalProperties": False, "required": ["start", "end", "text"],
        "properties": {"start": {"type": "number"}, "end": {"type": "number"},
                       "text": {"type": "string", "description": "可用 **字** 標記放大白字的重點詞"},
                       "y": {"type": "integer", "description": "垂直位置，旁白預設 1300、Super 預設 330"}}}

TOOLS: list[dict] = [
    {"name": "list_drive_folder", "description": "列出 Google Drive 共用資料夾裡的檔案（不下載）。回傳 id 與相對路徑。",
     "input_schema": {"type": "object", "additionalProperties": False, "required": ["url"],
                      "properties": {"url": {"type": "string"}}}},
    {"name": "download_footage", "description": "下載 Drive 資料夾的檔案到專案。ids 省略時下載全部。4 支平行，4.5GB 約 10 分鐘。",
     "input_schema": {"type": "object", "additionalProperties": False,
                      "properties": {"ids": {"type": "array", "items": {"type": "string"}}}}},
    {"name": "probe_footage", "description": "分析專案裡所有影片（含用戶上傳）：長度、解析度、編號，並回傳縮圖總表圖片讓你看畫面。素材變動後要重跑。",
     "input_schema": {"type": "object", "additionalProperties": False, "properties": {}}},
    {"name": "sample_frames", "description": "把指定片段的指定秒數畫面放大拼成一張圖，用來細看某個鏡頭。最多 12 格。",
     "input_schema": {"type": "object", "additionalProperties": False, "required": ["samples"],
                      "properties": {"samples": {"type": "array", "description": "最多 12 格", "items": {
                          "type": "object", "additionalProperties": False, "required": ["clip", "t"],
                          "properties": {"clip": {"type": "integer"}, "t": {"type": "number"}}}}}}},
    {"name": "build_cut", "description": "依片段清單剪出無聲畫面 base.mp4（1080x1920/30fps），回傳分鏡圖與一支預覽影片。總長建議 36–37 秒。",
     "input_schema": {"type": "object", "additionalProperties": False, "required": ["segments"],
                      "properties": {"segments": {"type": "array", "items": _SEG}}}},
    {"name": "search_voices", "description": "在 ElevenLabs Voice Library 搜尋聲音。預設找台灣腔中文。",
     "input_schema": {"type": "object", "additionalProperties": False,
                      "properties": {"query": {"type": "string"}, "accent": {"type": "string", "description": "預設 taiwanese"},
                                     "language": {"type": "string", "description": "預設 zh"}}}},
    {"name": "generate_voice", "description": "用 ElevenLabs 生成旁白，每句獨立檔案並自動用語音辨識核對（match<0.9 會自動重錄最多 3 次）。扣點數。deliver=true 時把音檔當試聽卡片給用戶。",
     "input_schema": {"type": "object", "additionalProperties": False, "required": ["lines", "voice_id"],
                      "properties": {"lines": {"type": "array", "items": {
                          "type": "object", "additionalProperties": False, "required": ["key", "text"],
                          "properties": {"key": {"type": "string", "description": "英數字短代號，如 A、B、C2"},
                                         "text": {"type": "string"}}}},
                                     "voice_id": {"type": "string"},
                                     "tags": {"type": "string", "description": "v3 情緒標籤，預設 [excited]"},
                                     "stability": {"type": "number"}, "speed": {"type": "number"},
                                     "model": {"type": "string", "description": "eleven_v3（預設）或 eleven_multilingual_v2"},
                                     "deliver": {"type": "boolean"}}}},
    {"name": "generate_music", "description": "用 ElevenLabs Music 生成配樂（扣點數）。回傳 mp3 試聽卡片。",
     "input_schema": {"type": "object", "additionalProperties": False, "required": ["prompt", "seconds"],
                      "properties": {"prompt": {"type": "string"}, "seconds": {"type": "integer", "description": "10–120"},
                                     "name": {"type": "string", "description": "檔名代號，預設 music_v1"}}}},
    {"name": "generate_sfx", "description": "用 ElevenLabs 生成音效（扣點數），例如海浪、冒泡、轉場咻聲。",
     "input_schema": {"type": "object", "additionalProperties": False, "required": ["prompt", "seconds", "name"],
                      "properties": {"prompt": {"type": "string"}, "seconds": {"type": "number"}, "name": {"type": "string"}}}},
    {"name": "preview_video", "description": "把目前的畫面（有字幕版優先，否則 base）配上一首配樂做 720p 預覽卡片給用戶。",
     "input_schema": {"type": "object", "additionalProperties": False,
                      "properties": {"music": {"type": "string", "description": "generate_music 的 name"}}}},
    {"name": "compose_audio", "description": "把旁白句子放到時間軸、配樂自動壓低（ducking）、響度正規化。回傳整條旁白的逐字時間點，用來寫字幕。",
     "input_schema": {"type": "object", "additionalProperties": False, "required": ["placements"],
                      "properties": {"placements": {"type": "array", "items": {
                          "type": "object", "additionalProperties": False, "required": ["key", "at"],
                          "properties": {"key": {"type": "string"}, "at": {"type": "number", "description": "開始秒"},
                                         "tempo": {"type": "number", "description": "加速倍率 1.0–1.4"},
                                         "trim_end": {"type": "number", "description": "只用到第幾秒（拆句用）"}}}},
                                     "music": {"type": "string", "description": "generate_music 的 name，省略為無配樂"},
                                     "music_gain": {"type": "number"}, "duck_ratio": {"type": "number"},
                                     "sfx": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                                                         "required": ["name", "at"],
                                                                         "properties": {"name": {"type": "string"}, "at": {"type": "number"},
                                                                                        "gain": {"type": "number"}}}}}}},
    {"name": "render_captions", "description": "燒兩層字幕：vo（旁白逐字，下方金字）與 supers（旁白沒說的補充，上方藍底白字）；counter 做價格跳數並壓暗畫面。回傳抽格檢查圖。",
     "input_schema": {"type": "object", "additionalProperties": False, "required": ["vo"],
                      "properties": {"vo": {"type": "array", "items": _CAP}, "supers": {"type": "array", "items": _CAP},
                                     "counter": {"type": "object", "additionalProperties": False,
                                                 "required": ["start", "end", "amount"],
                                                 "properties": {"start": {"type": "number"}, "end": {"type": "number"},
                                                                "amount": {"type": "integer"}, "prefix": {"type": "string"},
                                                                "label": {"type": "string", "description": "如「平日每人」"}}},
                                     "check_times": {"type": "array", "items": {"type": "number"},
                                                     "description": "要抽格檢查的秒數，省略則自動"}}}},
    {"name": "export_video", "description": "合成畫面與混音，輸出母帶、上傳用 1080p（<30MB）、預覽 720p 三個檔案給用戶。",
     "input_schema": {"type": "object", "additionalProperties": False,
                      "properties": {"stem": {"type": "string", "description": "檔名，預設 final"}}}},
    {"name": "make_cover", "description": "做封面（1080x1920）。抽指定畫面並去色帶，標題最多兩行（第一行金、第二行白），價格放在 4:5 安全區。回傳封面卡片與裁切檢查圖。",
     "input_schema": {"type": "object", "additionalProperties": False, "required": ["clip", "t", "title"],
                      "properties": {"clip": {"type": "integer"}, "t": {"type": "number"},
                                     "title": {"type": "array", "items": {"type": "string"}, "description": "最多兩行"},
                                     "super_text": {"type": "string"}, "sub_text": {"type": "string"},
                                     "price_text": {"type": "string"}, "crop_x": {"type": "number"},
                                     "warm": {"type": "boolean"}, "name": {"type": "string"}}}},
]


def dispatch(name: str, inp: dict, ctx: ToolContext) -> list[dict]:
    fn = _HANDLERS.get(name)
    if fn is None:
        raise ValueError(f"unknown tool {name}")
    return fn(inp, ctx)


# ---- handlers ------------------------------------------------------------------

def _list_drive(inp, ctx):
    items = footage.list_drive_folder(inp["url"], ctx.root)
    lines = [f"{it['id']}\t{it['path']}" for it in items]
    return [_text(f"{len(items)} 個檔案\n" + "\n".join(lines))]


def _download(inp, ctx):
    f = ctx.root / "sheets" / "drive.json"
    if not f.exists():
        return [_text("先呼叫 list_drive_folder")]
    items = json.loads(f.read_text())
    ids = set(inp.get("ids") or [])
    if ids:
        items = [it for it in items if it["id"] in ids]
    res = footage.download_drive(items, ctx.root)
    failed = [r for r in res if not r.startswith(("ok", "skip"))]
    return [_text(f"下載完成 {len(res) - len(failed)}/{len(res)}" + ("\n失敗：" + "\n".join(failed) if failed else ""))]


def _probe(inp, ctx):
    rows = footage.probe_footage(ctx.root)
    if not rows:
        return [_text("專案裡沒有影片。請用戶上傳或給 Drive 連結。")]
    sheets = footage.contact_sheets(ctx.root)
    table = "\n".join(f"#{r['n']:02d}\t{r.get('dur', '?')}s\t{r.get('w', '?')}x{r.get('h', '?')}\t{r['path']}"
                      + (f"\tERROR {r['error']}" if "error" in r else "") for r in rows)
    out = [_text(f"{len(rows)} 支素材（每支 4 格縮圖，時間由左到右）：\n{table}")]
    for s in sheets:
        out.append(_image(s))
    return out


def _sample(inp, ctx):
    dest = ctx.root / "sheets" / "sample.jpg"
    footage.sample_frames(ctx.root, inp["samples"][:12], dest)
    return [_text("畫面如下，標籤為 #片段@秒"), _image(dest)]


def _build_cut(inp, ctx):
    r = cut.build_cut(ctx.root, inp["segments"])
    ctx.notes["segments"] = inp["segments"]
    dur = r["duration"]
    times = [round(x, 1) for x in _spread(dur, 16)]
    sb = cut.storyboard(r["path"], times, ctx.root / "sheets" / "storyboard.jpg")
    prev = ctx.root / "out" / "cut_preview.mp4"
    ff.ffmpeg("-i", str(r["path"]), "-vf", "scale=540:960", "-c:v", "libx264", "-crf", "28", "-preset", "fast", "-an", str(prev))
    a = ctx.add_asset(prev, "video", "剪輯預覽（無聲）")
    starts, acc = [], 0.0
    for s in inp["segments"]:
        starts.append(round(acc, 2))
        acc += float(s["dur"])
    return [_text(f"base.mp4 {dur}s，{len(inp['segments'])} 段，各段起點秒：{starts}。預覽卡片 {a['id']}。分鏡圖："),
            _image(sb)]


def _spread(dur: float, n: int) -> list[float]:
    return [dur * (i + 0.5) / n for i in range(n)]


def _search_voices(inp, ctx):
    v = eleven.search_voices(inp.get("query", ""), inp.get("language", "zh"), inp.get("accent", "taiwanese"))
    return [_text(_j(v))]


def _voice(inp, ctx):
    vo_dir = ctx.root / "work" / "vo"
    res = eleven.tts_verified(inp["lines"], inp["voice_id"], vo_dir, model=inp.get("model", "eleven_v3"),
                              tags=inp.get("tags", "[excited]"), stability=inp.get("stability", 0.5),
                              speed=inp.get("speed", 1.0))
    chars = sum(len(l["text"]) * r["takes"] for l, r in zip(inp["lines"], res))
    ctx.record_usage("elevenlabs_tts_chars", chars, {"voice_id": inp["voice_id"]})
    if inp.get("deliver"):
        for r in res:
            r["asset"] = ctx.add_asset(vo_dir / r["file"], "audio", f"旁白試聽 {r['key']}：{r['text'][:20]}")["id"]
    bad = [r["key"] for r in res if not r["ok"]]
    note = f"\n⚠ 這些句子核對未通過，請改寫或重錄：{bad}" if bad else "\n全部句子核對通過。"
    return [_text(_j(res) + note)]


def _music(inp, ctx):
    name = inp.get("name", "music_v1")
    dest = ctx.root / "work" / f"{name}.mp3"
    seconds = max(10, min(120, int(inp["seconds"])))
    eleven.music(inp["prompt"], seconds, dest)
    ctx.record_usage("elevenlabs_music_sec", seconds, {"name": name})
    a = ctx.add_asset(dest, "audio", f"配樂試聽 {name}")
    return [_text(f"配樂 {name} 完成，{ff.duration(dest):.1f}s，卡片 {a['id']}")]


def _sfx(inp, ctx):
    dest = ctx.root / "work" / f"sfx_{inp['name']}.mp3"
    eleven.sound_effect(inp["prompt"], inp["seconds"], dest)
    ctx.record_usage("elevenlabs_sfx_sec", inp["seconds"], {"name": inp["name"]})
    return [_text(f"音效 {inp['name']} 完成，{ff.duration(dest):.1f}s")]


def _preview(inp, ctx):
    video = ctx.root / "work" / "video.mp4"
    if not video.exists():
        video = ctx.root / "work" / "base.mp4"
    if not video.exists():
        return [_text("還沒有畫面，先 build_cut")]
    dest = ctx.root / "out" / "preview.mp4"
    if inp.get("music"):
        mix.preview_with_music(video, ctx.root / "work" / f"{inp['music']}.mp3", dest)
    else:
        ff.ffmpeg("-i", str(video), "-vf", "scale=720:1280", "-c:v", "libx264", "-crf", "27", "-preset", "fast", str(dest))
    a = ctx.add_asset(dest, "video", "預覽")
    return [_text(f"預覽卡片 {a['id']}")]


def _compose(inp, ctx):
    base = ctx.root / "work" / "base.mp4"
    dur = ff.duration(base) if base.exists() else 37.0
    music = ctx.root / "work" / f"{inp['music']}.mp3" if inp.get("music") else None
    sfx = [{"file": f"sfx_{s['name']}.mp3", "at": s["at"], "gain": s.get("gain", 0.5)} for s in inp.get("sfx") or []]
    r = mix.compose(ctx.root, inp["placements"], music, dur, music_gain=inp.get("music_gain", 0.55),
                    duck_ratio=inp.get("duck_ratio", 6.0), sfx=sfx)
    ctx.record_usage("elevenlabs_stt_sec", round(dur), None)
    words = " ".join(f"{w['text']}{w['start']:.2f}-{w['end']:.2f}" for w in r["words"])
    return [_text(f"混音完成（{dur:.1f}s）。整條旁白辨識：{r['transcript']}\n分句：{_j(r['lines'])}\n逐字：{words}")]


def _captions(inp, ctx):
    base = ctx.root / "work" / "base.mp4"
    ass = subs.build_ass(inp["vo"], inp.get("supers") or [], inp.get("counter"), ctx.root / "work" / "subs.ass")
    dark = None
    if inp.get("counter"):
        dark = (float(inp["counter"]["start"]) - 0.6, float(inp["counter"]["end"]))
    video = subs.burn(base, ass, ctx.root / "work" / "video.mp4", dark)
    times = inp.get("check_times") or [round((c["start"] + c["end"]) / 2, 1) for c in inp["vo"]][:14]
    sb = cut.storyboard(video, times, ctx.root / "sheets" / "captions_check.jpg", height=300)
    return [_text("字幕已燒入 video.mp4。檢查圖（每格標示秒數）："), _image(sb)]


def _export(inp, ctx):
    video = ctx.root / "work" / "video.mp4"
    mixw = ctx.root / "work" / "mix.wav"
    if not video.exists():
        return [_text("還沒有字幕版畫面，先 render_captions")]
    if not mixw.exists():
        return [_text("還沒有混音，先 compose_audio")]
    r = mix.mux_and_export(video, mixw, ctx.root / "out", inp.get("stem", "final"))
    ids = {k: ctx.add_asset(p, "video", {"master": "母帶", "upload": "上傳用 1080p", "preview": "預覽 720p"}[k],
                            {"size_mb": round(p.stat().st_size / 2**20, 1)})["id"] for k, p in r.items()}
    sizes = {k: round(p.stat().st_size / 2**20, 1) for k, p in r.items()}
    return [_text(f"輸出完成：{_j(sizes)} MB，卡片 {_j(ids)}")]


def _cover(inp, ctx):
    name = inp.get("name", "cover")
    r = cover_mod.make_cover(ctx.root, inp["clip"], inp["t"], ctx.root / "cover" / f"{name}.jpg",
                             super_text=inp.get("super_text", ""), title=(inp.get("title") or None) and inp["title"][:2],
                             sub_text=inp.get("sub_text", ""), price_text=inp.get("price_text", ""),
                             crop_x=inp.get("crop_x", 0.5), warm=inp.get("warm", False))
    a = ctx.add_asset(r["cover"], "image", f"封面 {name}")
    return [_text(f"封面卡片 {a['id']}。裁切檢查（9:16 / 4:5 / 3:4）："), _image(r["check"])]


_HANDLERS = {
    "list_drive_folder": _list_drive, "download_footage": _download, "probe_footage": _probe,
    "sample_frames": _sample, "build_cut": _build_cut, "search_voices": _search_voices,
    "generate_voice": _voice, "generate_music": _music, "generate_sfx": _sfx, "preview_video": _preview,
    "compose_audio": _compose, "render_captions": _captions, "export_video": _export, "make_cover": _cover,
}
