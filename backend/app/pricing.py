"""Pricing. 1 點 = NT$3.5; a video with cover and two revision rounds is about 200 點. New accounts get 220 點.

Everything is derived from a measured cost basis (COST_TWD, per tool, in NT$) and two margin targets:
  • pay-as-you-go (儲值點數)   → MARGIN_PAYG = 220 %   (price ≈ cost × 3.2)
  • 專業旅人 (5 支/月)          → MARGIN_SUB  = 180 %   (price ≈ cost × 2.8)
  • 超級玩家 (15 支/月)         → MARGIN_SUB_BIG = 150 % (price ≈ cost × 2.5)
The subscription is the discount path; top-up packs carry no bonus points so pay-as-you-go stays at 220 %.
Override any table with the PRICING_JSON env var.
"""
import json
import math
import os

POINT_TWD = 3.5   # was NT$7 until the 2026-10 rescale; existing balances were doubled (db.POINTS_RESCALE)
SIGNUP_POINTS = 220   # welcome credit: one video with 2 revision rounds, and a little spare
MARGIN_PAYG = 2.20
MARGIN_SUB = 1.80     # 專業旅人: the discount path, cheaper per video than pay-as-you-go (220 %)
MARGIN_SUB_BIG = 1.50 # 超級玩家: volume plan, cheaper again per video
TWD_PER_USD = 32

# Measured cost basis per tool call (NT$): Claude tokens dominate (frames and checks go through the
# model), ElevenLabs for voice/music, a little ffmpeg compute. From production usage records:
# a first version lands around US$4.5 (NT$145), a revision round around NT$40 including the turn's tokens.
COST_TWD: dict[str, float] = {
    "list_drive_folder": 0, "download_footage": 0, "probe_footage": 30, "sample_frames": 0,
    "build_cut": 38, "search_voices": 0, "generate_voice": 20, "generate_music": 8, "generate_sfx": 3,
    "preview_video": 0, "compose_audio": 5, "render_captions": 8, "export_video": 14, "make_cover": 12,
    "voice_sample": 3,      # one delivered sample line
    "revision_turn": 13,    # the conversation tokens of a revision turn (charged once per turn)
}


PRICE_STEP_TWD = 7   # prices move in NT$7 steps (the old point), so the 3.5 rescale left every NT$ price unchanged


def _pts(cost_twd: float, margin: float = MARGIN_PAYG) -> int:
    """Price in whole points at the target margin, rounded half-up to a NT$7 step (so the realised
    margin sits within a few percent of the target instead of always above it)."""
    steps = math.floor(cost_twd * (1 + margin) / PRICE_STEP_TWD + 0.5) if cost_twd else 0
    return int(round(steps * PRICE_STEP_TWD / POINT_TWD))


# Points per tool call at pay-as-you-go margin. 0 = included.
TOOL_POINTS: dict[str, int] = {k: _pts(v) for k, v in COST_TWD.items() if k not in ("voice_sample", "revision_turn")}
VOICE_SAMPLE_POINTS = _pts(COST_TWD["voice_sample"])          # per delivered sample line
REVISION_TURN_POINTS = _pts(COST_TWD["revision_turn"])        # once per revision turn that does tool work

# What a typical job adds up to (used by the UI and the subscription sizing).
FIRST_VIDEO_TOOLS = ["probe_footage", "build_cut", "generate_voice", "generate_music", "compose_audio", "render_captions", "export_video", "make_cover"]
REVISION_TOOLS = ["compose_audio", "render_captions", "export_video"]
FIRST_VIDEO_POINTS = sum(TOOL_POINTS[t] for t in FIRST_VIDEO_TOOLS) + 3 * VOICE_SAMPLE_POINTS   # 3 voice samples
REVISION_POINTS = sum(TOOL_POINTS[t] for t in REVISION_TOOLS) + REVISION_TURN_POINTS
FIRST_VIDEO_COST = sum(COST_TWD[t] for t in FIRST_VIDEO_TOOLS) + 3 * COST_TWD["voice_sample"]
REVISION_COST = sum(COST_TWD[t] for t in REVISION_TOOLS) + COST_TWD["revision_turn"]

