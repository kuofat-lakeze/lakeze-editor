import { useEffect, useRef, useState } from 'react'

/* One microphone recorder for the whole app (voice clone, 我唸這句, the teleprompter). While it runs the
   level meter moves with the voice, the dot pulses and the clock counts, so "am I recording?" is never
   a question. getUserMedia errors come back as a plain sentence. */
export type Recorder = {
  rec: boolean; secs: number; level: number; err: string
  start: () => Promise<boolean>; stop: () => void
}
const MIME = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']

export function useRecorder(onStop: (blob: Blob) => void): Recorder {
  const [rec, setRec] = useState(false)
  const [secs, setSecs] = useState(0)
  const [level, setLevel] = useState(0)
  const [err, setErr] = useState('')
  const mr = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<number | null>(null)
  const raf = useRef(0)
  const ac = useRef<AudioContext | null>(null)
  const cb = useRef(onStop); cb.current = onStop
  const cleanup = () => {
    cancelAnimationFrame(raf.current)
    if (timer.current) { clearInterval(timer.current); timer.current = null }
    mr.current?.stream.getTracks().forEach(t => t.stop())
    ac.current?.close().catch(() => {}); ac.current = null
    setLevel(0)
  }
  useEffect(() => cleanup, [])
  const start = async () => {
    setErr('')
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }) }
    catch { setErr('打不開麥克風。請在網址列允許使用麥克風，再按一次。'); return false }
    const type = MIME.find(t => MediaRecorder.isTypeSupported(t))
    const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    chunks.current = []
    r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data) }
    r.onstop = () => { const b = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' }); cleanup(); setRec(false); cb.current(b) }
    // level meter: an analyser on the same stream
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const c = new Ctx(); ac.current = c
      const an = c.createAnalyser(); an.fftSize = 512
      c.createMediaStreamSource(stream).connect(an)
      const buf = new Uint8Array(an.frequencyBinCount)
      const tick = () => { an.getByteTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v - 128)); setLevel(Math.min(1, p / 70)); raf.current = requestAnimationFrame(tick) }
      raf.current = requestAnimationFrame(tick)
    } catch { /* no meter, recording still works */ }
    r.start(250); mr.current = r; setRec(true); setSecs(0)
    timer.current = window.setInterval(() => setSecs(s => s + 1), 1000)
    return true
  }
  const stop = () => { if (mr.current && mr.current.state !== 'inactive') mr.current.stop() }
  return { rec, secs, level, err, start, stop }
}

export const fmtSecs = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/** The live recording strip: pulsing dot, clock, level bars, and the one button that ends the take. */
export function RecBar({ r, label = '錄音中', stopLabel = '唸完了', hint, onStop }: { r: Recorder; label?: string; stopLabel?: string; hint?: string; onStop?: () => void }) {
  const bars = 14
  return (
    <div className="recbar" role="status" aria-live="polite">
      <span className="recbar-dot" aria-hidden="true" />
      <span className="recbar-lab"><b>{label}</b><em>{fmtSecs(r.secs)}</em></span>
      <span className="recbar-meter" aria-hidden="true">
        {Array.from({ length: bars }, (_, i) => <i key={i} className={r.level * bars > i ? 'on' : ''} style={{ height: `${30 + (i % 3) * 20}%` }} />)}
      </span>
      {hint && <small className="recbar-hint">{hint}</small>}
      <button type="button" className="recbar-stop" onClick={onStop ?? r.stop}><i aria-hidden="true" />{stopLabel}</button>
    </div>
  )
}

/** iOS-style sheet header: 取消／返回 at the left, the title centred, the one primary action at the right. */
export function SheetHead({ title, sub, badge, onCancel, cancelLabel = '取消', right, children }:
  { title: string; sub?: string; badge?: string; onCancel: () => void; cancelLabel?: string; right?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="shead">
      <a className="shead-l" onClick={onCancel}>{cancelLabel}</a>
      <div className="shead-c"><b>{title}{badge && <span className="pf-ver">{badge}</span>}</b>{sub && <small>{sub}</small>}</div>
      <div className="shead-r">{right}</div>
      {children}
    </div>
  )
}
