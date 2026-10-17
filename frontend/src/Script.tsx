import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { api, type Voice } from './api'

/* The other way to voice a script: pick another AI voice (or the user's cloned one). Chat provides the
   voice list and what to do with a choice; script cards in assistant messages show the picker. */
export type VoiceSwap = {
  voices: Voice[]; current?: string | null; playing?: string | null
  onPreview: (v: Voice) => void; onSample?: (v: Voice) => void; onPick: (v: Voice) => void; onMore: () => void; disabled?: boolean
  canClone?: boolean; onReclone?: () => void   // (re)record the user's own voice; Chat re-voices the script with it
  onProof?: (lines: Line[]) => void             // 導演模式: open the 校對台 with this script
}
export const VoiceSwapCtx = createContext<VoiceSwap | null>(null)

/* 旁白稿: the editor writes narration as a ```旁白 block, one "start-end text" line each. In the
   thread it becomes a card with timecodes and a 「用自己的聲音唸」 button that opens a teleprompter:
   big text, the current line follows the timecodes, recorded with the mic and uploaded as the VO. */
export type Line = { start: number; end: number; text: string }
const LINE_RE = /^\s*(\d+(?:\.\d+)?)\s*s?\s*[-–~～到]\s*(\d+(?:\.\d+)?)\s*s?\s*[|｜:：·]?\s*(.+?)\s*$/
export const SCRIPT_BLOCK = /```(?:旁白|旁白稿|vo|narration)[^\n]*\n([\s\S]*?)```/g

