"""Credit pricing. 1 點 = NT$10 list price; each action is priced at ~3x its cost.

Points are charged per tool call so a round of revisions costs what it actually uses.
Edit this table (or override with the PRICING_JSON env var) to retune.
"""
import json
import os

POINT_TWD = 10

# Points per tool call. 0 = included.
TOOL_POINTS: dict[str, int] = {
    "list_drive_folder": 0, "download_footage": 0, "probe_footage": 6, "sample_frames": 0,
    "build_cut": 9, "search_voices": 0,
    "generate_voice": 6,            # full script; a delivered sample costs VOICE_SAMPLE_POINTS per line instead
    "generate_music": 3, "generate_sfx": 1, "preview_video": 0,
    "compose_audio": 3, "render_captions": 2, "export_video": 3, "make_cover": 4,
}
VOICE_SAMPLE_POINTS = 1

# Free trial: the user's first project is free through the first export plus this many revision turns.
FREE_REVISION_TURNS = 4

# Top-up packs: id -> (price TWD, points). Bonus keeps the largest pack ≥ ~175% margin.
PACKS: dict[str, dict] = {
    "p500": {"twd": 500, "points": 50, "label": "NT$500 → 50 點"},
    "p1000": {"twd": 1000, "points": 110, "label": "NT$1,000 → 110 點（+10%）"},
    "p3000": {"twd": 3000, "points": 360, "label": "NT$3,000 → 360 點（+20%）"},
    "p10000": {"twd": 10000, "points": 1300, "label": "NT$10,000 → 1,300 點（+30%）"},
}

# What the user sees on the pricing page (bundles of the tool prices above).
MENU = [
    ("素材分析", 6), ("腳本 + 第一版剪輯", 9), ("旁白整組生成 + 自動核對", 6), ("聲音試聽（每個聲音一句）", 1),
    ("配樂一首", 3), ("混音 + 字幕 + 輸出", 8), ("封面一張", 4),
    ("第一版完整影片（含封面、3 個試聽）", 39), ("修改一輪（重新混音、字幕、輸出）", 8),
    ("修改時重錄旁白", 6), ("修改時換配樂", 3),
]

# Rough USD cost per unit for ElevenLabs usage kinds (Creator plan ≈ $22 / 100k chars); used for
# the admin margin view only. Tune from real invoices.
ELEVEN_COST_USD = {"elevenlabs_tts_chars": 0.00022, "elevenlabs_music_sec": 0.01,
                   "elevenlabs_sfx_sec": 0.01, "elevenlabs_stt_sec": 0.0001}

if os.environ.get("PRICING_JSON"):
    _o = json.loads(os.environ["PRICING_JSON"])
    TOOL_POINTS.update(_o.get("tool_points", {}))
    PACKS.update(_o.get("packs", {}))
    FREE_REVISION_TURNS = int(_o.get("free_revision_turns", FREE_REVISION_TURNS))


def tool_cost(name: str, inp: dict) -> int:
    if name == "generate_voice" and inp.get("deliver"):
        return VOICE_SAMPLE_POINTS * max(1, len(inp.get("lines") or []))
    return TOOL_POINTS.get(name, 0)
