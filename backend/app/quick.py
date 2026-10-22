"""微調 (quick re-render): redo mix → captions → export from the saved recipe (work/plan.json) without an
editor turn. Covers the changes that need no judgement — caption text, 唸法, a dropped line, the owner's
own take, ⭐ highlight, another voice, music level, narration speed, caption size and style, price colour. Only the
lines whose words changed are re-voiced; everything else is ffmpeg. The cheap path behind the 校對台."""
from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

from .agent.tools import plan_load, plan_update
from .pipeline import cut, eleven, ff, mix, subs
from .pipeline.fonts import DEFAULT_FONT, FONT_PRESETS
from .pipeline.footage import load_index

log = logging.getLogger("quick")

GAP = 0.15          # seconds kept between consecutive lines when a re-voiced one grew
TAIL = 0.4          # seconds of picture kept after the last word
MAX_PAD = 12.0      # the most the picture is stretched to fit narration that outgrew it
MIN_TEMPO, MAX_TEMPO = 0.9, 1.35
MIN_SHOT = 0.6      # shortest segment the 時間軸 allows


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


def shot_sources(root: Path) -> list[dict] | None:
    """The picture cut (work/cut.json) with each source clip's length, for the 時間軸. None when there is no
    cut or the raw footage is gone (originals are kept 7 days), since a re-cut needs the originals."""
    f = root / "work" / "cut.json"
    if not f.exists():
        return None
    try:
        idx = load_index(root)
    except FileNotFoundError:
        return None
    lens: dict[int, float] = {}
    out = []
    for s in json.loads(f.read_text()):
        c = int(s["clip"])
        if c not in lens:
            src = root / "raw" / idx.get(c, "")
            if not idx.get(c) or not src.is_file():
                return None
            lens[c] = round(ff.duration(src), 2)
        out.append({**s, "src_dur": lens[c]})
    return out


def remap(t: float, old: list[tuple[float, float]], new: list[tuple[float, float] | None]) -> float:
    """A moment on the old timeline → the same moment on the re-cut one: same offset into the same segment,
    clamped to that segment's new length. old: [(at, dur)] per original segment; new: that segment's (at, dur)
    after the re-cut, in the same order, or None when it was dropped (the moment lands where the next kept
    segment starts, with no length)."""
    for k, (oa, od) in enumerate(old):
        if t < oa + od - 1e-6:
            nxt = next((x for x in new[k:] if x), None)
            if new[k] is None:
                return round(nxt[0], 2) if nxt else round(max(x[0] + x[1] for x in new if x), 2) if any(new) else 0.0
            na, nd = new[k]
            return round(na + min(max(t - oa, 0.0), nd), 2)
    kept = [x for x in new if x]
    oa, od = old[-1]
    na, nd = kept[-1] if kept else (0.0, 0.0)
    return round(na + nd + max(0.0, t - oa - od), 2)


def recut(root: Path, shot_edits: list[dict], order: list[int] | None = None) -> tuple[float, "callable"]:
    """Re-cut base.mp4 with new segment lengths / source starts, dropped segments and a new order. Returns the
    new duration and a function that maps old timeline seconds to new ones (for narration, supers, the price
    counter and sound effects). shot_edits: [{i, dur?, start?, drop?}]; order: original indices in their new
    order (missing ones keep their relative place at the end)."""
    src = shot_sources(root)
    if not src:
        raise QuickError("原始素材已超過保存期限，沒辦法再調段落長度；可以直接跟剪輯師說要怎麼改")
    by_i = {int(e["i"]): e for e in shot_edits if "i" in e}
    idx = [int(s["i"]) for s in src]
    seq = [i for i in (order or []) if i in idx] + [i for i in idx if i not in (order or [])]
    segs, kept = [], []
    for i in seq:
        s = next(x for x in src if int(x["i"]) == i)
        e = by_i.get(i, {})
        if e.get("drop"):
            continue
        start = max(0.0, min(float(e.get("start", s["start"])), s["src_dur"] - MIN_SHOT))
        dur = max(MIN_SHOT, min(float(e.get("dur", s["dur"])), s["src_dur"] - start))
        seg = {"clip": s["clip"], "start": round(start, 2), "dur": round(dur, 2)}
        if "crop_x" in s:
            seg["crop_x"] = s["crop_x"]
        segs.append(seg)
        kept.append(i)
    if not segs:
        raise QuickError("至少要留一段畫面")
    old_t = [(float(s["at"]), float(s["dur"])) for s in src]
    r = cut.build_cut(root, segs)
    built = json.loads((root / "work" / "cut.json").read_text())
    pos = {i: k for k, i in enumerate(kept)}
    new_t = [(float(built[pos[i]]["at"]), float(built[pos[i]]["dur"])) if i in pos else None for i in idx]
    return float(r["duration"]), (lambda t: remap(float(t), old_t, new_t))


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
    if (edits.get("shots") or edits.get("order")) and not shot_sources(root):
        raise QuickError("原始素材已超過保存期限，沒辦法再調段落長度；可以直接跟剪輯師說要怎麼改")
    return {"revoice": revoice, "new_voice": bool(new_voice), "plan": plan}


