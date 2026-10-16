"""ElevenLabs: voice search, TTS with automatic STT verification, music, sound effects.

Every generated line is transcribed back and compared to the script so mispronounced
takes are caught before they reach the edit.
"""
import json
import re
import threading
from pathlib import Path

import requests

from .. import config
from . import ff

BASE = "https://api.elevenlabs.io/v1"
_sem = threading.Semaphore(config.ELEVENLABS_CONCURRENCY)


def _headers() -> dict:
    if not config.ELEVENLABS_API_KEY:
        raise RuntimeError("ELEVENLABS_API_KEY 未設定")
    return {"xi-api-key": config.ELEVENLABS_API_KEY}


def _post(path: str, timeout: int = 300, **kw) -> requests.Response:
    with _sem:
        r = requests.post(f"{BASE}{path}", headers=_headers(), timeout=timeout, **kw)
    if r.status_code != 200:
        try:
            detail = r.json().get("detail", r.text)
        except Exception:
            detail = r.text[:300]
        raise RuntimeError(f"ElevenLabs {path} {r.status_code}: {detail}")
    return r


def subscription() -> dict:
    r = requests.get(f"{BASE}/user/subscription", headers=_headers(), timeout=30)
    r.raise_for_status()
    d = r.json()
    return {"tier": d.get("tier"), "used": d.get("character_count"), "limit": d.get("character_limit")}


def search_voices(query: str = "", language: str = "zh", accent: str = "", page_size: int = 20) -> list[dict]:
    """Voice Library search. The library labels Taiwanese voices with accent "taiwan mandarin" and the
    accent filter is exact, so "taiwanese"/"taiwan" are turned into a text search + accent substring filter."""
    params = {"page_size": page_size, "language": language}
    want = ""
    if accent and "taiwan" in accent.lower():
        want, accent = "taiwan", ""
        query = query or "taiwan"
    if query:
        params["search"] = query
    if accent:
        params["accent"] = accent
    r = requests.get(f"{BASE}/shared-voices", headers=_headers(), params=params, timeout=60)
    r.raise_for_status()
    out = [{"voice_id": v["voice_id"], "name": v["name"], "gender": v.get("gender"), "age": v.get("age"),
            "accent": v.get("accent"), "use_case": v.get("use_case"), "preview_url": v.get("preview_url"),
            "description": (v.get("description") or "")[:120]} for v in r.json().get("voices", [])]
    if want:
        out = [v for v in out if want in (v.get("accent") or "").lower()]
    return out


def voice_info(voice_id: str) -> dict:
    """A voice in the account's library (or a public one): name, labels, preview_url."""
    r = requests.get(f"{BASE}/voices/{voice_id}", headers=_headers(), timeout=30)
    r.raise_for_status()
    v = r.json()
    lb = v.get("labels") or {}
    return {"voice_id": voice_id, "name": v.get("name"), "gender": lb.get("gender"), "accent": lb.get("accent"),
            "preview_url": v.get("preview_url"), "description": (v.get("description") or "")[:120]}


def add_voice(name: str, sample: Path, description: str = "") -> str:
    """Instant Voice Clone from one sample file (≥ 30 s of clean speech works well). Returns the voice_id."""
    with open(sample, "rb") as f:
        r = _post("/voices/add", timeout=180, data={"name": name[:100], "description": description[:500], "remove_background_noise": "true"},
                  files={"files": (sample.name, f, "audio/mpeg")})
    return r.json()["voice_id"]


def delete_voice(voice_id: str) -> None:
    requests.delete(f"{BASE}/voices/{voice_id}", headers=_headers(), timeout=30)


def transcribe(path: Path, language: str = "zho") -> dict:
    """Scribe STT → {text, words:[{text,start,end}]}"""
    with open(path, "rb") as f:
        r = _post("/speech-to-text", data={"model_id": "scribe_v1", "language_code": language}, files={"file": f})
    d = r.json()
    return {"text": d.get("text", ""),
            "words": [{"text": w["text"], "start": w["start"], "end": w["end"]}
                      for w in d.get("words", []) if w.get("type") == "word"]}


_PUNCT = re.compile(r"[\s，。！？、,.!?；;：:「」『』（）()\-–—~～…·]")


def _norm(s: str) -> str:
    """Compare transcripts loosely: strip punctuation and convert to simplified-insensitive form."""
    try:
        from opencc import OpenCC  # optional
        s = OpenCC("t2s").convert(s)
    except Exception:
        pass
    return _PUNCT.sub("", s).lower()


