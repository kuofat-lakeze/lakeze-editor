import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type DeliverableVersion } from './api'

/* 時間軸 (導演模式): every segment of the picture cut on one track, its length and where in the source clip
   it starts adjustable; the narration lane below shows where each line lands after the change. 套用 re-cuts
   from the recipe (quick render) — narration, supers and the price counter move with their segment. */
type Shot = { i: number; clip: number; start: number; dur: number; at: number; src_dur?: number }
type Line = { n: number; key?: string; start: number; end: number; text: string }
type Ed = { dur?: number; start?: number }

const MIN = 0.6, MAX = 15, GAP = 0.15
const r1 = (x: number) => Math.round(x * 10) / 10

/** Old timeline second → new one: same offset into the same segment, clamped to its new length (= backend quick.remap). */
function remap(t: number, old: Shot[], nu: { at: number; dur: number }[]) {
  for (let k = 0; k < old.length; k++) if (t < old[k].at + old[k].dur - 1e-6) return nu[k].at + Math.min(Math.max(t - old[k].at, 0), nu[k].dur)
  const o = old[old.length - 1], n = nu[nu.length - 1]
  return n.at + n.dur + Math.max(0, t - o.at - o.dur)
}

export function Timeline({ projectId, version, onClose, onDone, onUsage }:
  { projectId: string; version: DeliverableVersion | null; onClose: () => void; onDone?: () => void; onUsage?: () => void }) {
  const [shots, setShots] = useState<Shot[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [ok, setOk] = useState<boolean | null>(null)
  const [ed, setEd] = useState<Record<number, Ed>>({})
  const [sel, setSel] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const src = version?.videos.find(v => v.role === 'preview')?.url ?? version?.main?.url ?? null
  useEffect(() => {
    api.script(projectId).then(r => { setShots(r.shots ?? []); setLines(r.lines); setOk(!!r.quick && !!r.recut && (r.shots ?? []).length > 0) }).catch(() => setOk(false))
  }, [projectId])

  const durOf = (s: Shot) => ed[s.i]?.dur ?? s.dur
  const startOf = (s: Shot) => ed[s.i]?.start ?? s.start
  const maxDur = (s: Shot) => Math.min(MAX, (s.src_dur ?? s.start + s.dur) - startOf(s))
  const nu = useMemo(() => { let at = 0; return shots.map(s => { const d = durOf(s); const x = { at, dur: d }; at += d; return x }) }, [shots, ed]) // eslint-disable-line react-hooks/exhaustive-deps
  const total = nu.length ? nu[nu.length - 1].at + nu[nu.length - 1].dur : 0
  const oldTotal = shots.length ? shots[shots.length - 1].at + shots[shots.length - 1].dur : 0
  // narration after the change: each line moves with its segment, later lines pushed back when they'd overlap
  const placed = useMemo(() => {
    let prev = -1
    return lines.map(l => {
      let s = shots.length ? remap(l.start, shots, nu) : l.start
      const len = l.end - l.start
      if (prev >= 0 && s < prev + GAP) s = prev + GAP
      prev = s + len
      return { ...l, s, e: s + len }
    })
  }, [lines, shots, nu])
  const over = placed.some(l => l.e > total + 0.2)
  const changed = shots.filter(s => ed[s.i] && (r1(durOf(s)) !== r1(s.dur) || r1(startOf(s)) !== r1(s.start)))

  const pps = typeof window !== 'undefined' && window.innerWidth < 640 ? 26 : 34   // pixels per second
  const setDur = (s: Shot, d: number) => setEd(e => ({ ...e, [s.i]: { ...e[s.i], dur: r1(Math.max(MIN, Math.min(maxDur(s), d))) } }))
  const setStart = (s: Shot, t: number) => {
    const lim = (s.src_dur ?? s.start + s.dur) - MIN
    const st = r1(Math.max(0, Math.min(lim, t)))
    setEd(e => ({ ...e, [s.i]: { ...e[s.i], start: st, dur: r1(Math.min(durOf(s), Math.min(MAX, (s.src_dur ?? st + durOf(s)) - st))) } }))
  }
  const reset = (s: Shot) => setEd(e => { const n = { ...e }; delete n[s.i]; return n })
  const pick = (k: number) => { setSel(k); const v = video.current; if (v && shots[k]) { v.currentTime = shots[k].at + 0.05; v.pause() } }

  // drag the right edge of a segment to change its length
  const drag = useRef<{ k: number; x: number; d: number } | null>(null)
  const onDown = (k: number, e: React.PointerEvent) => { e.stopPropagation(); (e.target as Element).setPointerCapture(e.pointerId); drag.current = { k, x: e.clientX, d: durOf(shots[k]) }; setSel(k) }
  const onMove = (e: React.PointerEvent) => { const g = drag.current; if (g) setDur(shots[g.k], g.d + (e.clientX - g.x) / pps) }
  const onUp = () => { drag.current = null }

  const apply = async () => {
    setBusy(true); setErr('')
    try {
      await api.quick(projectId, { shots: changed.map(s => ({ i: s.i, dur: durOf(s), start: startOf(s) })) })
      onUsage?.(); onDone?.(); onClose()
    } catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? '點數不足，先儲值再套用' : ex.message); setBusy(false) }
  }

  const cur = shots[sel]
  // the narration that starts in the selected segment, and how long it needs
  const need = cur ? lines.filter(l => l.start >= cur.at - 1e-6 && l.start < cur.at + cur.dur - 1e-6).reduce((a, l) => a + (l.end - l.start) + (a ? GAP : 0), 0) : 0
  const ticks = Array.from({ length: Math.floor(total / 5) + 1 }, (_, i) => i * 5)
  return (
    <div className="pf-scrim" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="tw tl" role="dialog" aria-label="時間軸">
        <div className="pf-head"><b>時間軸</b><span className="muted small">拉每段的長度，旁白跟著走</span><span className="spacer" /><a className="pf-x" onClick={() => !busy && onClose()} aria-label="關閉">✕</a></div>
        {ok === null && <div className="muted small tl-msg">載入中…</div>}
        {ok === false && <div className="muted small tl-msg">{shots.length === 0 ? '這支還沒有可以調的分鏡，請先讓剪輯師輸出一次。' : '原始素材已超過保存期限（7 天），段落長度沒辦法再調。可以直接跟剪輯師說要怎麼改。'}</div>}
        {ok && (
          <div className="tl-body">
            {src && <video ref={video} className="tl-video" src={src} playsInline muted controls preload="metadata" poster={version?.poster ?? undefined} />}
            <div className="tl-sum">
              <span>總長 <b>{r1(total)} 秒</b>{r1(total) !== r1(oldTotal) && <small className="muted"> 原本 {r1(oldTotal)} 秒（{total > oldTotal ? '+' : ''}{r1(total - oldTotal)}）</small>}</span>
              {over && <span className="tl-warn">旁白比畫面長，最後會被切掉</span>}
            </div>
            <div className="tl-scroll" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
              <div className="tl-inner" style={{ width: Math.max(total, oldTotal) * pps + 24 }}>
                <div className="tl-ruler">{ticks.map(t => <span key={t} style={{ left: t * pps }}>{t}s</span>)}</div>
                <div className="tl-track">
                  {shots.map((s, k) => {
                    const d = durOf(s), w = d * pps, mod = changed.includes(s)
                    return (
                      <div key={s.i} className={`tl-seg ${k === sel ? 'on' : ''} ${mod ? 'mod' : ''}`} style={{ left: nu[k].at * pps, width: w }} onClick={() => pick(k)}>
                        <img src={api.frameUrl(projectId, s.clip, r1(startOf(s) + Math.min(0.4, d / 2)))} alt="" draggable={false} />
                        <span className="tl-lab"><b>{k + 1}</b>{w > 46 && <i>{r1(d)}s</i>}</span>
                        <span className="tl-grip" onPointerDown={e => onDown(k, e)} aria-label="拉長或縮短" />
                      </div>)
                  })}
                </div>
                <div className="tl-vo">
                  {placed.map(l => <span key={l.n} className={`tl-line ${l.e > total + 0.2 ? 'over' : ''}`} style={{ left: l.s * pps, width: Math.max(8, (l.e - l.s) * pps - 2) }} title={l.text}>{l.text}</span>)}
                </div>
              </div>
            </div>
            {cur && (
              <div className="tl-panel">
                <div className="tl-ph"><b>第 {sel + 1} 段</b><span className="muted small">素材 #{String(cur.clip).padStart(2, '0')} · 原本 {r1(cur.dur)} 秒</span><span className="spacer" />{changed.includes(cur) && <a className="small" onClick={() => reset(cur)}>還原這段</a>}</div>
                <div className="tl-row"><span>長度</span>
                  <div className="tl-ctl">
                    <button type="button" onClick={() => setDur(cur, durOf(cur) - 0.5)} disabled={durOf(cur) <= MIN}>−0.5</button>
                    <input type="range" min={MIN} max={r1(maxDur(cur))} step={0.1} value={durOf(cur)} onChange={e => setDur(cur, Number(e.target.value))} aria-label="段落長度" />
                    <button type="button" onClick={() => setDur(cur, durOf(cur) + 0.5)} disabled={durOf(cur) >= maxDur(cur) - 0.05}>+0.5</button>
                    <b className="tl-val">{r1(durOf(cur))} 秒</b>
                  </div>
                </div>
                <div className="tl-row"><span>畫面從素材第幾秒開始</span>
                  <div className="tl-ctl">
                    <button type="button" onClick={() => setStart(cur, startOf(cur) - 0.5)} disabled={startOf(cur) <= 0}>◀ 早一點</button>
                    <b className="tl-val">{r1(startOf(cur))} 秒</b>
                    <button type="button" onClick={() => setStart(cur, startOf(cur) + 0.5)} disabled={startOf(cur) >= (cur.src_dur ?? 0) - MIN - 0.05}>晚一點 ▶</button>
                  </div>
                </div>
                {need > durOf(cur) + 0.1 && <div className="tl-warn tl-fit">這段的旁白要 {r1(need)} 秒，比畫面長 {r1(need - durOf(cur))} 秒，後面的旁白會往後延</div>}
                {maxDur(cur) - durOf(cur) < 0.15 && <div className="muted small">這段素材只剩這麼長，想再長就把起點往前移。</div>}
              </div>
            )}
            <div className="muted small tl-tip">💬 想換畫面、重排順序？直接跟剪輯師說，例如「第 3 段換成泳池空拍」。</div>
          </div>
        )}
        {err && <div className="error small pf-err">{err}</div>}
        <div className="pf-foot">
          <span className="muted small">{changed.length ? `改了 ${changed.length} 段` : '拉段落右邊的把手，或用下面的按鈕'}</span><span className="spacer" />
          <button className="btn primary" disabled={!ok || changed.length === 0 || busy} onClick={apply}>{busy ? '重新剪接中…（約 2–3 分鐘）' : '套用 →'}</button>
        </div>
      </div>
    </div>
  )
}
