import { useEffect, useRef, useState } from 'react'
import { api, type Voice } from './api'

/* Record (or upload) ~45 s of the owner's voice; the backend makes an ElevenLabs instant clone. */
const SCRIPT = [
  '大家好，歡迎來到我們的民宿。這裡離海邊走路只要三分鐘，早上推開窗就是龜山島的海景。',
  '房間有二十五米的戲水池、KTV 和電動麻將，帶毛小孩也沒問題。',
  '平日每人一千五百元，含早餐。想訂房的話，點下方連結查空房，我們在宜蘭等你。',
]
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

export function VoiceCloneDialog({ current, onClose, onDone }: { current?: Voice | null; onClose: () => void; onDone: (v: Voice) => void }) {
  const [mode, setMode] = useState<'rec' | 'file'>('rec')
  const [rec, setRec] = useState(false)
  const [secs, setSecs] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [fileName, setFileName] = useState('')
  const [name, setName] = useState(current?.name && current.name !== '我的聲音' ? current.name : '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const mr = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<number | null>(null)
  const url = blob ? URL.createObjectURL(blob) : ''
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  useEffect(() => () => { mr.current?.stream.getTracks().forEach(t => t.stop()); if (timer.current) clearInterval(timer.current) }, [])

  const start = async () => {
    setErr(''); setBlob(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t))
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
      chunks.current = []
      r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data) }
      r.onstop = () => { setBlob(new Blob(chunks.current, { type: r.mimeType || 'audio/webm' })); stream.getTracks().forEach(t => t.stop()) }
      r.start(250); mr.current = r; setRec(true); setSecs(0)
      timer.current = window.setInterval(() => setSecs(s => s + 1), 1000)
    } catch { setErr('打不開麥克風。請允許瀏覽器使用麥克風，或改用「上傳檔案」。') }
  }
  const stop = () => { mr.current?.stop(); setRec(false); if (timer.current) clearInterval(timer.current) }
  const submit = async () => {
    if (!blob) return
    setBusy(true); setErr('')
    try {
      const fd = new FormData()
      const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('mpeg') ? 'mp3' : blob.type.includes('wav') ? 'wav' : 'webm'
      fd.append('file', blob, fileName || `voice.${ext}`)
      fd.append('name', name.trim() || '我的聲音')
      const r = await api.cloneVoice(fd)
      onDone(r.voice)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal card vc" onClick={e => e.stopPropagation()}>
        <div className="modal-head"><h3>{current ? '重新錄製我的聲音' : '用自己的聲音配音'}</h3><a onClick={onClose}>✕</a></div>
        <p className="muted small">錄 30 到 60 秒，找安靜的地方、用平常講話的語氣念下面這段。之後旁白就會是你的聲音，風格可以在對話裡調整。</p>
        <div className="tabs vc-tabs">
          <a className={mode === 'rec' ? 'active' : ''} onClick={() => setMode('rec')}>直接錄</a>
          <a className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}>上傳檔案</a>
        </div>
        {mode === 'rec' && (
          <>
            <div className="vc-script">{SCRIPT.map((l, i) => <p key={i}>{l}</p>)}</div>
            <div className="vc-rec">
              {!rec
                ? <button className={`btn ${blob ? '' : 'primary'} vc-btn`} onClick={start}><i className="vc-dot" />{blob ? '重錄' : '開始錄音'}</button>
                : <button className="btn vc-btn live" onClick={stop}><i className="vc-dot" />停止 · {fmt(secs)}</button>}
              {rec && <span className={`muted small ${secs < 30 ? '' : 'ok'}`}>{secs < 30 ? `再錄 ${30 - secs} 秒以上更像` : '長度夠了，念完可以停'}</span>}
            </div>
          </>
        )}
        {mode === 'file' && (
          <label className="dz compact">
            <span className="dz-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5a4 4 0 0 0 4 4zm7-4a7 7 0 0 1-14 0M12 18v3" /></svg></span>
            <span className="dz-text"><b>{fileName || '選一段你說話的錄音'}</b><span className="muted small">30 秒以上，MP3 / M4A / WAV，或手機錄的影片也可以</span></span>
            <input type="file" accept="audio/*,video/mp4,.m4a,.mp3,.wav,.webm,.mov" hidden onChange={e => { const f = e.target.files?.[0]; if (f) { setBlob(f); setFileName(f.name) } }} />
          </label>
        )}
        {blob && <audio className="vc-preview" src={url} controls />}
        <label className="field">聲音名稱（選填）<input placeholder="例如：老闆娘、阿明" value={name} onChange={e => setName(e.target.value)} maxLength={40} /></label>
        {err && <div className="error">{err}</div>}
        <button className="btn primary block" disabled={!blob || busy || rec} onClick={submit}>{busy ? '建立中，約 20 秒…' : '建立我的聲音'}</button>
        <div className="muted small">只會用在你自己專案的旁白，隨時可以在聲音選單裡重錄或刪除。</div>
      </div>
    </div>
  )
}