# Chinese label and spending category per tool (the credits page groups charges by category).
TOOL_LABELS: dict[str, str] = {
    "list_drive_folder": "讀取 Drive", "download_footage": "下載素材", "probe_footage": "素材分析", "sample_frames": "檢視畫面",
    "build_cut": "剪輯畫面", "search_voices": "搜尋聲音", "generate_voice": "旁白生成", "generate_music": "配樂",
    "generate_sfx": "音效", "preview_video": "預覽", "compose_audio": "混音", "render_captions": "字幕",
    "export_video": "輸出影片", "make_cover": "封面", "revision_turn": "修改回合", "storage": "成品空間月費",
    "subscription": "訂閱方案", "expire": "訂閱點數到期",
}
TOOL_CATEGORY: dict[str, str] = {
    "probe_footage": "cut", "sample_frames": "cut", "build_cut": "cut", "list_drive_folder": "cut", "download_footage": "cut",
    "search_voices": "audio", "generate_voice": "audio", "generate_music": "audio", "generate_sfx": "audio",
    "compose_audio": "subs", "render_captions": "subs", "preview_video": "subs", "revision_turn": "subs",
    "export_video": "export", "make_cover": "cover", "storage": "storage",
}
CATEGORIES = [("cut", "素材與剪輯"), ("audio", "旁白與配樂"), ("subs", "字幕與混音"), ("export", "輸出"), ("cover", "封面"), ("storage", "成品空間")]

# Free start (背包客): every new account gets SIGNUP_POINTS, enough for a first video with two revision
# rounds. Every editing feature is on; the trial may also narrate with a clone of the owner's voice,
# capped at TRIAL_VOICE_SECONDS of generated speech. (FREE_REVISION_TURNS only remains for the legacy
# free-project waiver, which is no longer assigned to new projects.)
FREE_REVISION_TURNS = 3
TRIAL_VOICE_SECONDS = 30

# Top-up packs (儲值): straight NT$3.5 a point for pay-as-you-go, so that tier keeps its margin. Points never
# expire. Subscribers top up at their plan's price per point, so extra videos cost them the same as the
# ones in the plan.


def _pack(points: int, label: str) -> dict:
    """member_twd: the pack at each subscription's own price per point (filled in after SUBSCRIPTIONS)."""
    return {"twd": int(round(points * POINT_TWD)), "points": points, "label": label, "member_twd": {}}


PACKS: dict[str, dict] = {
    # ids kept from the NT$7 era (checkout products are tied to them): same NT$ price, twice the points
    "p50": _pack(100, "100 點"), "p100": _pack(200, "200 點"), "p300": _pack(600, "600 點"), "p1000": _pack(2000, "2,000 點"),
}

# Deliverable storage (成品: exported videos + covers, every version). Raw footage and work files are
# not counted and are cleaned up after RAW_RETENTION_DAYS. Stand-alone plans for pay-as-you-go users,
# renewed every 30 days from points; priced against Railway Bucket cost (NT$0.48 / GB-month).
STORAGE_GB_COST_TWD = 0.48
FREE_STORAGE_GB = 0.5          # 500 MB
FREE_RETENTION_DAYS = 7        # free deliverables are removed after this; any paid storage keeps them
STORAGE_PLANS: dict[str, dict] = {   # gb = total quota
    "free": {"gb": 0.5, "points": 0, "label": "500 MB", "extra": 0},
    "s20": {"gb": 20, "points": 20, "label": "20 GB", "extra": 18},
    "s100": {"gb": 100, "points": 60, "label": "100 GB", "extra": 98},
}
STORAGE_PERIOD_DAYS = 30


def _sub(videos: int, revisions_per_video: int, storage_gb: int, margin: float) -> dict:
    """Size a monthly subscription: included points cover N first versions + revisions at list price,
    storage is bundled, and the price is the bundle's cost at the plan's margin, rounded so the
    per-video number is round. point_twd is what a point effectively costs on the plan; members
    top up at that same rate."""
    revisions = videos * revisions_per_video
    points = videos * FIRST_VIDEO_POINTS + revisions * REVISION_POINTS
    cost = videos * FIRST_VIDEO_COST + revisions * REVISION_COST + storage_gb * STORAGE_GB_COST_TWD
    per_video = int(round(cost * (1 + margin) / videos / 10.0) * 10)   # the headline number: a round per-video price
    twd = per_video * videos
    storage_plan = next((k for k, v in STORAGE_PLANS.items() if v["gb"] >= storage_gb), "s100")
    payg_twd = int(round(points * POINT_TWD + STORAGE_PLANS[storage_plan]["points"] * POINT_TWD))
    return {"videos": videos, "revisions": revisions, "points": points, "storage_gb": STORAGE_PLANS[storage_plan]["gb"],
            "storage_plan": storage_plan, "twd": twd, "payg_twd": payg_twd, "save_twd": payg_twd - twd,
            "save_pct": round((payg_twd - twd) / payg_twd * 100), "per_video_twd": round(twd / videos),
            "point_twd": round(twd / points, 2), "member_discount_pct": round((1 - twd / points / POINT_TWD) * 100),
            "cost_twd": round(cost), "margin_pct": round((twd - cost) / cost * 100)}


