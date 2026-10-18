"""微調 (quick re-render): redo mix → captions → export from the saved recipe (work/plan.json) without an
editor turn. Covers the changes that need no judgement — caption text, 唸法, a dropped line, the owner's
own take, ⭐ highlight, another voice, music level, narration speed, caption size, price colour. Only the
lines whose words changed are re-voiced; everything else is ffmpeg. The cheap path behind the 校對台."""
from __future__ import annotations

import logging
from pathlib import Path

from .agent.tools import plan_load, plan_update
from .pipeline import eleven, ff, mix, subs

log = logging.getLogger("quick")

GAP = 0.15          # seconds kept between consecutive lines when a re-voiced one grew
MIN_TEMPO, MAX_TEMPO = 0.9, 1.35


class QuickError(Exception):
    pass


def line_timing(root: Path, placements: list[dict]) -> dict[str, tuple[float, float]]:
    """{key: (start, end)} from each placement's audio length, tempo and trim."""
    out = {}
    for p in placements:
        f = root / "work" / "vo" / f"{p['key']}.wav"
        dur = ff.duration(f) if f.exists() else 2.0
        if p.get("trim_end"):
            dur = min(dur, float(p["trim_end"]))
        dur /= float(p.get("tempo", 1.0) or 1.0)
        out[p["key"]] = (float(p["at"]), float(p["at"]) + dur)
    return out


def script_lines(root: Path) -> list[dict] | None:
    """The narration as the 校對台 shows it: one entry per placed line, in order, with the caption's
    markup-free text. None when the project has no recipe yet (made before 微調 existed)."""
    plan = plan_load(root)
    comp, voice = plan.get("compose"), plan.get("voice")
    if not comp or not voice:
        return None
    timing = line_timing(root, comp["placements"])
    texts = voice.get("lines") or {}
    out = []
    for i, p in enumerate(sorted(comp["placements"], key=lambda x: float(x["at"])), 1):
        k = p["key"]
        s, e = timing[k]
        out.append({"n": i, "key": k, "start": round(s, 1), "end": round(e, 1), "text": texts.get(k, k)})
    return out


def _caption_for(key: str, start: float, end: float, old_vo: list[dict], text: str, changed: bool, star: bool) -> dict:
    """The VO caption of a line: keep the editor's markup (**重點詞**) when the words didn't change."""
    kept = None
    if not changed:
        hits = [c for c in old_vo if float(c["start"]) < end - 0.05 and float(c["end"]) > start + 0.05]
        if len(hits) == 1 and hits[0]["text"].replace("**", "").strip() == text.strip():
            kept = hits[0]["text"]
    t = kept or text
    if star and "**" not in t:
        t = f"**{t}**"
    y = next((int(c.get("y", 1300)) for c in old_vo if float(c["start"]) < end and float(c["end"]) > start), 1300)
    return {"start": round(start, 2), "end": round(end, 2), "text": t, "y": y}


def plan_changes(root: Path, edits: dict) -> dict:
    """What a 微調 would do, before doing it: which lines get re-voiced (each costs a line), whether the
    whole script is re-voiced (voice change), and the recipe sections it needs."""
    plan = plan_load(root)
    comp, caps, voice = plan.get("compose"), plan.get("captions"), plan.get("voice")
    if not comp or not caps or not voice:
        raise QuickError("這支還沒有可以微調的配方，請先讓剪輯師重新輸出一次")
    texts = voice.get("lines") or {}
    keys = {p["key"] for p in comp["placements"]}
    revoice: list[str] = []
    for e in edits.get("lines") or []:
        k = e.get("key")
        if k not in keys or e.get("drop") or e.get("take"):
            continue
        new = (e.get("say") or e.get("text") or "").strip()
        if new and new != texts.get(k, ""):
            revoice.append(k)
    new_voice = edits.get("voice_id") and edits["voice_id"] != voice.get("voice_id")
    if new_voice:
        revoice = [p["key"] for p in comp["placements"] if not any(e.get("key") == p["key"] and (e.get("drop") or e.get("take")) for e in edits.get("lines") or [])]
    return {"revoice": revoice, "new_voice": bool(new_voice), "plan": plan}


