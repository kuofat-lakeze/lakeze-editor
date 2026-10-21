import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type DeliverableVersion, type LineEdit, type QuickEdits, type ScriptInfo, type Voice } from './api'
import { CapPicker, FontPicker, SuperPicker, StyleHint } from './captionStyles'
import { RecBar, SheetHead, useRecorder } from './Recorder'
import { ask } from './Dialog'

/* 時間軸 (導演模式): the whole finished video laid out like a cutting room — one track per kind of thing,
   the playhead running through all of them:
     畫面  the picture segments (thumbnail, length, where in the source they start, order, drop)
     旁白  the narration lines (words, 唸法, the owner's own take, ⭐, drop)
     標題  the Super titles (words, drop)
     配樂  the music bed (level) and the narration speed
   樣式 holds everything that is not placed in time: caption style, font, Super style, size, price colour, voice.
   Every change is a step in an undo history; 套用 re-renders from the recipe without the editor. */
type Shot = ScriptInfo['shots'][number]
type Line = ScriptInfo['lines'][number]
type ShotEd = { dur?: number; start?: number; drop?: boolean }
type SupEd = { text?: string; drop?: boolean }
type Style = { cap?: string; font?: string; sup?: string; scale?: number; color?: string; gain?: number; speed?: number; voice?: string }
type State = { order: number[]; shots: Record<number, ShotEd>; lines: Record<string, LineEdit>; sups: Record<number, SupEd>; style: Style }
type Sel = { kind: 'shot'; i: number } | { kind: 'line'; key: string } | { kind: 'sup'; i: number } | { kind: 'music' } | null

