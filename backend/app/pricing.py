"""Pricing. A video with cover and two revision rounds is 100 點; new accounts get 110 點.

Two separate things:
  • the point schedule (how many points each tool costs) is fixed. It was sized from a measured cost
    basis (COST_TWD, NT$ per tool) at NT$7 a point, which is why _pts divides by PRICE_STEP_TWD.
  • the price of a point (POINT_TWD) is set by an admin on the dashboard (default NT$3.5). Every NT$
    price follows from it: packs = points × price, subscriptions = their points (+ bundled storage) at
    that price minus the plan's discount. Lowering the price lowers the margin; the dashboard previews
    the margin of each plan before it is applied (see margins()).
Override any table with the PRICING_JSON env var.
"""
import json
import math
import os

DEFAULT_POINT_TWD = 3.9
POINT_TWD: float = DEFAULT_POINT_TWD   # current price of a point; changed at runtime by apply_point_price()
SIGNUP_POINTS = 110   # welcome credit: one video with 2 revision rounds, and a little spare
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


PRICE_STEP_TWD = 7   # the point value the schedule was sized at; the schedule doesn't move with the point price


def _pts(cost_twd: float, margin: float = MARGIN_PAYG) -> int:
    """Points for a tool: its cost at the design margin in NT$7 units, rounded half-up."""
    return int(math.floor(cost_twd * (1 + margin) / PRICE_STEP_TWD + 0.5)) if cost_twd else 0


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

# Top-up packs (儲值): straight POINT_TWD a point for pay-as-you-go, so that tier keeps its margin. Points never
# expire. Subscribers top up at their plan's price per point, so extra videos cost them the same as the
# ones in the plan.


def _pack(points: int, bonus: int = 0) -> dict:
    """A top-up pack: pay for `points`, receive points + bonus. Bonuses start at 300 and grow with the
    pack, but stay below the subscription discount (專業旅人 −12 %) so subscribing remains the better
    deal for regular use. member_twd: the paid points at each plan's own price per point."""
    return {"twd": int(round(points * POINT_TWD)), "points": points, "bonus": bonus, "total": points + bonus,
            "label": f"{points:,} 點" + (f" + 送 {bonus}" if bonus else ""), "member_twd": {}}


PACKS: dict[str, dict] = {
    "p50": _pack(50), "p100": _pack(100), "p300": _pack(300, 15), "p500": _pack(500, 35),
    "p700": _pack(700, 60), "p1000": _pack(1000, 100), "p2000": _pack(2000, 240),
}

# Deliverable storage (成品: exported videos + covers, every version). Raw footage and work files are
# not counted and are cleaned up after RAW_RETENTION_DAYS. Stand-alone plans for pay-as-you-go users,
# renewed every 30 days from points; priced against Railway Bucket cost (NT$0.48 / GB-month).
STORAGE_GB_COST_TWD = 0.48
FREE_STORAGE_GB = 0.5          # 500 MB
FREE_RETENTION_DAYS = 7        # free deliverables are removed after this; any paid storage keeps them
STORAGE_PLANS: dict[str, dict] = {   # gb = total quota
    "free": {"gb": 0.5, "points": 0, "label": "500 MB", "extra": 0},
    "s20": {"gb": 20, "points": 10, "label": "20 GB", "extra": 18},
    "s100": {"gb": 100, "points": 30, "label": "100 GB", "extra": 98},
}
STORAGE_PERIOD_DAYS = 30


def _round90(x: float) -> int:
    """A shelf price: nearest hundred minus 10 (994 → 990, 1,778 → 1,790)."""
    return max(90, int(round(x / 100.0)) * 100 - 10)


