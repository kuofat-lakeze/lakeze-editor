import { useEffect, useRef, useState } from 'react'

/* One microphone recorder for the whole app (voice clone, 我唸這句, the teleprompter). While it runs the
   level meter moves with the voice, the dot pulses and the clock counts, so "am I recording?" is never
   a question. getUserMedia errors come back as a plain sentence.

   Two capture paths run at once: MediaRecorder (small opus/aac files) and a plain PCM tap on the same
   stream. If MediaRecorder gives nothing back — iOS Safari has done that: no data, or onstop that never
   fires — the PCM tap is encoded as WAV and used instead, so a take is never silently lost. The meter
   also judges the signal: too quiet for a couple of seconds, or clipping, and `hint` says so. */
export type Recorder = {
  rec: boolean; secs: number; level: number; err: string
  hint: '' | 'quiet' | 'loud'
  start: () => Promise<boolean>; stop: () => void
}
export type RecEvent = (name: string, data?: Record<string, unknown>) => void
const MIME = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
const MIN_BYTES = 1500          // anything smaller than this is a header without sound

function wavFromPcm(chunks: Float32Array[], rate: number): Blob {
  const n = chunks.reduce((s, c) => s + c.length, 0)
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true)
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true)
  let o = 44
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) { const s = Math.max(-1, Math.min(1, c[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true) }
  return new Blob([buf], { type: 'audio/wav' })
}

export function useRecorder(onStop: (blob: Blob) => void, opts: { onEvent?: RecEvent } = {}): Recorder {
  const [rec, setRec] = useState(false)
  const [secs, setSecs] = useState(0)
  const [level, setLevel] = useState(0)
  const [hint, setHint] = useState<Recorder['hint']>('')
  const [err, setErr] = useState('')
  const mr = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const pcm = useRef<Float32Array[]>([])
  const rate = useRef(48000)
  const peak = useRef(0)
  const timer = useRef<number | null>(null)
  const watchdog = useRef<number | null>(null)
  const raf = useRef(0)
  const ac = useRef<AudioContext | null>(null)
  const proc = useRef<ScriptProcessorNode | null>(null)
  const done = useRef(true)
  const t0 = useRef(0)
  const cb = useRef(onStop); cb.current = onStop
  const ev = useRef(opts.onEvent); ev.current = opts.onEvent
  const cleanup = () => {
    cancelAnimationFrame(raf.current)
    if (timer.current) { clearInterval(timer.current); timer.current = null }
    if (watchdog.current) { clearTimeout(watchdog.current); watchdog.current = null }
    try { proc.current?.disconnect() } catch { /* already gone */ }
    proc.current = null
    stream.current?.getTracks().forEach(t => t.stop()); stream.current = null
    ac.current?.close().catch(() => {}); ac.current = null
    setLevel(0); setHint('')
  }
  useEffect(() => cleanup, [])

  const finish = (blob: Blob | null, how: string) => {
    if (done.current) return
    done.current = true
    const secsNow = (Date.now() - t0.current) / 1000
    let out = blob
    if (!out || out.size < MIN_BYTES) {           // MediaRecorder gave nothing usable: fall back to the PCM tap
      out = pcm.current.length ? wavFromPcm(pcm.current, rate.current) : null
      how = out ? `${how}→wav` : `${how}→empty`
    }
    ev.current?.('rec_stop', { how, bytes: out?.size ?? 0, type: out?.type ?? '', secs: Math.round(secsNow * 10) / 10 })
    cleanup(); setRec(false)
    if (out) cb.current(out)
    else setErr('沒有收到聲音。請確認麥克風沒有被其他 App 占用，再唸一次。')
  }

  const start = async () => {
    setErr(''); setHint('')
    let s: MediaStream
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 } })
    } catch (x) {
      ev.current?.('rec_err', { stage: 'getUserMedia', error: String((x as Error)?.name || x) })
      setErr('打不開麥克風。請在網址列允許使用麥克風，再按一次。'); return false
    }
    stream.current = s
    chunks.current = []; pcm.current = []; peak.current = 0; done.current = false; t0.current = Date.now()
    // the PCM tap + level meter on the same stream (a muted gain keeps the mic from playing back)
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const c = new Ctx(); ac.current = c; rate.current = c.sampleRate
      if (c.state === 'suspended') c.resume().catch(() => {})
      const src = c.createMediaStreamSource(s)
      const p = c.createScriptProcessor(4096, 1, 1); proc.current = p
      const mute = c.createGain(); mute.gain.value = 0
      p.onaudioprocess = e => {
        const d = e.inputBuffer.getChannelData(0)
        pcm.current.push(new Float32Array(d))
        let pk = 0; for (let i = 0; i < d.length; i += 4) { const a = Math.abs(d[i]); if (a > pk) pk = a }
        peak.current = pk
      }
      src.connect(p); p.connect(mute); mute.connect(c.destination)
      let quietSince = 0, loud = 0
      const tick = () => {
        const pk = peak.current
        setLevel(Math.min(1, pk * 1.6))
        const now = Date.now()
        if (pk < 0.02) { if (!quietSince) quietSince = now } else quietSince = 0
        if (pk > 0.985) loud++
        const elapsed = now - t0.current
        setHint(pk > 0.985 || loud > 6 ? 'loud' : quietSince && now - quietSince > 2000 && elapsed > 2500 ? 'quiet' : '')
        if (loud > 6 && pk < 0.9) loud = Math.max(0, loud - 1)
        raf.current = requestAnimationFrame(tick)
      }
      raf.current = requestAnimationFrame(tick)
    } catch (x) { ev.current?.('rec_err', { stage: 'audiocontext', error: String((x as Error)?.message || x) }) }
    // MediaRecorder when the browser has one; otherwise the PCM tap alone carries the take
    const type = MIME.find(t => { try { return MediaRecorder.isTypeSupported(t) } catch { return false } })
    try {
      const r = new MediaRecorder(s, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 128000 })
      r.ondataavailable = e => { if (e.data && e.data.size) chunks.current.push(e.data) }
      r.onstop = () => finish(new Blob(chunks.current, { type: r.mimeType || type || 'audio/webm' }), 'mr')
      r.onerror = () => finish(null, 'mr-error')
      r.start(250); mr.current = r
    } catch (x) {
      mr.current = null
      ev.current?.('rec_err', { stage: 'mediarecorder', error: String((x as Error)?.message || x), type })
    }
    ev.current?.('rec_start', { type: mr.current ? type || 'default' : 'pcm-only', rate: rate.current })
    setRec(true); setSecs(0)
    timer.current = window.setInterval(() => setSecs(x => x + 1), 1000)
    return true
  }
  const stop = () => {
    const r = mr.current
    if (!r) { finish(null, 'pcm'); return }
    if (r.state === 'inactive') { finish(new Blob(chunks.current, { type: r.mimeType }), 'mr-inactive'); return }
    try { r.requestData() } catch { /* some browsers refuse while recording; onstop still delivers */ }
    try { r.stop() } catch { finish(null, 'mr-stop-threw'); return }
    // onstop has 1.5 s to arrive; after that the PCM tap is used so the take is not lost
    watchdog.current = window.setTimeout(() => finish(null, 'mr-timeout'), 1500)
  }
  return { rec, secs, level, err, hint, start, stop }
}

export const fmtSecs = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/** The live recording strip: pulsing dot, clock, level bars, and the one button that ends the take.
    While the signal is too quiet or clipping the hint says what to do, in place of the normal one. */
export function RecBar({ r, label = '錄音中', stopLabel = '唸完了', hint, onStop }: { r: Recorder; label?: string; stopLabel?: string; hint?: string; onStop?: () => void }) {
  const bars = 14
  const live = r.hint === 'quiet' ? '聽不太到，手機靠近嘴巴一點' : r.hint === 'loud' ? '太大聲了，拿遠一點' : ''
  return (
    <div className={`recbar ${r.hint ? 'warn' : ''}`} role="status" aria-live="polite">
      <span className="recbar-dot" aria-hidden="true" />
      <span className="recbar-lab"><b>{label}</b><em>{fmtSecs(r.secs)}</em></span>
      <span className="recbar-meter" aria-hidden="true">
        {Array.from({ length: bars }, (_, i) => <i key={i} className={r.level * bars > i ? 'on' : ''} style={{ height: `${30 + (i % 3) * 20}%` }} />)}
      </span>
      {(live || hint) && <small className={`recbar-hint ${live ? 'live' : ''}`}>{live || hint}</small>}
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