def render(root: Path, edits: dict, *, record_usage=None) -> dict:
    """See _render. A 時間軸 change rewrites base.mp4 and cut.json before anything else, so they are backed up
    and put back if the render fails — the picture and the recipe never disagree."""
    if not edits.get("shots") and not edits.get("order"):
        return _render(root, edits, record_usage=record_usage)
    work = root / "work"
    keep = [work / "base.mp4", work / "cut.json"]
    for f in keep:
        if f.exists():
            shutil.copyfile(f, f.with_name(f.name + ".bak"))
    try:
        out = _render(root, edits, record_usage=record_usage)
    except Exception:
        for f in keep:
            b = f.with_name(f.name + ".bak")
            if b.exists():
                b.replace(f)
        raise
    for f in keep:
        f.with_name(f.name + ".bak").unlink(missing_ok=True)
    return out


def _render(root: Path, edits: dict, *, record_usage=None) -> dict:
    """Apply `edits` to the recipe and produce a new export. Blocking (ffmpeg, ElevenLabs): run in a thread.
    edits: {lines:[{key,text?,say?,drop?,take?,star?}], shots:[{i,dur?,start?,drop?}], order:[i…], supers:[{i,text?,drop?}],
            voice_id?, music_gain?, speed?, caption_scale?, caption_style?, font?, super_style?, counter_color?}
    Returns {"files": {master, upload, preview}, "revoiced": [keys]}."""
    info = plan_changes(root, edits)
    plan = info["plan"]
    comp, caps, voice = plan["compose"], plan["captions"], plan["voice"]
    texts = dict(voice.get("lines") or {})
    by_key = {e["key"]: e for e in edits.get("lines") or [] if e.get("key")}
    voice_id = edits.get("voice_id") or voice["voice_id"]

    # 0. 時間軸: re-cut the picture first; everything placed in time moves with its segment
    tmap = None
    if edits.get("shots") or edits.get("order"):
        new_dur, tmap = recut(root, edits.get("shots") or [], edits.get("order"))

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
    ordered = sorted(comp["placements"], key=lambda x: float(x["at"]))
    old_slot = {p["key"]: (float(ordered[i + 1]["at"]) if i + 1 < len(ordered) else float(comp.get("duration") or 0)) - float(p["at"])
                for i, p in enumerate(ordered)}   # how long each line had on the old timeline
    for p in ordered:
        e = by_key.get(p["key"], {})
        if e.get("drop"):
            continue
        q = dict(p)
        if tmap:
            q["at"] = tmap(p["at"])
        if e.get("take"):
            src = vo_dir / f"{e['take']}.mp3"
            if not src.exists():
                raise QuickError(f"找不到你唸的第 {e['take']} 句錄音")
            wav = vo_dir / f"{p['key']}.wav"
            ff.ffmpeg("-i", str(src), "-ac", "1", "-ar", "44100", str(wav))
            q.pop("trim_end", None)
            q.pop("tempo", None)
            # a take that runs past the line's slot is sped up a little so the picture stays in sync; beyond
            # MAX_TEMPO the following lines are pushed back instead (step 2)
            slot = old_slot.get(p["key"], 0.0) - GAP
            dur = ff.duration(wav)
            if slot > 0.5 and dur > slot:
                q["tempo"] = round(min(MAX_TEMPO, dur / slot), 3)
        if e.get("text") and not e.get("drop"):
            texts[p["key"]] = e["text"].strip()
        placements.append(q)
    if edits.get("speed"):
        tp = max(MIN_TEMPO, min(MAX_TEMPO, float(edits["speed"])))
        for q in placements:
            q["tempo"] = tp

    # 2. keep lines from overlapping when one got longer: push the following ones back (after a reorder the
    #    lines are in their new timeline order)
    placements.sort(key=lambda q: float(q["at"]))
    timing = line_timing(root, placements)
    prev_end = 0.0
    for q in placements:
        s, e = timing[q["key"]]
        if s < prev_end and prev_end > 0:    # only a real overlap pushes a line back
            shift = prev_end + GAP - s
            q["at"] = round(float(q["at"]) + shift, 2)
            s, e = s + shift, e + shift
            timing[q["key"]] = (s, e)
        prev_end = e

    # 3. mix. Narration that now ends after the picture (slower own takes, pushed-back lines) gets the
    #    last frame held under it instead of being cut off.
    base = root / "work" / "base.mp4"
    dur = new_dur if tmap else float(comp.get("duration") or (ff.duration(base) if base.exists() else 37.0))
    last_end = max((e for _, e in timing.values()), default=0.0)
    pad = 0.0
    if last_end + TAIL > dur:
        pad = round(min(MAX_PAD, last_end + TAIL - dur), 2)
        dur = round(dur + pad, 2)
    music = root / "work" / f"{comp['music']}.mp3" if comp.get("music") else None
    if music and not music.exists():
        music = None
    gain = float(edits["music_gain"]) if edits.get("music_gain") is not None else float(comp.get("music_gain", 0.55))
    sfx_plan = [{**s, "at": tmap(s["at"])} if tmap else s for s in comp.get("sfx") or []]
    sfx = [{"file": f"sfx_{s['name']}.mp3", "at": s["at"], "gain": s.get("gain", 0.5)} for s in sfx_plan
           if (root / "work" / f"sfx_{s['name']}.mp3").exists()]
    mix.compose(root, placements, music, dur, music_gain=gain, duck_ratio=float(comp.get("duck_ratio", 6.0)), sfx=sfx)
    if record_usage:
        record_usage("elevenlabs_stt_sec", round(dur), None)

    # 4. captions: VO rebuilt from the new timing, supers and counter as before
    old_vo = caps.get("vo") or []
    supers = caps.get("supers") or []
    counter = dict(caps.get("counter") or {}) or None
    sup_ed = {int(e["i"]): e for e in edits.get("supers") or [] if "i" in e}
    supers = [{**c, **({"text": sup_ed[k]["text"].strip()} if sup_ed.get(k, {}).get("text") else {})}
              for k, c in enumerate(supers) if not sup_ed.get(k, {}).get("drop")]
    if tmap:
        old_vo = [{**c, "start": tmap(c["start"]), "end": tmap(c["end"])} for c in old_vo]
        supers = [{**c, "start": tmap(c["start"]), "end": min(tmap(c["end"]), dur)} for c in supers]
        if counter:
            counter.update(start=tmap(counter["start"]), end=min(tmap(counter["end"]), dur))
    vo = []
    for q in placements:
        s, e = timing[q["key"]]
        ed = by_key.get(q["key"], {})
        changed = q["key"] in info["revoice"] or bool(ed.get("take")) or bool(ed.get("text"))
        vo.append(_caption_for(q["key"], s, min(e, dur), old_vo, texts.get(q["key"], q["key"]), changed, bool(ed.get("star"))))
    if counter and edits.get("counter_color"):
        counter["color"] = edits["counter_color"]
    scale = float(edits.get("caption_scale") or caps.get("scale") or 1.0)
    style = edits.get("caption_style") if edits.get("caption_style") in subs.CAPTION_STYLES else caps.get("style", subs.DEFAULT_STYLE)
    font = edits.get("font") if edits.get("font") in FONT_PRESETS else caps.get("font", DEFAULT_FONT)
    super_style = edits.get("super_style") if edits.get("super_style") in subs.SUPER_STYLES else caps.get("super_style", subs.DEFAULT_SUPER)
    ass = subs.build_ass(vo, supers, counter, root / "work" / "subs.ass", vo_scale=scale, style=style, font=font, super_style=super_style)
    dark = (float(counter["start"]) - 0.6, float(counter["end"])) if counter else None
    video = subs.burn(base, ass, root / "work" / "video.mp4", dark, pad=pad)

    # 5. export
    files = mix.mux_and_export(video, root / "work" / "mix.wav", root / "out", plan.get("export", {}).get("stem", "final"))

    # 6. the recipe now describes this version
    plan_update(root, "voice", {**voice, "voice_id": voice_id, "lines": texts})
    plan_update(root, "compose", {**comp, "placements": placements, "music_gain": gain, "duration": dur, "sfx": sfx_plan})
    plan_update(root, "captions", {"vo": vo, "supers": supers, "counter": counter, "style": style, "font": font, "super_style": super_style,
                                   "scale": scale if edits.get("caption_scale") else caps.get("scale", 1.0)})
    return {"files": files, "revoiced": info["revoice"]}
