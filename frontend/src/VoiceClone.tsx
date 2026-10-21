import { useEffect, useState } from 'react'
import { api, type Voice } from './api'
import { RecBar, SheetHead, useRecorder } from './Recorder'

/* Record (or upload) ~45 s of the owner's voice; the backend makes an ElevenLabs instant clone. */
const SCRIPT = [
  '大家好，歡迎來到我們的民宿。這裡離海邊走路只要三分鐘，早上推開窗就是龜山島的海景。',
  '房間有二十五米的戲水池、KTV 和電動麻將，帶毛小孩也沒問題。',
  '平日每人一千五百元，含早餐。想訂房的話，點下方連結查空房，我們在宜蘭等你。',
]

export function VoiceCloneDialog({ current, onClose, onDone }: { current?: Voice | null; onClose: () => void; onDone: (v: Voice) => void }) {
  const [mode, setMode] = useState<'rec' | 'file'>('rec')
  const [blob, setBlob] = useState<Blob | null>(null)
  const [fileName, setFileName] = useState('')
  const [name, setName] = useState(current?.name && current.name !== '我的聲音' ? current.name : '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const r = useRecorder(b => setBlob(b))
  const rec = r.rec, secs = r.secs
  const url = blob ? URL.createObjectURL(blob) : ''
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  const start = async () => { setErr(''); setBlob(null); await r.start() }
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
    <div className="modal-bg" onClick={() => !rec && onClose()}>
      <div className="modal card vc" onClick={e => e.stopPropagation()}>
        <SheetHead title={current ? '重新讓 AI 學我的聲音' : 'AI 生成我的聲音'} onCancel={() => { r.stop(); onClose() }}
          right={<button className="btn primary small" disabled={!blob || busy || rec} onClick={submit}>{busy ? '建立中…' : '建立'}</button>} />
        <p className="muted small">找安靜的地方，錄 30 到 60 秒。AI 會學你的聲音來配旁白；你用什麼語氣唸，學到的聲音就是那個個性。</p>
        <div className="tabs vc-tabs">
          <a className={mode === 'rec' ? 'active' : ''} onClick={() => setMode('rec')}>直接錄</a>
          <a className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}>上傳檔案</a>
        </div>
        {mode === 'rec' && (
          <>
            <div className="vc-moods" aria-label="語氣會變成聲音的個性">
              <span><i>😊</i><b>開心唸</b><small>聲音就開朗</small></span>
              <span><i>😌</i><b>沉穩唸</b><small>聲音就沉穩</small></span>
              <span><i>🙂</i><b>自然唸</b><small>聲音就自然</small></span>
            </div>
            <div className="vc-script">
              <div className="muted small vc-script-h">像平常講話一樣，照自己的速度唸完就好，不用跟節奏。</div>
              {SCRIPT.map((l, i) => <p key={i}>{l}</p>)}
            </div>
            {rec ? <RecBar r={r} label="錄音中" stopLabel={secs < 30 ? `再 ${30 - secs} 秒` : '錄好了'} hint={secs < 30 ? '至少 30 秒更像你' : '長度夠了，念完可以停'} />
              : <div className="vc-rec"><button className={`btn ${blob ? '' : 'primary'} vc-btn`} onClick={start}><i className="vc-dot" />{blob ? '重錄' : '開始錄音'}</button>{blob && <span className="muted small ok">錄好了，聽一下再建立</span>}</div>}
            {r.err && <div className="error">{r.err}</div>}
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
        <button className="btn primary block" disabled={!blob || busy || rec} onClick={submit}>{busy ? '建立中，約 20 秒…' : '讓 AI 學這個聲音'}</button>
        <div className="muted small">只會用在你自己專案的旁白，隨時可以在聲音選單裡重錄或刪除。</div>
      </div>
    </div>
  )
}