SUBSCRIPTION_PERIOD_DAYS = 30
SUBSCRIPTION_GRACE_DAYS = 3   # a renewal payment may land a little late before the plan lapses
OWN_VOICE = "own_voice"       # feature flag: narrate with a clone of the customer's own voice
SUBSCRIPTIONS: dict[str, dict] = {
    "sub5": {"label": "專業旅人", "who": "一間民宿、每週固定發片的你", "desc": "每月 5 支影片，每支含 2 輪修改",
             "features": [OWN_VOICE], **_sub(5, 2, 20, MARGIN_SUB)},
    "sub15": {"label": "超級玩家", "who": "多間店、代操團隊，大量出片", "desc": "每月 15 支影片，每支含 2 輪修改",
              "features": [OWN_VOICE], **_sub(15, 2, 100, MARGIN_SUB_BIG)},
}
for _pk in PACKS.values():   # each pack at each plan's price per point
    _pk["member_twd"] = {k: int(round(_pk["points"] * v["point_twd"] / 10.0) * 10) for k, v in SUBSCRIPTIONS.items()}
MEMBER_POINT_TWD = SUBSCRIPTIONS["sub5"]["point_twd"]
MEMBER_DISCOUNT_PCT = SUBSCRIPTIONS["sub5"]["member_discount_pct"]
# The two non-subscription tiers shown beside them on the plans page. 背包客 is the free first project;
# 旅行者 is anyone who has bought points, and that tier already includes narration in their own voice.
TIERS_FREE = {"id": "free", "label": "背包客", "who": "第一次用，先免費做一支看看", "features": [OWN_VOICE], "voice_seconds": TRIAL_VOICE_SECONDS}
TIERS_PAYG = {"id": "payg", "label": "旅行者", "who": "偶爾剪一支，用多少付多少", "features": [OWN_VOICE]}


def has_feature(subscription: str, feature: str, *, paying: bool = False) -> bool:
    """Every tier has every editing feature; this stays as the single place to gate one if that changes."""
    if feature in SUBSCRIPTIONS.get(subscription or "", {}).get("features", []):
        return True
    return feature in (TIERS_PAYG if paying else TIERS_FREE)["features"]

# What the user sees on the pricing page (bundles of the tool prices above).
MENU = [
    ("素材分析", TOOL_POINTS["probe_footage"]), ("腳本 + 第一版剪輯", TOOL_POINTS["build_cut"]),
    ("旁白整組生成 + 自動核對", TOOL_POINTS["generate_voice"]), ("聲音試聽（每個聲音一句）", VOICE_SAMPLE_POINTS),
    ("配樂一首", TOOL_POINTS["generate_music"]), ("混音 + 字幕 + 輸出", sum(TOOL_POINTS[t] for t in REVISION_TOOLS)),
    ("封面一張", TOOL_POINTS["make_cover"]), ("修改回合（每輪一次）", REVISION_TURN_POINTS),
    ("第一版完整影片（含封面、3 個試聽）", FIRST_VIDEO_POINTS), ("修改一輪（回合 + 重新混音、字幕、輸出）", REVISION_POINTS),
    ("修改時重錄旁白", TOOL_POINTS["generate_voice"]), ("修改時換配樂", TOOL_POINTS["generate_music"]),
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
    STORAGE_PLANS.update(_o.get("storage_plans", {}))
    SUBSCRIPTIONS.update(_o.get("subscriptions", {}))


def tool_cost(name: str, inp: dict) -> int:
    if name == "generate_voice" and inp.get("deliver"):
        return VOICE_SAMPLE_POINTS * max(1, len(inp.get("lines") or []))
    return TOOL_POINTS.get(name, 0)


def public_pricing() -> dict:
    """The numbers the UI shows: list prices plus the subscription savings story."""
    return {
        "point_twd": POINT_TWD, "signup_points": SIGNUP_POINTS, "member_point_twd": MEMBER_POINT_TWD, "member_discount_pct": MEMBER_DISCOUNT_PCT,
        "margin_payg_pct": round(MARGIN_PAYG * 100), "margin_sub_pct": round(MARGIN_SUB * 100),
        "first_video_points": FIRST_VIDEO_POINTS, "revision_points": REVISION_POINTS,
        "first_video_twd": int(round(FIRST_VIDEO_POINTS * POINT_TWD)), "revision_twd": int(round(REVISION_POINTS * POINT_TWD)),
        "subscriptions": [{"id": k, **v} for k, v in SUBSCRIPTIONS.items()],
        "tiers": {"free": TIERS_FREE, "payg": TIERS_PAYG},
        "free_storage_gb": FREE_STORAGE_GB, "free_retention_days": FREE_RETENTION_DAYS, "free_revision_turns": FREE_REVISION_TURNS, "trial_voice_seconds": TRIAL_VOICE_SECONDS,
        "storage_plans": [{"id": k, **v, "twd": int(round(v["points"] * POINT_TWD))} for k, v in STORAGE_PLANS.items()],
    }