def _sub(videos: int, revisions_per_video: int, storage_gb: int, discount: float, months: int = 1) -> dict:
    """Size a subscription: each month's points cover N first versions + revisions; the monthly price is
    those points at the list price minus the plan's discount (a shelf price ending in 90); quarterly
    billing pays 3 months at once with QUARTER_OFF more off and receives the 3 months' points up front.
    point_twd is what a point effectively costs on the plan; members top up at that rate."""
    revisions = videos * revisions_per_video
    month_points = videos * FIRST_VIDEO_POINTS + revisions * REVISION_POINTS
    month_twd = _round90(month_points * POINT_TWD * (1 - discount))
    twd = month_twd if months == 1 else int(round(month_twd * months * (1 - QUARTER_OFF) / 10.0)) * 10
    points = month_points * months
    storage_plan = next((k for k, v in STORAGE_PLANS.items() if v["gb"] >= storage_gb), "s100")
    cost = (videos * FIRST_VIDEO_COST + revisions * REVISION_COST + storage_gb * STORAGE_GB_COST_TWD) * months
    payg_twd = int(round(points * POINT_TWD))
    return {"videos": videos, "revisions": revisions, "points": points, "month_points": month_points, "months": months,
            "period_days": SUBSCRIPTION_PERIOD_DAYS * months, "storage_gb": STORAGE_PLANS[storage_plan]["gb"],
            "storage_plan": storage_plan, "twd": twd, "monthly_twd": round(twd / months), "payg_twd": payg_twd,
            "save_twd": payg_twd - twd, "save_pct": round((payg_twd - twd) / payg_twd * 100),
            "per_video_twd": round(twd / (videos * months)), "point_twd": round(twd / points, 2),
            "member_discount_pct": round((1 - twd / points / POINT_TWD) * 100),
            "cost_twd": round(cost), "margin_pct": round((twd - cost) / cost * 100)}


SUBSCRIPTION_PERIOD_DAYS = 30
SUBSCRIPTION_GRACE_DAYS = 3   # a renewal payment may land a little late before the plan lapses
OWN_VOICE = "own_voice"       # feature flag: narrate with a clone of the customer's own voice
# Subscriptions are the discount path: the same points bought pay-as-you-go, minus this much.
# Three plans, each billed monthly ("sub5") or quarterly ("sub5q", 3 months at once, QUARTER_OFF more off).
SUB_DISCOUNT = {"sub3": 0.15, "sub5": 0.24, "sub15": 0.36}       # off the same points bought one by one
SUB_SHAPE = {"sub3": (3, 2, 10), "sub5": (6, 2, 20), "sub15": (18, 2, 100)}   # videos/month, revisions each, storage GB
QUARTER_OFF = 0.15
SUB_INFO = {
    "sub3": {"label": "輕旅行", "who": "想固定經營，一個月幾支就夠"},
    "sub5": {"label": "專業旅人", "who": "一間民宿、每週固定發片"},
    "sub15": {"label": "超級玩家", "who": "多間店、代操團隊，大量出片"},
}
# Member perk on top-ups: while subscribed, every point bought costs the plan's own price per point
# (專業旅人 ≈ NT$3.1, 超級玩家 ≈ NT$2.9), whatever the pack. It's paid as extra points, not a lower price:
# the same NT$ for everyone, points = price ÷ the plan's rate (never fewer than a non-member gets). That
# keeps revenue per purchase whole and one price list for every buyer.
SUBSCRIPTIONS: dict[str, dict] = {}
for _k, (_v, _r, _gb) in SUB_SHAPE.items():
    for _q in ("", "q"):
        SUBSCRIPTIONS[_k + _q] = {**SUB_INFO[_k], "base": _k, "billing": "quarter" if _q else "month",
                                  "desc": f"每月 {_v} 支影片，每支含 2 輪修改", "features": [OWN_VOICE]}
MEMBER_POINT_TWD = 0.0
MEMBER_DISCOUNT_PCT = 0
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

_OVERRIDE = json.loads(os.environ.get("PRICING_JSON") or "{}")
TOOL_POINTS.update(_OVERRIDE.get("tool_points", {}))
FREE_REVISION_TURNS = int(_OVERRIDE.get("free_revision_turns", FREE_REVISION_TURNS))
STORAGE_PLANS.update(_OVERRIDE.get("storage_plans", {}))


