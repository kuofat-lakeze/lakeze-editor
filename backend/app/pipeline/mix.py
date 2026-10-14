"""Place voice lines on the timeline, duck music under them, normalise, mux and export."""
from pathlib import Path

from . import ff
from .eleven import transcribe, words_to_lines


def compose(root: Path, placements: list[dict], music: Path | None, duration: float, *,
            music_gain: float = 0.55, duck_ratio: float = 6.0, sfx: list[dict] | None = None) -> dict:
    """placements: [{key, at, tempo?, trim_end?}]  sfx: [{file, at, gain?}]
    Writes work/mix.wav (full mix) and work/vo_only.wav (for caption timing)."""
    vo_dir = root / "work" / "vo"
    ins, fc, labs = [], [], []
    for k, p in enumerate(placements):
        ins += ["-i", str(vo_dir / f"{p['key']}.wav")]
        chain = f"[{k}:a]"
        if p.get("trim_end"):
            chain += f"atrim=0:{p['trim_end']},"
        tp = float(p.get("tempo", 1.0))
        if abs(tp - 1.0) > 1e-3:
            chain += f"atempo={tp:.3f},"
        chain += f"adelay={int(float(p['at']) * 1000)}:all=1[v{k}]"
        fc.append(chain)
        labs.append(f"[v{k}]")
    n = len(placements)
    vo_chain = ("".join(labs) + f"amix=inputs={n}:normalize=0," if n > 1 else labs[0]) if n else "anullsrc=r=44100:cl=mono,"
    fc.append(vo_chain + "highpass=f=90,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,volume=1.6,"
              f"aresample=44100,aformat=channel_layouts=stereo,apad,atrim=0:{duration},asplit=3[vo][sc][vox]")
    fc.append(f"[vox]anull[voout]")
    m = n
    layers = ["[vo]"]
    if music:
        ins += ["-i", str(music)]
        fc.append(f"[{m}:a]atrim=0:{duration},volume={music_gain},afade=t=out:st={duration - 0.9:.2f}:d=0.9,"
                  "aresample=44100,aformat=channel_layouts=stereo[mu]")
        fc.append(f"[mu][sc]sidechaincompress=threshold=0.03:ratio={duck_ratio}:attack=20:release=350:makeup=1[duck]")
        layers.append("[duck]")
        m += 1
    else:
        fc.append("[sc]anullsink")
    for s in sfx or []:
        ins += ["-i", str(root / "work" / s["file"])]
        fc.append(f"[{m}:a]volume={s.get('gain', 0.5)},adelay={int(float(s['at']) * 1000)}:all=1,"
                  "aresample=44100,aformat=channel_layouts=stereo[sfx{m}]".replace("[sfx", "[fx"))
        layers.append(f"[fx{m}]")
        m += 1
    fc.append("".join(layers) + f"amix=inputs={len(layers)}:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[out]")
    mix = root / "work" / "mix.wav"
    vo_only = root / "work" / "vo_only.wav"
    ff.ffmpeg(*ins, "-filter_complex", ";".join(fc), "-map", "[out]", "-c:a", "pcm_s16le", str(mix),
              "-map", "[voout]", "-c:a", "pcm_s16le", str(vo_only))
    tr = transcribe(vo_only) if n else {"text": "", "words": []}
    return {"mix": mix, "vo_only": vo_only, "transcript": tr["text"], "words": tr["words"],
            "lines": words_to_lines(tr["words"])}


def mux_and_export(video: Path, mix: Path, out_dir: Path, stem: str = "final") -> dict:
    final = out_dir / f"{stem}.mp4"
    ff.ffmpeg("-i", str(video), "-i", str(mix), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac",
              "-b:a", "192k", "-shortest", "-movflags", "+faststart", str(final))
    f1080 = out_dir / f"{stem}_1080.mp4"
    ff.ffmpeg("-i", str(final), "-c:v", "libx264", "-preset", "slow", "-b:v", "5200k", "-maxrate", "7000k",
              "-bufsize", "10000k", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", str(f1080))
    web = out_dir / f"{stem}_web.mp4"
    ff.ffmpeg("-i", str(final), "-vf", "scale=720:1280:flags=lanczos", "-c:v", "libx264", "-crf", "26",
              "-preset", "slow", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(web))
    return {"master": final, "upload": f1080, "preview": web}


def preview_with_music(video: Path, music: Path, dest: Path) -> Path:
    ff.ffmpeg("-i", str(video), "-i", str(music), "-map", "0:v", "-map", "1:a", "-vf", "scale=720:1280",
              "-c:v", "libx264", "-crf", "27", "-preset", "fast", "-c:a", "aac", "-b:a", "128k",
              "-af", "afade=t=out:st=35.5:d=1", "-shortest", str(dest))
    return dest
