import { useEffect, useRef, useState } from 'react'
import { api, verLabel, type DeliverableVersion, type ScriptInfo } from './api'
import { RecBar, SheetHead, useRecorder } from './Recorder'
import { IcHome, IcMic, IcPlay, IcStop, IcTimer } from './icons'

/* 我親自一句一句配音: the owner reads the narration one line at a time and the recordings themselves become
   the narration — no AI voice in between (that's the other path, AI 生成我的聲音). One big line at a time,
   record, listen, redo or move on; 套用 re-renders from the recipe with the takes in place. */
type Line = ScriptInfo['lines'][number]
export type Take = { take: string; url: string; secs: number }

export function OwnRead({ projectId, version, onClose, onDone, onUsage, initialTakes, onTakes }:
  { projectId: string; version: DeliverableVersion | null; onClose: () => void; onDone?: () => void; onUsage?: () => void; initialTakes?: Record<string, Take>; onTakes?: (t: Record<string, Take>) => void }) {
  const [lines, setLines] = useState<Line[]>([])
  const [ok, setOk] = useState<boolean | null>(null)
  const [i, setI] = useState(0)
  const [takes, setTakes] = useState<Record<string, Take>>(initialTakes ?? {})
  useEffect(() => { onTakes?.(takes) }, [takes]) // eslint-disable-line react-hooks/exhaustive-deps
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
    const ext = blob.type.includes('wav') ? 'wav' : blob.type.includes('mp4') ? 'm4a' : 'webm'
    try {
      const fd = new FormData(); fd.append('audio', blob, `take.${ext}`); fd.append('n', String(cur.n)); fd.append('mode', 'raw')
      const res = await fetch(`/api/projects/${projectId}/take`, { method: 'POST', body: fd }); const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.detail ?? '處理錄音失敗')
      setTakes(t => ({ ...t, [cur.key!]: { take: d.key, url: d.url, secs: d.seconds } }))
      api.clientLog('take_ok', { n: cur.n, bytes: blob.size, type: blob.type, secs: d.seconds })
      onUsage?.(); playMine(d.url)
    } catch (x) {
      api.clientLog('take_err', { n: cur.n, bytes: blob.size, type: blob.type, error: (x as Error).message })
      setErr((x as Error).message)
    } finally { setBusy(false) }
  }, { onEvent: (name, data) => api.clientLog(`own_${name}`, { n: cur?.n, ...data }) })
  const stopAll = () => { audio.current?.pause(); video.current?.pause(); stopAt.current = null; setPlaying(null) }
  const playOrig = () => { const v = video.current; if (!v || !cur) return; stopAll(); stopAt.current = cur.end + 0.05; v.currentTime = cur.start; v.play().then(() => setPlaying('orig')).catch(() => {}) }
  const onTime = () => { const v = video.current; if (v && stopAt.current !== null && v.currentTime >= stopAt.current) { v.pause(); stopAt.current = null; setPlaying(null) } }
  const playMine = (url: string) => { stopAll(); const a = new Audio(url); audio.current = a; a.onended = () => setPlaying(null); a.play().then(() => setPlaying('mine')).catch(() => {}) }
  const start = async () => { stopAll(); setErr(''); await rec.start() }
  const go = (k: number) => { if (k < 0 || k >= lines.length) return; stopAll(); setI(k) }
  const next = () => go(i + 1)
  const prev = () => go(i - 1)
  // arriving on a line: hear how it sounds right now (your take if you made one, else the current narration)
  const autoOnce = useRef(-1)
  useEffect(() => {
    if (!ok || !cur || autoOnce.current === i || rec.rec) return
    autoOnce.current = i
    const t = setTimeout(() => { const m = takes[cur.key!]; if (m) playMine(m.url); else if (src) playOrig() }, 250)
    return () => clearTimeout(t)
  }, [i, ok]) // eslint-disable-line react-hooks/exhaustive-deps
  const apply = async () => {
    setApplying(true); setErr('')
    api.clientLog('own_apply', { takes: Object.keys(takes).length })
    try { await api.quick(projectId, { lines: Object.entries(takes).map(([key, t]) => ({ key, take: t.take })) }); onUsage?.(); onDone?.(); onClose() }
    catch (x) { const ex = x as Error & { needed?: number }; api.clientLog('own_apply_err', { error: ex.message }); setErr(ex.needed ? '點數不足，先儲值再套用' : ex.message); setApplying(false) }
  }
  const cancel = () => { if (!applying && !rec.rec) onClose() }   // ← 返回 keeps the takes (Chat holds them)
  const mine = cur ? takes[cur.key!] : undefined
  const left = lines.filter(l => !takes[l.key!]).length

  return (
    <div className="pf-scrim" onClick={e => { if (e.target === e.currentTarget) cancel() }}>
      <div className="pf own" role="dialog" aria-label="我親自配音">
        <SheetHead title="我親自配音" badge={version ? verLabel(version.version) : undefined} sub={lines.length ? `第 ${i + 1} 句 / 共 ${lines.length} 句` : undefined} onCancel={cancel} cancelLabel="← 返回"
          right={<button className="btn primary small" disabled={n === 0 || applying || rec.rec} onClick={apply}>{applying ? '輸出中…' : n ? `套用 ${n}` : '套用'}</button>} />
        {src && <video ref={video} src={src} preload="metadata" playsInline onTimeUpdate={onTime} className="own-video" />}
        {ok === null && <div className="muted small tl-msg">載入旁白稿…</div>}
        {ok === false && <div className="muted small tl-msg">這支還沒有可以配音的旁白稿，請先讓剪輯師輸出一次。</div>}
        {ok && cur && (
          <div className="own-body">
            <div className="own-dots" aria-hidden="true">{lines.map((l, k) => <i key={l.n} className={`${k === i ? 'on' : ''} ${takes[l.key!] ? 'done' : ''}`} onClick={() => { stopAll(); setI(k) }} />)}</div>
            <div className={`own-now ${playing ? 'on' : ''}`} aria-live="polite">
              {playing === 'orig' ? <><i className="own-eq"><b /><b /><b /></i>正在播：原本的配音</> : playing === 'mine' ? <><i className="own-eq"><b /><b /><b /></i>正在播：我唸的</> : mine ? '這句已經換成你唸的，可以再聽或重唸' : '到每一句都會先播現在的配音給你聽'}
            </div>
            {n === 0 && !rec.rec
              ? <div className="own-tips" aria-label="收音小技巧"><span><i><IcMic /></i>手機離嘴 20 公分</span><span><i><IcHome /></i>找安靜的地方</span><span><i><IcTimer /></i>唸完停一秒再按</span></div>
              : <div className="own-tip">{mine ? '聽聽看；可以重唸，或往下一句。' : '按下麥克風開始唸，唸完按右邊。'}</div>}
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
                {/* hierarchy: the red record button is the one action; listening is quiet text; moving between lines sits at the bottom */}
                <div className="own-row">
                  {src && <button type="button" className={`own-link ${playing === 'orig' ? 'on' : ''}`} onClick={playing === 'orig' ? stopAll : playOrig}>{playing === 'orig' ? <IcStop size={13} /> : <IcPlay size={13} />}{playing === 'orig' ? '停' : '聽原本的'}</button>}
                  {mine && <button type="button" className={`own-link ${playing === 'mine' ? 'on' : ''}`} onClick={playing === 'mine' ? stopAll : () => playMine(mine.url)}>{playing === 'mine' ? <IcStop size={13} /> : <IcPlay size={13} />}{playing === 'mine' ? '停' : '聽我唸的'}</button>}
                </div>
                <div className="own-nav">
                  <button type="button" className="own-navb" disabled={i === 0} onClick={prev}>‹ 上一句</button>
                  <span className="muted small">{i + 1} / {lines.length}</span>
                  {i < lines.length - 1
                    ? <button type="button" className={`own-navb ${mine ? 'next' : ''}`} onClick={next}>下一句 ›</button>
                    : <span className="muted small own-last">{left ? `還有 ${left} 句沒唸` : '全部唸好了'}</span>}
                </div>
              </div>)}
            {(err || rec.err) && <div className="error small">{err || rec.err}</div>}
          </div>
        )}
        <div className="pf-foot">
          <span className="muted small">{n ? `唸好 ${n} 句${left ? `，還有 ${left} 句` : ''}` : '一句一句唸，影片裡就是你本人的聲音'}</span><span className="spacer" />
          <button className="btn primary" disabled={n === 0 || applying || rec.rec} onClick={apply}>{applying ? '重新輸出中…' : '套用 →'}</button>
        </div>
      </div>
    </div>
  )
}
