"""「先解析素材」: one Claude call over the contact sheets that returns selling points, a storyboard,
a narration script (逐字稿) and the point estimate, before the user has written a brief.

The result is saved to sheets/analysis.json. The agent's later probe_footage call is free when an
analysis exists (the user already paid the probe once), and the compact analysis is handed to the
agent in the first message so it starts from the same plan the user saw.
"""
import json
import logging
import re
import time
from pathlib import Path

import anthropic

from .. import config
from ..pipeline import footage
from ..pricing import FIRST_VIDEO_POINTS, REVISION_POINTS, TOOL_POINTS
from .tools import _image

log = logging.getLogger("analyze")

ANALYZE_POINTS = TOOL_POINTS["probe_footage"]

PROMPT = """你是台灣旅遊／民宿短影音剪輯師。下面是用戶上傳的素材縮圖總表（每個素材 4 格，時間由左到右，左上角黃字是素材編號 #）。
請只根據你看到的畫面，幫用戶規劃一支 35–40 秒的直式短影音（Reels／抖音），用繁體中文、台灣口語。

{brief}

回傳**一個 JSON 物件**，不要有其他文字，欄位：
- "summary": 一句話描述這批素材是什麼地方、什麼氛圍（≤40 字）。
- "selling_points": 5–8 個賣點，每個 ≤12 字，從畫面看得到的具體東西（例如「無邊際泳池看海」），最強的放前面。
- "storyboard": 7–10 個鏡頭，依播放順序，每個 {{"n": 序號, "clip": 素材編號(整數), "t": 建議起點秒(數字), "dur": 長度秒(數字, 2–6), "shot": 畫面描述 ≤18 字, "role": "hook"|"feature"|"price"|"cta"}}。第一個鏡頭必須是 hook（最強賣點），總長 35–40 秒。
- "script": 旁白逐字稿，每個鏡頭一句，{{"n": 對應鏡頭序號, "text": 旁白 ≤18 字}}。口語、有畫面感，第一句 3 秒內講出地點＋最強賣點，最後一句是行動呼籲。價格、店名你不知道就寫成「（價格）」「（店名）」讓用戶填。
- "transcript_notes": 素材裡如果有明顯人聲、對話或現場音（從畫面判斷，例如有人對鏡頭講話）寫在這裡，否則空字串。
- "missing": 1–3 個建議補拍或補充的素材／資訊（≤16 字），例如「價格」「店名」「房間內部」。"""


def _client() -> anthropic.AsyncAnthropic:
    return anthropic.AsyncAnthropic(
        default_headers={"anthropic-workspace-id": config.ANTHROPIC_WORKSPACE_ID} if config.ANTHROPIC_WORKSPACE_ID else None)


def _parse(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("模型沒有回傳 JSON")
    return json.loads(m.group(0))


def _clean(raw: dict, rows: list[dict]) -> dict:
    valid = {r["n"] for r in rows if "error" not in r}
    dur = {r["n"]: float(r.get("dur") or 0) for r in rows if "error" not in r}
    sb = []
    for i, s in enumerate(raw.get("storyboard") or [], 1):
        try:
            clip = int(s.get("clip", 0))
        except (TypeError, ValueError):
            continue
        if clip not in valid:
            continue
        t = max(0.0, float(s.get("t") or 0))
        d = min(6.0, max(2.0, float(s.get("dur") or 3)))
        if dur.get(clip):
            t = min(t, max(0.0, dur[clip] - d))
        sb.append({"n": i, "clip": clip, "t": round(t, 1), "dur": round(d, 1),
                   "shot": str(s.get("shot") or "")[:40], "role": s.get("role") if s.get("role") in ("hook", "feature", "price", "cta") else "feature"})
    script = [{"n": int(l.get("n") or i + 1), "text": str(l.get("text") or "")[:40]}
              for i, l in enumerate(raw.get("script") or []) if str(l.get("text") or "").strip()]
    return {"summary": str(raw.get("summary") or "")[:80],
            "selling_points": [str(x)[:24] for x in (raw.get("selling_points") or []) if str(x).strip()][:8],
            "storyboard": sb[:10], "script": script[:12],
            "transcript_notes": str(raw.get("transcript_notes") or "")[:300],
            "missing": [str(x)[:30] for x in (raw.get("missing") or [])][:3],
            "total_seconds": round(sum(s["dur"] for s in sb), 1)}


def estimate(balance: int) -> dict:
    """What the first version and the usual two revisions will cost, against the current balance."""
    two = FIRST_VIDEO_POINTS + 2 * REVISION_POINTS
    return {"first_video_points": FIRST_VIDEO_POINTS, "revision_points": REVISION_POINTS, "two_revisions_points": two,
            "balance": balance, "enough_first": balance >= FIRST_VIDEO_POINTS, "enough_two": balance >= two,
            "short_first": max(0, FIRST_VIDEO_POINTS - balance), "short_two": max(0, two - balance)}


def load(root: Path) -> dict | None:
    f = root / "sheets" / "analysis.json"
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text())
    except Exception:
        return None