def _char_match(a: str, b: str) -> float:
    """Fraction of script characters found in order in the transcript (LCS ratio)."""
    a, b = _norm(a), _norm(b)
    if not a:
        return 0.0
    prev = [0] * (len(b) + 1)
    for ca in a:
        cur = [0]
        for j, cb in enumerate(b):
            cur.append(prev[j] + 1 if ca == cb else max(prev[j + 1], cur[j]))
        prev = cur
    return prev[-1] / len(a)


def trim_silence(src: Path, dest: Path) -> float:
    ff.ffmpeg("-i", str(src), "-af",
              "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,areverse,"
              "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse",
              "-ar", "44100", str(dest))
    return ff.duration(dest)


def tts_line(text: str, voice_id: str, dest_mp3: Path, *, model: str = "eleven_v3", stability: float = 0.5,
             style: float = 0.0, speed: float = 1.0, tags: str = "", prev: str | None = None,
             nxt: str | None = None) -> None:
    body = {"text": f"{tags} {text}".strip(), "model_id": model,
            "voice_settings": {"stability": stability, "similarity_boost": 0.85, "style": style,
                               "use_speaker_boost": True, "speed": speed}}
    if not model.startswith("eleven_v3"):  # v3 rejects previous_text/next_text ("unsupported_model")
        if prev:
            body["previous_text"] = prev
        if nxt:
            body["next_text"] = nxt
    r = _post(f"/text-to-speech/{voice_id}?output_format=mp3_44100_128", json=body)
    dest_mp3.write_bytes(r.content)


def tts_verified(lines: list[dict], voice_id: str, vo_dir: Path, *, model: str = "eleven_v3",
                 tags: str = "[excited]", stability: float = 0.5, speed: float = 1.0,
                 max_takes: int = 3, threshold: float = 0.9) -> list[dict]:
    """Generate each line, transcribe, retake until the transcript matches the script.
    lines: [{key, text}] → [{key, text, file, duration, transcript, match, takes, ok}]"""
    out = []
    for i, line in enumerate(lines):
        key = line["key"]
        best = None
        for take in range(1, max_takes + 1):
            mp3 = vo_dir / f"{key}_t{take}.mp3"
            tts_line(line["text"], voice_id, mp3, model=model, stability=stability, speed=speed, tags=tags,
                     prev=lines[i - 1]["text"] if i else None,
                     nxt=lines[i + 1]["text"] if i + 1 < len(lines) else None)
            wav = vo_dir / f"{key}_t{take}.wav"
            dur = trim_silence(mp3, wav)
            tr = transcribe(wav)
            match = _char_match(line["text"], tr["text"])
            cand = {"key": key, "text": line["text"], "file": wav.name, "duration": round(dur, 2),
                    "transcript": tr["text"], "match": round(match, 3), "takes": take, "ok": match >= threshold}
            if best is None or match > best["match"]:
                best = cand
            if match >= threshold:
                break
        # Expose the chosen take under a stable filename for the mixer.
        final = vo_dir / f"{key}.wav"
        (vo_dir / best["file"]).replace(final)
        best["file"] = final.name
        out.append(best)
    return out


def music(prompt: str, seconds: int, dest: Path) -> Path:
    r = _post("/music?output_format=mp3_44100_128", timeout=600,
              json={"prompt": prompt, "music_length_ms": int(seconds * 1000), "force_instrumental": True})
    dest.write_bytes(r.content)
    return dest


def sound_effect(prompt: str, seconds: float, dest: Path) -> Path:
    r = _post("/sound-generation", timeout=300, json={"text": prompt, "duration_seconds": seconds})
    dest.write_bytes(r.content)
    return dest


def words_to_lines(words: list[dict], gap: float = 0.35) -> list[dict]:
    """Group STT words into phrases split at pauses: [{start,end,text}]"""
    lines, cur, st, prev = [], "", None, 0.0
    for w in words:
        if st is None:
            st = w["start"]
        if w["start"] - prev > gap and cur:
            lines.append({"start": round(st, 2), "end": round(prev, 2), "text": cur})
            cur, st = "", w["start"]
        cur += w["text"]
        prev = w["end"]
    if cur:
        lines.append({"start": round(st, 2), "end": round(prev, 2), "text": cur})
    return lines


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)