const MIN = 0.6, MAX = 15, GAP = 0.15
const r1 = (x: number) => Math.round(x * 10) / 10
const tc = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`
const empty = (shots: Shot[]): State => ({ order: shots.map(s => s.i), shots: {}, lines: {}, sups: {}, style: {} })

/** Old timeline second → new one (same rule as backend quick.remap): same offset into the same segment, clamped; a
    dropped segment's moments land where the next kept one starts. */
function remap(t: number, old: Shot[], nu: ({ at: number; dur: number } | null)[]) {
  for (let k = 0; k < old.length; k++) {
    if (t < old[k].at + old[k].dur - 1e-6) {
      const n = nu[k]
      if (!n) { const nxt = nu.slice(k).find(Boolean); if (nxt) return nxt.at; const kept = nu.filter(Boolean) as { at: number; dur: number }[]; return kept.length ? Math.max(...kept.map(x => x.at + x.dur)) : 0 }
      return n.at + Math.min(Math.max(t - old[k].at, 0), n.dur)
    }
  }
  const kept = nu.filter(Boolean) as { at: number; dur: number }[]
  const o = old[old.length - 1], n = kept[kept.length - 1] ?? { at: 0, dur: 0 }
  return n.at + n.dur + Math.max(0, t - o.at - o.dur)
}

export function Timeline({ projectId, version, onClose, onDone, onUsage, initialLines, onLines, tab: tab0 = 'tracks' }:
  { projectId: string; version: DeliverableVersion | null; onClose: () => void; onDone?: () => void; onUsage?: () => void
    initialLines?: Record<string, LineEdit>; onLines?: (l: Record<string, LineEdit>) => void; tab?: 'tracks' | 'style' }) {
  const [info, setInfo] = useState<ScriptInfo | null>(null)
  const [ok, setOk] = useState<boolean | null>(null)
  const [st, setSt] = useState<State>(empty([]))
  const past = useRef<State[]>([]); const future = useRef<State[]>([])
  const [, bump] = useState(0)
  const [sel, setSel] = useState<Sel>(null)
  const [tab, setTab] = useState<'tracks' | 'style'>(tab0)
  const [pps, setPps] = useState(typeof window !== 'undefined' && window.innerWidth < 640 ? 28 : 40)
  const [t, setT] = useState(0)          // playhead, on the current (old) video
  const [playing, setPlaying] = useState(false)
  const [voices, setVoices] = useState<Voice[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [sayOpen, setSayOpen] = useState(false)
  const [saying, setSaying] = useState(false)
  const [takeBusy, setTakeBusy] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  // on a short phone screen the panel pushes the tracks up: keep them in view when something is picked
  useEffect(() => { if (sel && window.innerHeight < 760) wrap.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, [sel])
  const stopAt = useRef<number | null>(null)   // 播放這段: pause when the segment ends
  const src = version?.videos.find(v => v.role === 'preview')?.url ?? version?.main?.url ?? null

  useEffect(() => {
    api.script(projectId).then(r => {
      setInfo(r); setSt({ ...empty(r.shots ?? []), lines: initialLines ?? {} })
      setOk(!!r.quick && (r.shots ?? []).length > 0)
    }).catch(() => setOk(false))
    api.voices().then(setVoices).catch(() => {})
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onLines?.(st.lines) }, [st.lines]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { audio.current?.pause() }, [])

  const shots = info?.shots ?? [], lines = info?.lines ?? [], sups = info?.supers ?? []
  const recut = !!info?.recut
  const shot = (i: number) => shots.find(s => s.i === i)!
  const durOf = (s: Shot) => st.shots[s.i]?.dur ?? s.dur
  const startOf = (s: Shot) => st.shots[s.i]?.start ?? s.start
  const dropped = (s: Shot) => !!st.shots[s.i]?.drop
  const maxDur = (s: Shot) => Math.min(MAX, (s.src_dur ?? s.start + s.dur) - startOf(s))

  // the new layout: kept segments in their order, and where every old moment lands
  const lay = useMemo(() => {
    let at = 0
    const pos: Record<number, { at: number; dur: number }> = {}
    for (const i of st.order) { const s = shot(i); if (!s || dropped(s)) continue; const d = durOf(s); pos[i] = { at, dur: d }; at += d }
    const nu = shots.map(s => pos[s.i] ?? null)
    return { pos, nu, total: at, map: (x: number) => (shots.length ? remap(x, shots, nu) : x) }
  }, [st, shots]) // eslint-disable-line react-hooks/exhaustive-deps
  const oldTotal = shots.length ? shots[shots.length - 1].at + shots[shots.length - 1].dur : (info?.duration ?? 0)
  const placedLines = useMemo(() => {
    let prev = -1
    return [...lines].map(l => ({ l, s: lay.map(l.start), e: 0 })).sort((a, b) => a.s - b.s).map(x => {
      const e = st.lines[x.l.key ?? '']
      const len = x.l.end - x.l.start
      if (e?.drop) return { ...x, e: x.s + len, drop: true }
      let s = x.s; if (prev >= 0 && s < prev) s = prev + GAP   // only a real overlap pushes a line back
      prev = s + len
      return { l: x.l, s, e: s + len, drop: false }
    })
  }, [lines, lay, st.lines])
  const placedSups = useMemo(() => sups.filter(x => !st.sups[x.i]?.drop).map(x => ({ x, s: lay.map(x.start), e: Math.min(lay.map(x.end), lay.total) })), [sups, lay, st.sups])
  const over = placedLines.some(x => !x.drop && x.e > lay.total + 0.2)
  // new time → old video time, for scrubbing on the new layout
  const toOld = (nt: number) => {
    for (const i of st.order) { const p = lay.pos[i]; if (p && nt < p.at + p.dur) return shot(i).at + (nt - p.at) }
    return oldTotal
  }

  // ---- history ----
  const commit = (f: (s: State) => State) => { setSt(s => { past.current = [...past.current.slice(-60), s]; future.current = []; return f(s) }); bump(x => x + 1) }
  const undo = () => { const p = past.current.pop(); if (p) { setSt(s => { future.current.push(s); return p }); bump(x => x + 1) } }
  const redo = () => { const n = future.current.pop(); if (n) { setSt(s => { past.current.push(s); return n }); bump(x => x + 1) } }
  const edShot = (i: number, p: ShotEd) => commit(s => { const cur = { ...(s.shots[i] ?? {}), ...p }; const o = shot(i); if (cur.dur !== undefined && r1(cur.dur) === r1(o.dur)) delete cur.dur; if (cur.start !== undefined && r1(cur.start) === r1(o.start)) delete cur.start; if (!cur.drop) delete cur.drop; const n = { ...s.shots }; if (Object.keys(cur).length) n[i] = cur; else delete n[i]; return { ...s, shots: n } })
  const setDur = (s: Shot, d: number) => edShot(s.i, { dur: r1(Math.max(MIN, Math.min(maxDur(s), d))) })
  const setStart = (s: Shot, x: number) => { const lim = (s.src_dur ?? s.start + s.dur) - MIN; const v = r1(Math.max(0, Math.min(lim, x))); edShot(s.i, { start: v, dur: r1(Math.min(durOf(s), Math.min(MAX, (s.src_dur ?? v + durOf(s)) - v))) }) }
  const move = (i: number, d: -1 | 1) => commit(s => { const o = [...s.order]; const k = o.indexOf(i); const j = k + d; if (j < 0 || j >= o.length) return s; [o[k], o[j]] = [o[j], o[k]]; return { ...s, order: o } })
  const edLine = (key: string, p: LineEdit) => commit(s => {
    const l = lines.find(x => x.key === key)!; const cur: LineEdit = { ...(s.lines[key] ?? {}), ...p }
    if (cur.text !== undefined && cur.text.trim() === l.text) delete cur.text
    if (cur.say !== undefined && (!cur.say.trim() || cur.say.trim() === (cur.text ?? l.text))) delete cur.say
    for (const k of ['star', 'drop', 'take'] as const) if (!cur[k]) delete cur[k]
    const n = { ...s.lines }; if (Object.keys(cur).length) n[key] = cur; else delete n[key]; return { ...s, lines: n }
  })
  const edSup = (i: number, p: SupEd) => commit(s => { const o = sups.find(x => x.i === i)!; const cur = { ...(s.sups[i] ?? {}), ...p }; if (cur.text !== undefined && cur.text.trim() === o.text) delete cur.text; if (!cur.drop) delete cur.drop; const n = { ...s.sups }; if (Object.keys(cur).length) n[i] = cur; else delete n[i]; return { ...s, sups: n } })
  const edStyle = (p: Style) => commit(s => { const cur = { ...s.style, ...p }; (Object.keys(cur) as (keyof Style)[]).forEach(k => { if (cur[k] === undefined || cur[k] === null) delete cur[k] }); return { ...s, style: cur } })
  const stars = Object.values(st.lines).filter(e => e.star).length

  // ---- playback ----
  const onTime = () => { const v = video.current; if (!v) return; setT(v.currentTime); if (stopAt.current !== null && v.currentTime >= stopAt.current) { v.pause(); stopAt.current = null } }
  const seekOld = (x: number, play = false) => { const v = video.current; if (!v) return; v.currentTime = Math.max(0, Math.min(oldTotal, x)); if (play) v.play().catch(() => {}); else v.pause() }
  const playShot = (s: Shot) => { stopAt.current = s.at + Math.min(durOf(s), s.dur) - 0.05; seekOld(s.at + 0.02, true) }
  const playLine = (l: Line) => { stopAt.current = l.end; seekOld(l.start, true) }
  const toggle = () => { const v = video.current; if (!v) return; stopAt.current = null; if (v.paused) v.play().catch(() => {}); else v.pause() }
  const scrubRef = useRef(false)
  const scrubTo = (clientX: number) => { const el = scroll.current; if (!el) return; const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - 12; seekOld(toOld(Math.max(0, x / pps))) }
  const playheadX = lay.map(Math.min(t, oldTotal)) * pps

  // ---- drag a segment's right edge ----
  const drag = useRef<{ i: number; x: number; d: number } | null>(null)
  const onGrip = (i: number, e: React.PointerEvent) => { e.stopPropagation(); (e.target as Element).setPointerCapture(e.pointerId); drag.current = { i, x: e.clientX, d: durOf(shot(i)) }; setSel({ kind: 'shot', i }) }
  const onMove = (e: React.PointerEvent) => { const g = drag.current; if (g) setDur(shot(g.i), g.d + (e.clientX - g.x) / pps); else if (scrubRef.current) scrubTo(e.clientX) }
  const onUp = () => { drag.current = null; scrubRef.current = false }

  // ---- the selected line: 試聽 / 我唸這句 ----
  const curLine = sel?.kind === 'line' ? lines.find(l => l.key === sel.key) : undefined
  const curLE = curLine ? st.lines[curLine.key ?? ''] ?? {} : {}
  const shownText = (l: Line) => st.lines[l.key ?? '']?.text ?? l.text
  const say = async () => {
    if (!curLine || saying) return
    const text = (curLE.say ?? curLE.text ?? curLine.text).trim()
    setSaying(true); setErr('')
    try { video.current?.pause(); const res = await api.say(projectId, text, info?.voice_id ?? ''); onUsage?.(); audio.current?.pause(); const a = new Audio(res.url); audio.current = a; a.onended = () => setSaying(false); await a.play() }
    catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? `點數不足：試聽要 ${ex.needed} 點` : ex.message); setSaying(false) }
  }
  const recorder = useRecorder(async blob => {
    if (!curLine) return
    setTakeBusy(true); setErr('')
    try {
      const fd = new FormData(); fd.append('audio', blob, blob.type.includes('mp4') ? 'take.m4a' : 'take.webm'); fd.append('n', String(curLine.n)); fd.append('voice_id', info?.voice_id ?? '')
      const res = await fetch(`/api/projects/${projectId}/take`, { method: 'POST', body: fd }); const d = await res.json().catch(() => ({}))
      if (!res.ok) throw Object.assign(new Error(d.detail ?? '轉換失敗'), { needed: d.needed })
      onUsage?.(); edLine(curLine.key!, { take: d.key }); audio.current?.pause(); const a = new Audio(d.url); audio.current = a; a.play().catch(() => {})
    } catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? `點數不足：需要 ${ex.needed} 點` : ex.message) } finally { setTakeBusy(false) }
  })

  // ---- what 套用 sends ----
  const edits: QuickEdits = useMemo(() => {
    const e: QuickEdits = {}
    const sh = shots.filter(s => st.shots[s.i]).map(s => ({ i: s.i, ...(st.shots[s.i].dur !== undefined && { dur: durOf(s) }), ...(st.shots[s.i].start !== undefined && { start: startOf(s) }), ...(st.shots[s.i].drop && { drop: true }) }))
    if (sh.length) e.shots = sh
    if (st.order.some((i, k) => shots[k]?.i !== i)) e.order = st.order
    const ln = Object.entries(st.lines).map(([key, v]) => ({ key, ...v }))
    if (ln.length) e.lines = ln
    const sp = Object.entries(st.sups).map(([i, v]) => ({ i: Number(i), ...v }))
    if (sp.length) e.supers = sp
    const y = st.style
    if (y.cap) e.caption_style = y.cap; if (y.font) e.font = y.font; if (y.sup) e.super_style = y.sup; if (y.scale) e.caption_scale = y.scale
    if (y.color) e.counter_color = y.color; if (y.gain !== undefined) e.music_gain = y.gain; if (y.speed) e.speed = y.speed; if (y.voice) e.voice_id = y.voice
    return e
  }, [st, shots]) // eslint-disable-line react-hooks/exhaustive-deps
  const nChanges = (edits.shots?.length ?? 0) + (edits.order ? 1 : 0) + (edits.lines?.length ?? 0) + (edits.supers?.length ?? 0) + Object.keys(st.style).length
  const needsRecut = !!(edits.shots || edits.order)
  const apply = async () => {
    if (needsRecut && !recut) { setErr('原始素材已超過保存期限（7 天），段落長度和順序沒辦法再調；旁白、字幕、樣式還是可以。'); return }
    setBusy(true); setErr('')
    try { await api.quick(projectId, edits); onUsage?.(); onDone?.(); onClose() }
    catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? '點數不足，先儲值再套用' : ex.message); setBusy(false) }
  }
  const cancel = async () => { if (busy) return; if (nChanges === 0 || await ask.confirm('放棄這些修改？', { ok: '放棄', danger: true })) onClose() }

  // ---- render ----
  const H = { shot: 62, line: 30, sup: 24, music: 22, sfx: 18 }
  const ticks = Array.from({ length: Math.floor(Math.max(lay.total, oldTotal)) + 1 }, (_, i) => i).filter(i => pps >= 32 ? true : i % (pps >= 20 ? 2 : 5) === 0)
  const trackW = Math.max(lay.total, oldTotal) * pps + 40
  const curShot = sel?.kind === 'shot' ? shot(sel.i) : undefined
  const curSup = sel?.kind === 'sup' ? sups.find(x => x.i === sel.i) : undefined
  const Opt = <T,>({ v, cur, set, options }: { v: T | undefined; cur: T; set: (x: T | undefined) => void; options: { v: T; l: string }[] }) => (
    <div className="tw-opts">{options.map(o => <button key={String(o.v)} type="button" className={`tw-o ${(v ?? cur) === o.v ? 'on' : ''}`} onClick={() => set(o.v === cur ? undefined : o.v)}>{o.l}</button>)}</div>)

  return (
    <div className="pf-scrim" onClick={e => { if (e.target === e.currentTarget) cancel() }}>
      <div className="pf tl2" role="dialog" aria-label="時間軸">
        <SheetHead title="時間軸" badge={version ? `v${version.version}` : undefined} onCancel={cancel}
          right={<button className="btn primary small" disabled={!ok || nChanges === 0 || busy} onClick={apply}>{busy ? '輸出中…' : nChanges ? `套用 ${nChanges}` : '套用'}</button>} />
        {ok === null && <div className="muted small tl-msg">載入中…</div>}
        {ok === false && <div className="muted small tl-msg">這支還沒有可以細調的版本，請先讓剪輯師輸出一次。</div>}
        {ok && info && (
          <div className="tl2-body">
            <div className="tl2-video">
              {src ? <video ref={video} src={src} playsInline preload="metadata" poster={version?.poster ?? undefined} onTimeUpdate={onTime} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onClick={toggle} />
                : <div className="pf-novideo muted small">這一版沒有影片檔，先調文字與樣式。</div>}
              <div className="tl2-ctl">
                <button type="button" className="tl2-play" onClick={toggle} aria-label={playing ? '暫停' : '播放'}>{playing ? '❚❚' : '▶'}</button>
                <span className="tl2-time">{tc(lay.map(Math.min(t, oldTotal)))} <small>/ {tc(lay.total)}</small></span>
                {r1(lay.total) !== r1(oldTotal) && <small className="muted">原本 {r1(oldTotal)}s</small>}
                {over && <span className="tl-warn">旁白比畫面長</span>}
                <span className="spacer" />
                <button type="button" className="tl2-ib" onClick={undo} disabled={!past.current.length} aria-label="復原" title="復原">↶</button>
                <button type="button" className="tl2-ib" onClick={redo} disabled={!future.current.length} aria-label="重做" title="重做">↷</button>
                <button type="button" className="tl2-ib" onClick={() => setPps(p => Math.max(14, p - 8))} aria-label="縮小">−</button>
                <button type="button" className="tl2-ib" onClick={() => setPps(p => Math.min(80, p + 8))} aria-label="放大">＋</button>
                <div className="seg mini tl2-tabs"><a className={tab === 'tracks' ? 'on' : ''} onClick={() => setTab('tracks')}>軌道</a><a className={tab === 'style' ? 'on' : ''} onClick={() => setTab('style')}>樣式{Object.keys(st.style).length ? ` ${Object.keys(st.style).length}` : ''}</a></div>
              </div>
            </div>

            {tab === 'tracks' && (
              <div className="tl2-wrap" ref={wrap}>
                <div className="tl2-labels" aria-hidden="true">
                  <span style={{ height: 18 }} />
                  <span style={{ height: H.shot }}>畫面</span><span style={{ height: H.line }}>旁白</span>
                  {sups.length > 0 && <span style={{ height: H.sup }}>標題</span>}
                  <span style={{ height: H.music }}>配樂</span>
                  {!!info.sfx?.length && <span style={{ height: H.sfx }}>音效</span>}
                </div>
                <div className="tl2-scroll" ref={scroll} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
                  <div className="tl2-inner" style={{ width: trackW }}>
                    <div className="tl2-ruler" style={{ height: 18 }} onPointerDown={e => { scrubRef.current = true; (e.target as Element).setPointerCapture(e.pointerId); scrubTo(e.clientX) }}>
                      {ticks.map(i => <span key={i} style={{ left: i * pps }}><i />{i % 5 === 0 ? `${i}s` : ''}</span>)}
                    </div>
                    <div className="tl2-track" style={{ height: H.shot }}>
                      {st.order.map((i, k) => {
                        const s = shot(i); if (!s) return null
                        const p = lay.pos[i]; const on = sel?.kind === 'shot' && sel.i === i; const mod = !!st.shots[i] || shots[k]?.i !== i
                        if (!p) return null
                        return (
                          <div key={i} className={`tl-seg ${on ? 'on' : ''} ${mod ? 'mod' : ''}`} style={{ left: p.at * pps, width: p.dur * pps, height: H.shot }} onClick={() => { setSel({ kind: 'shot', i }); seekOld(s.at + 0.02) }}>
                            <img src={api.frameUrl(projectId, s.clip, r1(startOf(s) + Math.min(0.4, p.dur / 2)))} alt="" draggable={false} />
                            <span className="tl-lab"><b>{k + 1}</b>{p.dur * pps > 46 && <i>{r1(p.dur)}s</i>}</span>
                            {recut && <span className="tl-grip" onPointerDown={e => onGrip(i, e)} aria-label="拉長或縮短" />}
                          </div>)
                      })}
                      {shots.filter(dropped).map(s => <div key={`d${s.i}`} className="tl2-dropped" style={{ left: 0 }} />)}
                    </div>
                    <div className="tl2-track" style={{ height: H.line }}>
                      {placedLines.map(({ l, s, e, drop }) => {
                        const ed = st.lines[l.key ?? ''] ?? {}; const on = sel?.kind === 'line' && sel.key === l.key
                        return <span key={l.n} className={`tl-line ${on ? 'on' : ''} ${drop ? 'drop' : ''} ${ed.take ? 'take' : ed.text !== undefined || ed.say !== undefined ? 'ed' : ''} ${ed.star ? 'star' : ''} ${!drop && e > lay.total + 0.2 ? 'over' : ''}`}
                          style={{ left: s * pps, width: Math.max(10, (e - s) * pps - 2) }} title={shownText(l)} onClick={() => { if (l.key) { setSel({ kind: 'line', key: l.key }); setSayOpen(false); seekOld(l.start) } }}>{ed.star && '⭐'}{ed.take && '🎙'}{shownText(l)}</span>
                      })}
                    </div>
                    {sups.length > 0 && (
                      <div className="tl2-track" style={{ height: H.sup }}>
                        {placedSups.map(({ x, s, e }) => <span key={x.i} className={`tl2-sup ${sel?.kind === 'sup' && sel.i === x.i ? 'on' : ''} ${st.sups[x.i] ? 'ed' : ''}`} style={{ left: s * pps, width: Math.max(10, (e - s) * pps - 2) }} onClick={() => { setSel({ kind: 'sup', i: x.i }); seekOld(x.start) }}>{st.sups[x.i]?.text ?? x.text}</span>)}
                      </div>)}
                    <div className="tl2-track" style={{ height: H.music }}>
                      <span className={`tl2-music ${sel?.kind === 'music' ? 'on' : ''}`} style={{ left: 0, width: Math.max(10, lay.total * pps - 2) }} onClick={() => setSel({ kind: 'music' })}>
                        {info.music ? `♪ 配樂 · 音量 ${Math.round(((st.style.gain ?? info.music_gain ?? .55)) * 100)}%` : '沒有配樂'}{(st.style.speed ?? info.speed ?? 1) !== 1 && ` · 旁白 ${st.style.speed ?? info.speed}×`}
                      </span>
                    </div>
                    {!!info.sfx?.length && (
                      <div className="tl2-track" style={{ height: H.sfx }}>
                        {info.sfx.map((x, k) => <span key={k} className="tl2-sfx" style={{ left: lay.map(x.at) * pps }}>🔔 {x.name}</span>)}
                      </div>)}
                    <div className="tl2-head" style={{ left: playheadX }} />
                  </div>
                </div>
              </div>
            )}

            {tab === 'tracks' && !sel && <div className="muted small tl-tip">點一段畫面、一句旁白或一個標題來調整；拉畫面右邊的把手改長度。想換畫面、加一句或重寫，關掉後直接跟剪輯師說。</div>}

            {tab === 'tracks' && curShot && (() => {
              const s = curShot; const k = st.order.indexOf(s.i); const drop = dropped(s)
              const need = lines.filter(l => l.start >= s.at - 1e-6 && l.start < s.at + s.dur - 1e-6 && !st.lines[l.key ?? '']?.drop).reduce((a, l) => a + (l.end - l.start) + (a ? GAP : 0), 0)
              return (
                <div className="tl-panel">
                  <div className="tl-ph"><b>第 {k + 1} 段</b><span className="muted small">素材 #{String(s.clip).padStart(2, '0')} · 原本 {r1(s.dur)} 秒</span><span className="spacer" />
                    <a className="small" onClick={() => playShot(s)}>▶ 播放這段</a>{st.shots[s.i] && <a className="small muted" onClick={() => commit(x => { const n = { ...x.shots }; delete n[s.i]; return { ...x, shots: n } })}>還原</a>}</div>
                  {!recut && <div className="muted small">原始素材已超過保存期限，這段的長度、起點和順序不能再改。</div>}
                  {recut && !drop && <>
                    <div className="tl-row"><span>長度</span>
                      <div className="tl-ctl">
                        <button type="button" onClick={() => setDur(s, durOf(s) - 0.5)} disabled={durOf(s) <= MIN}>−0.5</button>
                        <input type="range" min={MIN} max={r1(maxDur(s))} step={0.1} value={durOf(s)} onChange={e => setDur(s, Number(e.target.value))} aria-label="段落長度" />
                        <button type="button" onClick={() => setDur(s, durOf(s) + 0.5)} disabled={durOf(s) >= maxDur(s) - 0.05}>+0.5</button>
                        <b className="tl-val">{r1(durOf(s))} 秒</b>
                      </div></div>
                    <div className="tl-row"><span>畫面從素材第幾秒開始</span>
                      <div className="tl-ctl">
                        <button type="button" onClick={() => setStart(s, startOf(s) - 0.5)} disabled={startOf(s) <= 0}>◀ 早一點</button><b className="tl-val">{r1(startOf(s))} 秒</b>
                        <button type="button" onClick={() => setStart(s, startOf(s) + 0.5)} disabled={startOf(s) >= (s.src_dur ?? 0) - MIN - 0.05}>晚一點 ▶</button>
                      </div></div>
                    <div className="tl-row"><span>順序</span>
                      <div className="tl-ctl">
                        <button type="button" onClick={() => move(s.i, -1)} disabled={k <= 0}>◀ 往前移</button>
                        <button type="button" onClick={() => move(s.i, 1)} disabled={k >= st.order.length - 1}>往後移 ▶</button>
                        <span className="spacer" />
                        <button type="button" className="danger" onClick={() => { edShot(s.i, { drop: true }); lines.filter(l => l.key && l.start >= s.at - 1e-6 && l.start < s.at + s.dur - 1e-6).forEach(l => edLine(l.key!, { drop: true })) }} disabled={st.order.filter(i => !dropped(shot(i))).length <= 1}>刪掉這段</button>
                      </div></div>
                    {need > durOf(s) + 0.1 && <div className="tl-warn tl-fit">這段的旁白要 {r1(need)} 秒，比畫面長 {r1(need - durOf(s))} 秒，後面的旁白會往後延</div>}
                  </>}
                  {recut && drop && <div className="tl-ctl"><span className="muted small">這段會被拿掉，旁白一起拿掉。</span><span className="spacer" /><button type="button" onClick={() => { edShot(s.i, { drop: false }); lines.filter(l => l.key && l.start >= s.at - 1e-6 && l.start < s.at + s.dur - 1e-6).forEach(l => edLine(l.key!, { drop: false })) }}>還是要這段</button></div>}
                </div>)
            })()}

            {tab === 'tracks' && curLine && (() => {
              const l = curLine; const e = curLE; const txt = shownText(l)
              return (
                <div className="tl-panel">
                  <div className="tl-ph"><b>第 {l.n} 句</b><span className="muted small">{tc(l.start)}</span>
                    {e.take && <em className="pf-badge take">我唸的</em>}{e.text !== undefined && <em className="pf-badge ed">已改</em>}{e.say !== undefined && !e.take && <em className="pf-badge say">唸法</em>}{e.star && <em className="pf-badge star">重點</em>}{e.drop && <em className="pf-badge drop">刪掉</em>}
                    <span className="spacer" /><a className="small" onClick={() => playLine(l)}>▶ 聽這句</a>{st.lines[l.key!] && <a className="small muted" onClick={() => commit(x => { const n = { ...x.lines }; delete n[l.key!]; return { ...x, lines: n } })}>還原</a>}</div>
                  <textarea className="tl2-ta" rows={2} value={txt} disabled={!!e.drop} onChange={ev => edLine(l.key!, { text: ev.target.value })} />
                  {sayOpen && !e.drop && <div className="pf-saybox"><span>怎麼唸<small>唸錯字時用同音字寫給配音看；字幕不受影響</small></span><input value={e.say ?? ''} placeholder={txt} onChange={ev => edLine(l.key!, { say: ev.target.value })} /></div>}
                  {recorder.rec ? <RecBar r={recorder} hint="照這句唸一次，唸完按右邊" /> : (
                    <div className="pf-tools">
                      {!e.drop && <>
                        <button type="button" className="pf-tb" disabled={saying || !txt.trim()} onClick={say}><i>▶</i>{saying ? '播放中' : '試聽'}</button>
                        <button type="button" className={`pf-tb ${e.take ? 'on' : ''}`} disabled={takeBusy} onClick={() => recorder.start()}><i>🎙</i>{takeBusy ? '轉換中…' : e.take ? '再唸一次' : '我唸這句'}</button>
                        <button type="button" className={`pf-tb ${sayOpen || e.say !== undefined ? 'on' : ''}`} onClick={() => setSayOpen(o => !o)}><i>ㄅ</i>唸法</button>
                        <button type="button" className={`pf-tb ${e.star ? 'on' : ''}`} disabled={!e.star && stars >= 3} onClick={() => edLine(l.key!, { star: !e.star })}><i>⭐</i>重點</button>
                      </>}
                      <button type="button" className={`pf-tb ${e.drop ? 'on' : ''}`} onClick={() => edLine(l.key!, { drop: !e.drop })}><i>✕</i>{e.drop ? '還是要' : '刪掉'}</button>
                    </div>)}
                  {recorder.err && <div className="error small">{recorder.err}</div>}
                </div>)
            })()}

            {tab === 'tracks' && curSup && (
              <div className="tl-panel">
                <div className="tl-ph"><b>標題</b><span className="muted small">{tc(curSup.start)}–{tc(curSup.end)}</span><span className="spacer" />{st.sups[curSup.i] && <a className="small muted" onClick={() => commit(x => { const n = { ...x.sups }; delete n[curSup.i]; return { ...x, sups: n } })}>還原</a>}</div>
                <input className="tl2-in" value={st.sups[curSup.i]?.text ?? curSup.text} disabled={!!st.sups[curSup.i]?.drop} onChange={ev => edSup(curSup.i, { text: ev.target.value })} />
                <div className="pf-tools"><button type="button" className={`pf-tb ${st.sups[curSup.i]?.drop ? 'on' : ''}`} onClick={() => edSup(curSup.i, { drop: !st.sups[curSup.i]?.drop })}><i>✕</i>{st.sups[curSup.i]?.drop ? '還是要' : '不要這個標題'}</button></div>
              </div>)}

            {tab === 'tracks' && sel?.kind === 'music' && (
              <div className="tl-panel">
                <div className="tl-ph"><b>配樂與速度</b></div>
                {info.music && <label className="tl-row"><span>配樂音量</span><Opt v={st.style.gain} cur={info.music_gain ?? .55} set={v => edStyle({ gain: v })} options={[{ v: .32, l: '小聲' }, { v: .55, l: '標準' }, { v: .8, l: '大聲' }]} /></label>}
                <label className="tl-row"><span>旁白速度</span><Opt v={st.style.speed} cur={info.speed ?? 1} set={v => edStyle({ speed: v })} options={[{ v: .93, l: '慢一點' }, { v: 1, l: '標準' }, { v: 1.12, l: '快一點' }]} /></label>
                <div className="muted small">想換一首配樂或加音效：關掉後跟剪輯師說。</div>
              </div>)}

            {tab === 'style' && (
              <div className="tl2-style">
                <div className="tl-row"><span>字幕樣式</span><CapPicker value={st.style.cap ?? info.caption_style ?? 'gold'} font={st.style.font ?? info.font} onChange={v => edStyle({ cap: v === (info.caption_style ?? 'gold') ? undefined : v })} /></div>
                <div className="tl-row"><span>字型</span><FontPicker value={st.style.font ?? info.font ?? 'black'} style={st.style.cap ?? info.caption_style} onChange={v => edStyle({ font: v === (info.font ?? 'black') ? undefined : v })} /></div>
                <div className="tl-row"><span>標題樣式<small className="muted"> 上方補充資訊（店名、房型）</small></span><SuperPicker value={st.style.sup ?? info.super_style ?? 'chip'} font={st.style.font ?? info.font} onChange={v => edStyle({ sup: v === (info.super_style ?? 'chip') ? undefined : v })} /></div>
                <StyleHint what="字幕或標題風格" />
                <label className="tl-row"><span>字幕大小</span><Opt v={st.style.scale} cur={info.caption_scale ?? 1} set={v => edStyle({ scale: v })} options={[{ v: .85, l: '小' }, { v: 1, l: '標準' }, { v: 1.2, l: '大' }]} /></label>
                {info.counter && <label className="tl-row"><span>價格字幕顏色</span><Opt v={st.style.color} cur={info.counter.color ?? 'gold'} set={v => edStyle({ color: v })} options={[{ v: 'gold', l: '金' }, { v: 'white', l: '白' }, { v: 'red', l: '紅' }, { v: 'blue', l: '藍' }]} /></label>}
                {voices.length > 0 && <label className="tl-row"><span>旁白聲音<small className="muted"> 換聲音會整支重配</small></span><Opt v={st.style.voice} cur={info.voice_id} set={v => edStyle({ voice: v })} options={voices.map(v => ({ v: v.voice_id, l: (v.custom ? '🎙 我的聲音 ' : '') + v.name }))} /></label>}
              </div>)}
          </div>
        )}
        {err && <div className="error small pf-err">{err}</div>}
        <div className="pf-foot">
          <span className="muted small">{nChanges ? `改了 ${nChanges} 處 · ${needsRecut ? '重剪約 2–3 分鐘' : '重出約 1–2 分鐘'}` : '還沒有改動'}</span><span className="spacer" />
          <button className="btn primary" disabled={!ok || nChanges === 0 || busy} onClick={apply}>{busy ? '重新輸出中…' : '套用 →'}</button>
        </div>
      </div>
    </div>
  )
}