async def run(root: Path, brief: str = "", record_usage=None) -> dict:
    """Probe the footage, send the contact sheets to Claude, save and return the analysis.
    Raises ValueError when there is no footage. Charging is the caller's job."""
    rows = await _to_thread(footage.probe_footage, root)
    good = [r for r in rows if "error" not in r]
    if not good:
        raise ValueError("專案裡還沒有可以用的影片或照片")
    sheets = await _to_thread(footage.contact_sheets, root)
    table = "\n".join(f"#{r['n']:02d}\t{r['dur']}s\t{r['w']}x{r['h']}" + ("\t照片" if r.get("photo") else "") for r in good)
    content = [{"type": "text", "text": PROMPT.format(brief=f"用戶補充：{brief.strip()[:600]}" if brief.strip() else "用戶還沒寫任何說明，完全從畫面判斷。")
                + f"\n\n素材清單（編號、長度、解析度）：\n{table}"}]
    for s in sheets:
        content.append(_image(s))
    content.append({"type": "text", "text": "請回傳 JSON。"})
    t0 = time.time()
    msg = await _client().messages.create(model=config.ANTHROPIC_MODEL, max_tokens=4000,
                                          system="你只回傳合法 JSON，不加說明、不加 markdown 圍欄。",
                                          messages=[{"role": "user", "content": content}])
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    if record_usage:
        from .runner import _cost
        await record_usage("claude_tokens", (msg.usage.input_tokens or 0) + (msg.usage.output_tokens or 0), _cost(msg.usage),
                           {"in": msg.usage.input_tokens, "out": msg.usage.output_tokens, "analyze": True})
    data = _clean(_parse(text), rows)
    data.update(clips=[{"n": r["n"], "dur": r["dur"], "photo": bool(r.get("photo")), "name": Path(r["path"]).name} for r in good],
                n_clips=len(good), seconds=round(time.time() - t0, 1), created_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    (root / "sheets").mkdir(parents=True, exist_ok=True)
    (root / "sheets" / "analysis.json").write_text(json.dumps(data, ensure_ascii=False))
    return data


def as_brief(a: dict) -> str:
    """Compact text handed to the agent so it starts from the plan the user approved."""
    pts = "、".join(a.get("selling_points") or [])
    sb = "；".join(f"{s['n']}.#{s['clip']:02d}@{s['t']}s {s['dur']}s {s['shot']}" for s in a.get("storyboard") or [])
    sc = " / ".join(f"{l['n']}.{l['text']}" for l in a.get("script") or [])
    return (f"[先前解析結果] {a.get('summary', '')}\n賣點：{pts}\n建議分鏡：{sb}\n旁白草稿：{sc}\n"
            "素材已分析過（probe_footage 不再扣點），請以此為起點，仍要自己看縮圖確認，用戶有改賣點就照用戶的。")


async def _to_thread(fn, *a):
    import asyncio
    return await asyncio.to_thread(fn, *a)
