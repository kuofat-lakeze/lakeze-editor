import { useEffect, useMemo, useRef, useState } from 'react'
import { api, verLabel, type DeliverableVersion, type LineEdit, type QuickEdits, type ScriptInfo } from './api'
import { RecBar, SheetHead, useRecorder } from './Recorder'
import { ask } from './Dialog'

/* 校對旁白 (輕鬆模式): the finished video and its narration, one big row per line. Each row can be
   listened to, re-read by the owner (speech-to-speech in the video's voice) or dropped — the picture
   segment goes with it. ▶ plays that segment of the current version. 導演模式 has the 時間軸 for anything finer. */
type Row = { line: ScriptInfo['lines'][number]; shot: ScriptInfo['shots'][number] | undefined }
type State = { order: number[]; drops: Set<number>; lines: Record<string, LineEdit> }
const tc = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function Proof({ projectId, version, onClose, onUsage, onDone, hasOwnVoice = false, onClone, onOwnVoice, onPro, initialLines, onLines }:
  { projectId: string; version: DeliverableVersion | null; onClose: () => void; onUsage?: () => void; onDone?: () => void
    hasOwnVoice?: boolean; onClone?: () => void; onOwnVoice?: () => void; onPro?: () => void; initialLines?: Record<string, LineEdit>; onLines?: (l: Record<string, LineEdit>) => void }) {
  const [info, setInfo] = useState<ScriptInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [st, setSt] = useState<State>({ order: [], drops: new Set(), lines: initialLines ?? {} })
  const past = useRef<State[]>([]); const [, bump] = useState(0)
  const [cur, setCur] = useState(-1)
  const [takeFor, setTakeFor] = useState<string | null>(null)
  const [takeBusy, setTakeBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [err, setErr] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const stopAt = useRef<number | null>(null)
  const src = version?.videos.find(v => v.role === 'preview')?.url ?? version?.main?.url ?? null
  useEffect(() => {
    api.script(projectId).then(r => { setInfo(r); setSt(s => ({ ...s, order: (r.shots ?? []).map(x => x.i) })) }).catch(() => {}).finally(() => setLoading(false))
  }, [projectId])
  useEffect(() => { onLines?.(st.lines) }, [st.lines]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { audio.current?.pause() }, [])

  const shots = info?.shots ?? [], lines = info?.lines ?? []
  const recut = !!info?.recut
  const shotOf = (l: ScriptInfo['lines'][number]) => shots.find(s => l.start >= s.at - 1e-6 && l.start < s.at + s.dur - 1e-6)
  // rows in their current order: segments as ordered, each with the line that starts in it; lines in no segment at the end
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const i of st.order) { const s = shots.find(x => x.i === i); if (!s) continue; for (const l of lines) if (shotOf(l)?.i === i) out.push({ line: l, shot: s }) }
    for (const l of lines) if (!shotOf(l)) out.push({ line: l, shot: undefined })
    return out
  }, [st.order, shots, lines]) // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (f: (s: State) => State) => { setSt(s => { past.current = [...past.current.slice(-40), s]; return f(s) }); bump(x => x + 1) }
  const undo = () => { const p = past.current.pop(); if (p) { setSt(p); bump(x => x + 1) } }
  const isDropped = (r: Row) => !!st.lines[r.line.key ?? '']?.drop
  const toggleDrop = (r: Row) => commit(s => {
    const key = r.line.key ?? ''; const drop = !s.lines[key]?.drop
    const ln = { ...s.lines }; const cur = { ...(ln[key] ?? {}) }; if (drop) cur.drop = true; else delete cur.drop; if (Object.keys(cur).length) ln[key] = cur; else delete ln[key]
    const drops = new Set(s.drops)
    if (r.shot) { const others = lines.filter(l => l !== r.line && shotOf(l)?.i === r.shot!.i && !ln[l.key ?? '']?.drop); if (drop && !others.length) drops.add(r.shot.i); else drops.delete(r.shot.i) }
    return { ...s, lines: ln, drops }
  })
  const setTake = (key: string, take: string) => commit(s => ({ ...s, lines: { ...s.lines, [key]: { ...(s.lines[key] ?? {}), take } } }))
  const nTakes = Object.values(st.lines).filter(e => e.take).length
  const nDrops = Object.values(st.lines).filter(e => e.drop).length
  const moved = st.order.some((i, k) => shots[k]?.i !== i)
  const changed = nTakes + nDrops + (moved ? 1 : 0)
  const keptRows = rows.filter(r => !isDropped(r))

  const onTime = () => { const v = video.current; if (!v) return; const t = v.currentTime; setCur(rows.findIndex(r => t >= r.line.start && t < r.line.end)); if (stopAt.current !== null && t >= stopAt.current) { v.pause(); stopAt.current = null } }
  const play = (r: Row) => { const v = video.current; if (!v) return; stopAt.current = r.line.end + 0.1; v.currentTime = r.line.start; v.play().catch(() => {}) }
  const recorder = useRecorder(async blob => {
    const key = takeFor; const r = rows.find(x => x.line.key === key); setTakeFor(null)
    if (!key || !r) return
    setTakeBusy(true); setErr('')
    try {
      const fd = new FormData(); fd.append('audio', blob, blob.type.includes('mp4') ? 'take.m4a' : 'take.webm'); fd.append('n', String(r.line.n)); fd.append('voice_id', info?.voice_id ?? '')
      const res = await fetch(`/api/projects/${projectId}/take`, { method: 'POST', body: fd }); const d = await res.json().catch(() => ({}))
      if (!res.ok) throw Object.assign(new Error(d.detail ?? '轉換失敗'), { needed: d.needed })
      onUsage?.(); setTake(key, d.key); audio.current?.pause(); const a = new Audio(d.url); audio.current = a; a.play().catch(() => {})
    } catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? `點數不足：需要 ${ex.needed} 點` : ex.message) } finally { setTakeBusy(false) }
  })
  const startTake = async (r: Row) => { video.current?.pause(); setTakeFor(r.line.key ?? null); if (!await recorder.start()) setTakeFor(null) }

  const apply = async () => {
    if (!info?.quick) { setErr('這支還沒有可以直接套用的版本，請先讓剪輯師重新輸出一次。'); return }
    if ((moved || st.drops.size) && !recut) { setErr('原始素材已超過保存期限（7 天），順序沒辦法再調；自己唸的句子還是可以套用。'); return }
    setApplying(true); setErr('')
    try {
      const e: QuickEdits = {}
      if (moved) e.order = st.order
      if (st.drops.size) e.shots = [...st.drops].map(i => ({ i, drop: true }))
      const ln = Object.entries(st.lines).map(([key, v]) => ({ key, ...v })); if (ln.length) e.lines = ln
      await api.quick(projectId, e); onUsage?.(); onDone?.(); onClose()
    } catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? '點數不足，先儲值再套用' : ex.message); setApplying(false) }
  }
  const cancel = async () => { if (applying) return; if (changed === 0 || await ask.confirm('放棄這些修改？', { ok: '放棄', danger: true })) onClose() }

  return (
    <div className="pf-scrim" onClick={e => { if (e.target === e.currentTarget) cancel() }}>
      <div className="pf" role="dialog" aria-label="校對旁白">
        <SheetHead title="校對旁白" badge={version ? verLabel(version.version) : undefined} sub="聽一聽，唸錯的自己唸；不要的拿掉" onCancel={cancel}
          right={<button className="btn primary small" disabled={changed === 0 || applying} onClick={apply}>{applying ? '輸出中…' : '套用'}</button>} />
        <div className="pf-body">
          <div className="pf-video">
            {src ? <video ref={video} src={src} controls playsInline preload="metadata" poster={version?.poster ?? undefined} onTimeUpdate={onTime} onLoadedMetadata={onTime} />
              : <div className="pf-novideo muted small">這一版還沒有影片檔。</div>}
          </div>
          <ol className="pf-lines ez">
            {hasOwnVoice && onOwnVoice && !loading && rows.length > 0 && (
              <li className="pf-own"><div><b><span className="pill rec">推薦</span> 整支換成你的聲音</b><span>用你錄好的聲音重配整支旁白，約 1–2 分鐘</span></div><button type="button" className="btn primary" onClick={onOwnVoice}>🎙 換成我的聲音</button></li>)}
            {!hasOwnVoice && onClone && !loading && rows.length > 0 && (
              <li className="pf-own"><div><b><span className="pill rec">推薦</span> 用你自己的聲音</b><span>錄 30 秒，整支影片的旁白就是你的聲音，客人最有感</span></div><button type="button" className="btn primary" onClick={onClone}>🎙 錄我的聲音</button></li>)}
            {loading && <li className="muted small pf-empty">載入旁白稿…</li>}
            {!loading && rows.length === 0 && <li className="muted small pf-empty">找不到這支的旁白稿，之後再來校對。</li>}
            {rows.map((r, i) => {
              const e = st.lines[r.line.key ?? ''] ?? {}; const drop = !!e.drop; const n = keptRows.indexOf(r) + 1
              const recHere = recorder.rec && takeFor === r.line.key
              return (
                <li key={r.line.n} className={`pf-line ez ${i === cur ? 'cur' : ''} ${e.take ? 'star' : ''} ${drop ? 'drop' : ''}`}>
                  <div className="pf-row" onClick={() => play(r)}>
                    {r.shot ? <img className="pf-thumb" src={api.frameUrl(projectId, r.shot.clip, r.shot.start)} alt="" /> : <span className="pf-thumb" />}
                    <a className="pf-tc"><b>{drop ? '✕' : n}</b><span>{tc(r.line.start)}</span></a>
                    <div className="pf-txt"><div className="pf-ez-text">{r.line.text}</div>
                      {e.take && !drop && <em className="pf-badge take">✓ 已換成你唸的</em>}{drop && <em className="pf-badge drop">會拿掉</em>}
                    </div>
                  </div>
                  {recHere ? <RecBar r={recorder} hint="照這句唸一次" /> : (
                    <div className="pf-tools" onClick={ev => ev.stopPropagation()}>
                      {!drop && <>
                        <button type="button" className="pf-tb" onClick={() => play(r)}><i>▶</i>聽這句</button>
                        <button type="button" className={`pf-tb ${e.take ? 'on' : ''}`} disabled={recorder.rec || takeBusy} onClick={() => startTake(r)}><i>🎙</i>{takeBusy && takeFor === null && e.take === undefined ? '轉換中…' : e.take ? '再唸一次' : '唸錯了，我自己唸'}</button>
                      </>}
                      <button type="button" className={`pf-tb ${drop ? 'on' : ''}`} disabled={!drop && keptRows.length <= 1} onClick={() => toggleDrop(r)}><i>✕</i>{drop ? '還是要' : '拿掉'}</button>
                    </div>)}
                </li>)
            })}
            {onPro && !loading && <li className="pf-topro"><span>想逐句改字、調每段長度？</span><a onClick={onPro}>到導演模式細改 →</a></li>}
          </ol>
        </div>
        {(err || recorder.err) && <div className="error small pf-err">{err || recorder.err}</div>}
        <div className="pf-foot">
          {past.current.length > 0 && !applying && <button type="button" className="btn small" onClick={undo}>↶ 復原</button>}
          <span className="muted small">{changed > 0 ? [nTakes && `重唸 ${nTakes} 句`, nDrops && `拿掉 ${nDrops} 句`, moved && '換了順序'].filter(Boolean).join(' · ') : '唸得都對就不用改'}</span>
          <span className="spacer" />
          <button className="btn primary" disabled={changed === 0 || applying} onClick={apply}>{applying ? '重新輸出中…（約 1–2 分鐘）' : '套用修改 →'}</button>
        </div>
      </div>
    </div>
  )
}