export function parseScript(body: string): Line[] {
  const out: Line[] = []
  for (const raw of body.split('\n')) {
    const m = LINE_RE.exec(raw)
    if (m) out.push({ start: +m[1], end: +m[2], text: m[3].replace(/^[「"]|[」"]$/g, '') })
    else if (raw.trim()) {   // a line without timecodes: estimate from the previous one (3.5 chars/s)
      const prev = out[out.length - 1]?.end ?? 0
      const t = raw.trim()
      out.push({ start: prev, end: +(prev + Math.max(1.2, t.length / 3.5)).toFixed(1), text: t })
    }
  }
  return out
}
const tc = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}${s % 1 ? `.${Math.round((s % 1) * 10)}` : ''}`

export function ScriptCard({ lines, onRecord }: { lines: Line[]; onRecord?: () => void }) {
  const total = lines.length ? lines[lines.length - 1].end : 0
  const [copied, setCopied] = useState(false)
  const swap = useContext(VoiceSwapCtx)
  return (
    <div className="vo-card">
      <div className="vo-head">
        <span className="vo-ic" aria-hidden="true">🎙</span>
        <b>旁白稿</b><span className="muted small">{lines.length} 句 · 約 {Math.round(total)} 秒</span>
        <span className="spacer" />
        {onRecord && swap?.onProof && <a className="small vo-proof" onClick={() => swap.onProof!(lines)}>校對台 ▸</a>}
        <a className="small" onClick={() => { navigator.clipboard?.writeText(lines.map(l => l.text).join('\n')).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? '已複製' : '複製'}</a>
      </div>
      <ol className="vo-lines">
        {lines.map((l, i) => (
          <li key={i}><span className="vo-tc">{tc(l.start)}<i>–{tc(l.end)}</i></span><span className="vo-text">{l.text}</span><span className="vo-dur">{(l.end - l.start).toFixed(1)}s</span></li>))}
      </ol>
      {onRecord && (
        <button className="vo-rec-cta" onClick={onRecord}>
          <span className="vo-mic" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5a4 4 0 0 0 4 4zm7-4a7 7 0 0 1-14 0M12 18v3" /></svg></span>
          <span><b>想用自己的聲音？照稿唸一遍直接上傳</b><small>提詞機會照秒數帶你唸，唸完剪輯師直接拿來配</small></span>
          <i aria-hidden="true">→</i>
        </button>
      )}
      {onRecord && <VoicePicker />}
    </div>
  )
}

/* 「或換一個聲音」: choose, then confirm, so a stray tap doesn't re-voice the video. */
function VoicePicker() {
  const ctx = useContext(VoiceSwapCtx)
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  if (!ctx || !ctx.voices.length) return null
  const chosen = ctx.voices.find(v => v.voice_id === sel)
  return (
    <div className={`vs ${open ? 'open' : ''}`}>
      <button type="button" className="vs-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="vs-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10v4M7 7v10M11 4v16M15 8v8M19 11v2" /></svg></span>
        <span><b>或換一個聲音配這份稿</b><small>試聽後選一個，剪輯師用新聲音重新配音、重新輸出</small></span>
        <i aria-hidden="true">{open ? '▴' : '▾'}</i>
      </button>
      {open && (
        <div className="vs-body">
          <div className="vs-list">
            {ctx.voices.map(v => {
              const isCur = v.voice_id === ctx.current
              return (
                <div key={v.voice_id} role="button" tabIndex={0} className={`vs-item ${sel === v.voice_id ? 'sel' : ''} ${v.custom ? 'mine' : ''}`}
                  onClick={() => setSel(v.voice_id)} onKeyDown={e => { if (e.key === 'Enter') setSel(v.voice_id) }}>
                  <span className="vs-radio" aria-hidden="true" />
                  <span className="vs-main">
                    <b>{v.custom && <em>我的聲音</em>}{v.name}<span className="muted small">{v.gender === 'female' ? ' · 女' : v.gender === 'male' ? ' · 男' : ''}{isCur ? ' · 目前' : ''}</span></b>
                    {v.description && <small>{v.description}</small>}
                    {v.custom && <span className="vs-mine-act">
                      {v.sample_url && ctx.onSample && <a onClick={e => { e.stopPropagation(); ctx.onSample!(v) }}>{ctx.playing === `${v.voice_id}:sample` ? '■ 停止' : '聽原始錄音'}</a>}
                      {ctx.onReclone && <a onClick={e => { e.stopPropagation(); setOpen(false); ctx.onReclone!() }}>重錄並重新配音</a>}
                    </span>}
                  </span>
                  {v.preview_url && <a className="vs-play" title={v.custom ? '試聽 AI 用你的聲音配出來的樣子' : '試聽'} onClick={e => { e.stopPropagation(); ctx.onPreview(v) }}>{ctx.playing === v.voice_id ? '■' : '▶'}</a>}
                </div>)
            })}
            {ctx.canClone && ctx.onReclone && !ctx.voices.some(v => v.custom) && (
              <div role="button" tabIndex={0} className="vs-item add" onClick={() => { setOpen(false); ctx.onReclone!() }}>
                <span className="vs-radio plus" aria-hidden="true">＋</span>
                <span className="vs-main"><b>用自己的聲音</b><small>錄 30 秒，錄好就用你的聲音重新配這份稿</small></span>
              </div>)}
          </div>
          <div className="vs-foot">
            <a className="small" onClick={() => { ctx.onMore(); setOpen(false) }}>都不喜歡？請剪輯師再找幾個台灣腔聲音</a>
            <button className="btn primary small" disabled={!chosen || ctx.disabled || chosen.voice_id === ctx.current}
              onClick={() => { if (chosen) { ctx.onPick(chosen); setOpen(false); setSel(null) } }}>
              {chosen ? (chosen.voice_id === ctx.current ? '這就是目前的聲音' : `用「${chosen.name}」重新配音`) : '先選一個聲音'}
            </button>
          </div>
        </div>)}
    </div>
  )
}

/* Full-screen teleprompter recorder. */
export function Teleprompter({ lines, projectId, onClose, onUploaded }:
  { lines: Line[]; projectId: string; onClose: () => void; onUploaded: (key: string, seconds: number) => void }) {
  const [phase, setPhase] = useState<'ready' | 'count' | 'rec' | 'review' | 'up'>('ready')
  const [count, setCount] = useState(3)
  const [t, setT] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [err, setErr] = useState('')
  const mr = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const t0 = useRef(0)
  const raf = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const total = lines.length ? lines[lines.length - 1].end : 0
  const cur = Math.max(0, lines.findIndex(l => t < l.end) === -1 ? lines.length - 1 : lines.findIndex(l => t < l.end))
  const url = blob ? URL.createObjectURL(blob) : ''
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  useEffect(() => () => { cancelAnimationFrame(raf.current); mr.current?.stream.getTracks().forEach(x => x.stop()) }, [])
  useEffect(() => { listRef.current?.querySelector('.tp-line.on')?.scrollIntoView({ block: 'center', behavior: 'smooth' }) }, [cur, phase])

  const begin = async () => {
    setErr('')
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }) }
    catch { setErr('打不開麥克風。請在網址列允許使用麥克風，再按一次。'); return }
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(x => MediaRecorder.isTypeSupported(x))
    const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    chunks.current = []
    r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data) }
    r.onstop = () => { stream.getTracks().forEach(x => x.stop()); setBlob(new Blob(chunks.current, { type: r.mimeType || 'audio/webm' })); setPhase('review') }
    mr.current = r
    setPhase('count'); setCount(3); setT(0)
    let c = 3
    const iv = setInterval(() => {
      c -= 1; setCount(c)
      if (c === 0) {
        clearInterval(iv)
        r.start(250); setPhase('rec'); t0.current = performance.now()
        const tick = () => {
          const s = (performance.now() - t0.current) / 1000
          setT(s)
          if (s >= total + 1.5) { r.state !== 'inactive' && r.stop(); return }
          raf.current = requestAnimationFrame(tick)
        }
        raf.current = requestAnimationFrame(tick)
      }
    }, 800)
  }
  const stop = () => { cancelAnimationFrame(raf.current); if (mr.current && mr.current.state !== 'inactive') mr.current.stop() }
  const upload = async () => {
    if (!blob) return
    setPhase('up'); setErr('')
    try {
      const fd = new FormData(); fd.append('audio', blob, blob.type.includes('mp4') ? 'vo.m4a' : 'vo.webm')
      const r = await fetch(`/api/projects/${projectId}/narration`, { method: 'POST', body: fd })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? '上傳失敗')
      const d = await r.json()
      onUploaded(d.key, d.seconds)
    } catch (e) { setErr((e as Error).message); setPhase('review') }
  }
  void api
  return (
    <div className="tp">
      <div className="tp-top">
        <a className="tp-x" onClick={() => { stop(); onClose() }}>✕</a>
        <span className="tp-title">{phase === 'rec' ? <><i className="tp-dot" />錄音中</> : phase === 'review' ? '聽聽看' : '照稿唸旁白'}</span>
        <span className="tp-time">{tc(Math.min(t, total))} / {tc(total)}</span>
      </div>
      <div className="tp-bar"><i style={{ width: `${Math.min(100, (t / Math.max(total, 0.1)) * 100)}%` }} /></div>
      <div className="tp-lines" ref={listRef}>
        {lines.map((l, i) => (
          <div key={i} className={`tp-line ${phase === 'rec' || phase === 'count' ? (i === cur ? 'on' : i < cur ? 'past' : '') : i === 0 && phase === 'ready' ? 'on' : ''}`}>
            <span className="tp-tc">{tc(l.start)}</span>
            <span className="tp-text">{l.text}</span>
            {phase === 'rec' && i === cur && <span className="tp-fill" style={{ width: `${Math.min(100, ((t - l.start) / Math.max(0.1, l.end - l.start)) * 100)}%` }} />}
          </div>))}
        <div className="tp-pad" />
      </div>
      {phase === 'count' && <div className="tp-count" key={count}>{count || '唸！'}</div>}
      <div className="tp-foot">
        {err && <div className="tp-err">{err}</div>}
        {phase === 'ready' && <>
          <div className="tp-tip">找安靜的地方，手機拿近一點。按下去倒數 3 秒，亮起來的那句就是現在要唸的。</div>
          <button className="tp-btn rec" onClick={begin}><i />開始錄音</button>
        </>}
        {phase === 'count' && <div className="tp-tip">準備…</div>}
        {phase === 'rec' && <button className="tp-btn stop" onClick={stop}><i />唸完了</button>}
        {phase === 'review' && url && <>
          <audio src={url} controls className="tp-audio" />
          <div className="tp-row"><button className="tp-btn ghost" onClick={() => { setBlob(null); setPhase('ready'); setT(0) }}>重錄</button><button className="tp-btn ok" onClick={upload}>用這段當旁白 →</button></div>
        </>}
        {phase === 'up' && <div className="tp-tip"><span className="spinner" /> 上傳中…</div>}
      </div>
    </div>
  )
}