def render(root: Path, edits: dict, *, record_usage=None) -> dict:
    """Apply `edits` to the recipe and produce a new export. Blocking (ffmpeg, ElevenLabs): run in a thread.
    edits: {lines:[{key,text?,say?,drop?,take?,star?}], voice_id?, music_gain?, speed?, caption_scale?, counter_color?}
    Returns {"files": {master, upload, preview}, "revoiced": [keys]}."""
    info = plan_changes(root, edits)
    plan = info["plan"]
    comp, caps, voice = plan["compose"], plan["captions"], plan["voice"]
    texts = dict(voice.get("lines") or {})
    by_key = {e["key"]: e for e in edits.get("lines") or [] if e.get("key")}
    voice_id = edits.get("voice_id") or voice["voice_id"]

    # 1. re-voice the lines whose words (or voice) changed; the owner's take replaces a line's audio
    vo_dir = root / "work" / "vo"
    to_tts = []
    for k in info["revoice"]:
        e = by_key.get(k, {})
        shown = (e.get("text") or texts.get(k, "")).strip()
        spoken = (e.get("say") or shown).strip()
        texts[k] = shown
        to_tts.append({"key": k, "text": spoken})
    if to_tts:
        res = eleven.tts_verified(to_tts, voice_id, vo_dir, model=voice.get("model", "eleven_v3"), tags=voice.get("tags", "[excited]"),
                                  stability=voice.get("stability", 0.5), speed=voice.get("speed", 1.0))
        if record_usage:
            record_usage("elevenlabs_tts_chars", sum(len(l["text"]) * r["takes"] for l, r in zip(to_tts, res)), {"voice_id": voice_id})
    placements = []
    for p in sorted(comp["placements"], key=lambda x: float(x["at"])):
        e = by_key.get(p["key"], {})
        if e.get("drop"):
            continue
        q = dict(p)
        if e.get("take"):
            src = vo_dir / f"{e['take']}.mp3"
            if not src.exists():
                raise QuickError(f"找不到你唸的第 {e['take']} 句錄音")
            ff.ffmpeg("-i", str(src), "-ac", "1", "-ar", "44100", str(vo_dir / f"{p['key']}.wav"))
            q.pop("trim_end", None)
        if e.get("text") and not e.get("drop"):
            texts[p["key"]] = e["text"].strip()
        placements.append(q)
    if edits.get("speed"):
        tp = max(MIN_TEMPO, min(MAX_TEMPO, float(edits["speed"])))
        for q in placements:
            q["tempo"] = tp

    # 2. keep lines from overlapping when one got longer: push the following ones back
    timing = line_timing(root, placements)
    prev_end = 0.0
    for q in placements:
        s, e = timing[q["key"]]
        if s < prev_end + GAP and prev_end > 0:
            shift = prev_end + GAP - s
            q["at"] = round(float(q["at"]) + shift, 2)
            s, e = s + shift, e + shift
            timing[q["key"]] = (s, e)
        prev_end = e

    # 3. mix
    base = root / "work" / "base.mp4"
    dur = float(comp.get("duration") or (ff.duration(base) if base.exists() else 37.0))
    music = root / "work" / f"{comp['music']}.mp3" if comp.get("music") else None
    if music and not music.exists():
        music = None
    gain = float(edits["music_gain"]) if edits.get("music_gain") is not None else float(comp.get("music_gain", 0.55))
    sfx = [{"file": f"sfx_{s['name']}.mp3", "at": s["at"], "gain": s.get("gain", 0.5)} for s in comp.get("sfx") or []
           if (root / "work" / f"sfx_{s['name']}.mp3").exists()]
    mix.compose(root, placements, music, dur, music_gain=gain, duck_ratio=float(comp.get("duck_ratio", 6.0)), sfx=sfx)
    if record_usage:
        record_usage("elevenlabs_stt_sec", round(dur), None)

    # 4. captions: VO rebuilt from the new timing, supers and counter as before
    old_vo = caps.get("vo") or []
    vo = []
    for q in placements:
        s, e = timing[q["key"]]
        ed = by_key.get(q["key"], {})
        changed = q["key"] in info["revoice"] or bool(ed.get("take")) or bool(ed.get("text"))
        vo.append(_caption_for(q["key"], s, min(e, dur), old_vo, texts.get(q["key"], q["key"]), changed, bool(ed.get("star"))))
    counter = dict(caps.get("counter") or {}) or None
    if counter and edits.get("counter_color"):
        counter["color"] = edits["counter_color"]
    scale = float(edits.get("caption_scale") or 1.0)
    ass = subs.build_ass(vo, caps.get("supers") or [], counter, root / "work" / "subs.ass", vo_scale=scale)
    dark = (float(counter["start"]) - 0.6, float(counter["end"])) if counter else None
    video = subs.burn(base, ass, root / "work" / "video.mp4", dark)

    # 5. export
    files = mix.mux_and_export(video, root / "work" / "mix.wav", root / "out", plan.get("export", {}).get("stem", "final"))

    # 6. the recipe now describes this version
    plan_update(root, "voice", {**voice, "voice_id": voice_id, "lines": texts})
    plan_update(root, "compose", {**comp, "placements": placements, "music_gain": gain})
    plan_update(root, "captions", {"vo": vo, "supers": caps.get("supers") or [], "counter": counter})
    return {"files": files, "revoiced": info["revoice"]}
