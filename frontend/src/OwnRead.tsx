import { useEffect, useRef, useState } from 'react'
import { api, verLabel, type DeliverableVersion, type ScriptInfo } from './api'
import { RecBar, SheetHead, useRecorder } from './Recorder'
import { ask } from './Dialog'

/* 我親自一句一句配音: the owner reads the narration one line at a time and the recordings themselves become
   the narration — no AI voice in between (that's the other path, AI 生成我的聲音). One big line at a time,
   record, listen, redo or move on; 套用 re-renders from the recipe with the takes in place. */
type Line = ScriptInfo['lines'][number]
type Take = { take: string; url: string; secs: number }

export function OwnRead({ projectId, version, onClose, onDone, onUsage }:
  { projectId: string; version: DeliverableVersion | null; onClose: () => void; onDone?: () => void; onUsage?: () => void }) {
  const [lines, setLines] = useState<Line[]>([])
  const [ok, setOk] = useState<boolean | null>(null)
  const [i, setI] = useState(0)
  const [takes, setTakes] = useState<Record<string, Take>>({})
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [err, setErr] = useState('')
  const [playing, setPlaying] = useState<'orig' | 'mine' | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const stopAt = useRef<number | null>(null)
  const src = version?.videos.find(v => v.role === 'preview')?.url ?? version?.main?.url ?? null
  useEffect(() => { api.script(projectId).then(r => { setLines(r.lines.filter(l => l.key)); setOk(!!r.quick && r.lines.some(l => l.key)) }).catch(() => setOk(false)) }, [projectId])
  useEffect(() => () => { audio.current?.pause() }, [])
  const cur = lines[i]
  const n = Object.keys(takes).length

  const rec = useRecorder(async blob => {
    if (!cur) return
    setBusy(true); setErr('')
    try {
      const fd = new FormData(); fd.append('audio', blob, blob.type.includes('mp4') ? 'take.m4a' : 'take.webm'); fd.append('n', String(cur.n)); fd.append('mode', 'raw')
      const res = await fetch(`/api/projects/${projectId}/take`, { method: 'POST', body: fd }); const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.detail ?? '處理錄音失敗')
      setTakes(t => ({ ...t, [cur.key!]: { take: d.key, url: d.url, secs: d.seconds } }))
      onUsage?.(); playMine(d.url)
    } catch (x) { setErr((x as Error).message) } finally { setBusy(false) }
  })
  const stopAll = () => { audio.current?.pause(); video.current?.pause(); stopAt.current = null; setPlaying(null) }
  const playOrig = () => { const v = video.current; if (!v || !cur) return; stopAll(); stopAt.current = cur.end + 0.05; v.currentTime = cur.start; v.play().then(() => setPlaying('orig')).catch(() => {}) }
  const onTime = () => { const v = video.current; if (v && stopAt.current !== null && v.currentTime >= stopAt.current) { v.pause(); stopAt.current = null; setPlaying(null) } }
  const playMine = (url: string) => { stopAll(); const a = new Audio(url); audio.current = a; a.onended = () => setPlaying(null); a.play().then(() => setPlaying('mine')).catch(() => {}) }
  const start = async () => { stopAll(); setErr(''); await rec.start() }
  const next = () => { if (i < lines.length - 1) setI(i + 1) }
  const apply = async () => {
    setApplying(true); setErr('')
    try { await api.quick(projectId, { lines: Object.entries(takes).map(([key, t]) => ({ key, take: t.take })) }); onUsage?.(); onDone?.(); onClose() }
    catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? '點數不足，先儲值再套用' : ex.message); setApplying(false) }
  }
  const cancel = async () => { if (applying || rec.rec) return; if (n === 0 || await ask.confirm('放棄已經唸好的句子？', { ok: '放棄', danger: true })) onClose() }
  const mine = cur ? takes[cur.key!] : undefined
  const left = lines.filter(l => !takes[l.key!]).length

  return (
    <div className="pf-scrim" onClick={e => { if (e.target === e.currentTarget) cancel() }}>
      <div className="pf own" role="dialog" aria-label="我親自配音">
        <SheetHead title="我親自配音" badge={version ? verLabel(version.version) : undefined} sub={lines.length ? `第 ${i + 1} 句 / 共 ${lines.length} 句` : undefined} onCancel={cancel}
          right={<button className="btn primary small" disabled={n === 0 || applying || rec.rec} onClick={apply}>{applying ? '輸出中…' : n ? `套用 ${n}` : '套用'}</button>} />
        {src && <video ref={video} src={src} preload="metadata" playsInline onTimeUpdate={onTime} className="own-video" />}
        {ok === null && <div className="muted small tl-msg">載入旁白稿…</div>}
        {ok === false && <div className="muted small tl-msg">這支還沒有可以配音的旁白稿，請先讓剪輯師輸出一次。</div>}
        {ok && cur && (
          <div className="own-body">
            <div className="own-dots" aria-hidden="true">{lines.map((l, k) => <i key={l.n} className={`${k === i ? 'on' : ''} ${takes[l.key!] ? 'done' : ''}`} onClick={() => { stopAll(); setI(k) }} />)}</div>
            <div className="own-tip">{i === 0 && n === 0 ? '手機拿近一點，用平常講話的語氣，照著唸這一句就好。' : mine ? '唸好了，聽聽看；可以重唸，或直接下一句。' : '按下麥克風開始唸，唸完按右邊。'}</div>
            <div className={`own-line ${rec.rec ? 'live' : ''}`}>
              <span className="own-n">{i + 1}</span>
              <p>{cur.text}</p>
              {mine && <em className="pf-badge take">✓ 已錄 {mine.secs}s</em>}
            </div>
            {rec.rec ? <RecBar r={rec} label="錄音中" stopLabel="唸完了" hint="照這一句唸，唸完按這裡" /> : (
              <div className="own-acts">
                <button type="button" className={`own-rec ${mine ? 'again' : ''}`} onClick={start} disabled={busy}>
                  <i aria-hidden="true" />{busy ? '處理中…' : mine ? '重唸這句' : '開始唸這句'}
                </button>
                <div className="own-row">
                  {src && <button type="button" className="pf-tb" onClick={playing === 'orig' ? stopAll : playOrig}><i>▶</i>{playing === 'orig' ? '停' : '聽原本的'}</button>}
                  {mine && <button type="button" className="pf-tb on" onClick={playing === 'mine' ? stopAll : () => playMine(mine.url)}><i>▶</i>{playing === 'mine' ? '停' : '聽我唸的'}</button>}
                  {i < lines.length - 1
                    ? <button type="button" className={`pf-tb ${mine ? 'next' : ''}`} onClick={next}><i>→</i>{mine ? '下一句' : '這句先跳過'}</button>
                    : <span className="muted small own-last">{left ? `還有 ${left} 句沒唸（沒唸的會保留原本的聲音）` : '全部唸好了，按右上「套用」'}</span>}
                </div>
              </div>)}
            {(err || rec.err) && <div className="error small">{err || rec.err}</div>}
          </div>
        )}
        <div className="pf-foot">
          <span className="muted small">{n ? `唸好 ${n} 句${left ? `，還有 ${left} 句` : ''}` : '一句一句唸，影片裡就是你本人的聲音'}</span><span className="spacer" />
          <button className="btn primary" disabled={n === 0 || applying || rec.rec} onClick={apply}>{applying ? '重新輸出中…（約 1–2 分鐘）' : '唸好了，套用 →'}</button>
        </div>
      </div>
    </div>
  )
}