def apply_point_price(point_twd: float) -> None:
    """Set the price of a point and re-derive every NT$ price in place (other modules hold references
    to these dicts). Called at start-up with the saved setting and when an admin changes it."""
    global POINT_TWD, MEMBER_POINT_TWD, MEMBER_DISCOUNT_PCT
    POINT_TWD = float(point_twd)
    for pk in PACKS.values():
        pk["twd"] = int(round(pk["points"] * POINT_TWD))
    for k, (v, r, gb) in SUB_SHAPE.items():
        SUBSCRIPTIONS[k].update(_sub(v, r, gb, SUB_DISCOUNT[k]))
        SUBSCRIPTIONS[k + "q"].update(_sub(v, r, gb, SUB_DISCOUNT[k], months=3))
    for k, o in _OVERRIDE.get("subscriptions", {}).items():
        SUBSCRIPTIONS.setdefault(k, {}).update(o)
    for k, v in SUBSCRIPTIONS.items():
        v["member_bonus_pct"] = round((POINT_TWD / v["point_twd"] - 1) * 100)
    for pk in PACKS.values():   # members pay the same price and receive points at their plan's rate
        pk["member_bonus"] = {k: max(0, int(round(pk["twd"] / v["point_twd"])) - pk["total"]) for k, v in SUBSCRIPTIONS.items()}
        pk["member_twd"] = {k: pk["twd"] for k in SUBSCRIPTIONS}   # kept for older clients: no member price any more
    for k, o in _OVERRIDE.get("packs", {}).items():
        PACKS.setdefault(k, {}).update(o)
        PACKS[k]["total"] = PACKS[k].get("points", 0) + PACKS[k].get("bonus", 0)
    MEMBER_POINT_TWD = SUBSCRIPTIONS["sub5"]["point_twd"]
    MEMBER_DISCOUNT_PCT = SUBSCRIPTIONS["sub5"]["member_discount_pct"]


apply_point_price(DEFAULT_POINT_TWD)


def margins(point_twd: float | None = None, video_cost_twd: float | None = None) -> dict:
    """What each way of buying earns at a given point price (default: the current one), for the
    dashboard's pricing page. margin_pct = (price − cost) / cost. video_cost_twd: the measured
    variable cost of one finished video (from usage records); without it the COST_TWD estimate."""
    p = POINT_TWD if point_twd is None else float(point_twd)
    pts = FIRST_VIDEO_POINTS + 2 * REVISION_POINTS
    cost = video_cost_twd if video_cost_twd else FIRST_VIDEO_COST + 2 * REVISION_COST
    rows = [{"id": "payg", "label": "單次購買 · 一支含 2 輪修改", "points": pts, "twd": round(pts * p), "cost_twd": round(cost),
             "per_video_twd": round(pts * p)}]
    for k, (v, r, gb) in SUB_SHAPE.items():
        for months in (1, 3):
            saved = POINT_TWD
            try:
                globals()["POINT_TWD"] = p
                sb = _sub(v, r, gb, SUB_DISCOUNT[k], months)
            finally:
                globals()["POINT_TWD"] = saved
            sub_cost = round((v * cost + gb * STORAGE_GB_COST_TWD) * months) if video_cost_twd else sb["cost_twd"]
            rows.append({"id": k + ("q" if months == 3 else ""), "label": f"{SUB_INFO[k]['label']} · {'季繳' if months == 3 else '月繳'}（每月 {v} 支）",
                         "points": sb["points"], "twd": sb["twd"], "cost_twd": sub_cost, "per_video_twd": sb["per_video_twd"]})
    for x in rows:
        x["margin_pct"] = round((x["twd"] - x["cost_twd"]) / x["cost_twd"] * 100) if x["cost_twd"] else None
    return {"point_twd": p, "signup_points": SIGNUP_POINTS, "signup_cost_twd": round(SIGNUP_POINTS * cost / pts), "video_cost_twd": round(cost),
            "estimated_video_cost_twd": round(FIRST_VIDEO_COST + 2 * REVISION_COST),
            "rows": rows, "packs": [{"id": k, "points": v["points"], "bonus": v.get("bonus", 0), "twd": int(round(v["points"] * p))} for k, v in PACKS.items()]}


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


def pack_points(pack: dict, subscription: str = "") -> int:
    """Points a buyer receives for a pack: paid + the pack's bonus + the member bonus of their plan."""
    return pack["points"] + pack.get("bonus", 0) + pack.get("member_bonus", {}).get(subscription or "", 0)
