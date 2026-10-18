import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type DeliverableVersion } from './api'
import type { Line } from './Script'

/* 校對台 (導演模式): the finished video and its narration side by side. The playing line lights up,
   tapping a line seeks the video. A line opens into two fields — 字幕 (what is shown) and 唸法 (what
   the voice reads: homophones to dodge a mispronunciation) — plus ⭐ 重點 and ✕ 刪掉. The edits are
   sent to the editor as one 校對結果 message; only the changed lines are re-voiced. */
type Edit = { text?: string; say?: string; star?: boolean; drop?: boolean; take?: string }   // take: VO key of the owner's own reading
type Shot = { i: number; clip: number; start: number; dur: number; at: number }
const STAR_MAX = 3
const tc = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function Proof({ projectId, version, lines: given, onClose, onSend, onUsage }:
  { projectId: string; version: DeliverableVersion | null; lines?: Line[]; onClose: () => void; onSend: (text: string) => void; onUsage?: () => void }) {
  const [lines, setLines] = useState<Line[]>(given ?? [])
  const [voiceId, setVoiceId] = useState('')
  const [shots, setShots] = useState<Shot[]>([])
  const [rec, setRec] = useState<{ i: number; phase: 'rec' | 'up' | 'done'; url?: string } | null>(null)   // 我唸這句
  const mr = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const [sayPts, setSayPts] = useState(1)
  const [loading, setLoading] = useState(!given)
  const [edits, setEdits] = useState<Record<number, Edit>>({})
  const [open, setOpen] = useState<number | null>(null)
  const [cur, setCur] = useState(-1)
  const [saying, setSaying] = useState<number | null>(null)
  const [err, setErr] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    api.script(projectId).then(r => { if (!given?.length) setLines(r.lines); setVoiceId(r.voice_id); setSayPts(r.say_points); setShots(r.shots ?? []) }).catch(() => {}).finally(() => setLoading(false))
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  const total = useMemo(() => Math.max(lines[lines.length - 1]?.end ?? 0, shots.length ? shots[shots.length - 1].at + shots[shots.length - 1].dur : 0, video.current?.duration || 0), [lines, shots, cur])
  const now = video.current?.currentTime ?? 0
  const curShot = shots.findIndex(sh => now >= sh.at && now < sh.at + sh.dur)
  const src = version?.videos.find(v => v.role === 'preview')?.url ?? version?.main?.url ?? null

  // follow playback: the line whose window contains the current time
  const onTime = () => {
    const t = video.current?.currentTime ?? 0
    const i = lines.findIndex(l => t >= l.start && t < l.end)
    if (i !== cur) {
      setCur(i)
      if (i >= 0 && listRef.current) listRef.current.children[i]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }
  const seek = (t: number) => { if (video.current) { video.current.currentTime = t; video.current.play().catch(() => {}) } }
  const ed = (i: number) => edits[i] ?? {}
  const patch = (i: number, p: Edit) => setEdits(m => {
    const next = { ...(m[i] ?? {}), ...p }
    const l = lines[i]
    if (next.text !== undefined && next.text.trim() === l.text) delete next.text   // back to the original = no edit
    if (next.say !== undefined && (!next.say.trim() || next.say.trim() === (next.text ?? l.text))) delete next.say
    if (!next.star) delete next.star
    if (!next.drop) delete next.drop
    if (!next.take) delete next.take
    const c = { ...m }; if (Object.keys(next).length) c[i] = next; else delete c[i]; return c
  })
  const stars = Object.values(edits).filter(e => e.star).length
  const changed = Object.keys(edits).length

  const say = async (i: number) => {
    const l = lines[i]; const e = ed(i)
    const text = (e.say ?? e.text ?? l.text).trim()
    if (!text || saying !== null) return
    setSaying(i); setErr('')
    try {
      video.current?.pause()
      const r = await api.say(projectId, text, voiceId)
      onUsage?.()
      audio.current?.pause()
      const a = new Audio(r.url); audio.current = a
      a.onended = () => setSaying(null)
      await a.play()
    } catch (x) {
      const ex = x as Error & { needed?: number }
      setErr(ex.needed ? `點數不足：試聽要 ${ex.needed} 點` : ex.message); setSaying(null)
    }
  }
  useEffect(() => () => { audio.current?.pause(); mr.current?.stream.getTracks().forEach(t => t.stop()) }, [])

  // 我唸這句: record the line, speech-to-speech turns it into the video's voice (pronunciation stays mine)
  const takeStart = async (i: number) => {
    setErr('')
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }) }
    catch { setErr('打不開麥克風。請在網址列允許使用麥克風，再按一次。'); return }
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(x => MediaRecorder.isTypeSupported(x))
    const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    chunks.current = []
    r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data) }
    r.onstop = async () => {
      stream.getTracks().forEach(x => x.stop())
      const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' })
      setRec({ i, phase: 'up' })
      try {
        const fd = new FormData(); fd.append('audio', blob, blob.type.includes('mp4') ? 'take.m4a' : 'take.webm'); fd.append('n', String(i + 1)); fd.append('voice_id', voiceId)
        const res = await fetch(`/api/projects/${projectId}/take`, { method: 'POST', body: fd })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) throw Object.assign(new Error(d.detail ?? '轉換失敗'), { needed: d.needed })
        onUsage?.()
        patch(i, { take: d.key })
        setRec({ i, phase: 'done', url: d.url })
        audio.current?.pause(); const a = new Audio(d.url); audio.current = a; a.play().catch(() => {})
      } catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? `點數不足：需要 ${ex.needed} 點` : ex.message); setRec(null) }
    }
    mr.current = r; r.start(250); video.current?.pause(); setRec({ i, phase: 'rec' })
  }
  const takeStop = () => { if (mr.current && mr.current.state !== 'inactive') mr.current.stop() }

  const message = () => {
    const out: string[] = ['校對結果，請照著修改後重新輸出（只重配有改的句子，其他句子的音檔沿用）：']
    lines.forEach((l, i) => {
      const e = edits[i]; if (!e) return
      const bits: string[] = []
      if (e.drop) bits.push('刪掉這句，畫面用其他素材補')
      else if (e.take) {
        bits.push(`用我唸的版本（key ${e.take}，已轉成影片的聲音），這句不要再生成配音`)
        if (e.text !== undefined) bits.push(`字幕改成「${e.text.trim()}」`)
        if (e.star) bits.push('這句是重點：字幕放大、鏡頭多停 1–2 秒')
      } else {
        if (e.text !== undefined) bits.push(`字幕改成「${e.text.trim()}」`)
        if (e.say !== undefined) bits.push(`唸法用「${e.say.trim()}」（字幕仍顯示${e.text !== undefined ? '上面那句' : '原句'}）`)
        if (e.star) bits.push('這句是重點：字幕放大、鏡頭多停 1–2 秒')
      }
      out.push(`- 第 ${i + 1} 句（${tc(l.start)} 「${l.text}」）：${bits.join('；')}`)
    })
    return out.join('\n')
  }

  return (
    <div className="pf-scrim" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="pf" role="dialog" aria-label="校對台">
        <div className="pf-head">
          <b>校對台</b>{version && <span className="pf-ver">v{version.version}</span>}
          <span className="muted small">播放時那句會亮起 · 點一句跳到那秒 · 點「⋯」改字</span>
          <a className="pf-x" onClick={onClose} aria-label="關閉">✕</a>
        </div>
        <div className="pf-body">
          <div className="pf-video">
            {src ? <video ref={video} src={src} controls playsInline preload="metadata" poster={version?.poster ?? undefined} onTimeUpdate={onTime} onLoadedMetadata={onTime} />
              : <div className="pf-novideo muted small">這一版沒有影片檔，只能校對文字。</div>}
            {shots.length > 0 && total > 0 && (
              <div className="pf-shots" aria-label="分鏡">
                {shots.map(sh => (
                  <a key={sh.i} className={`pf-shot ${sh.i === curShot ? 'on' : ''}`} style={{ width: `${(sh.dur / total) * 100}%` }} onClick={() => seek(sh.at)} title={`第 ${sh.i + 1} 段 · 素材 #${String(sh.clip).padStart(2, '0')} · ${sh.dur.toFixed(1)} 秒`}>
                    <img src={api.frameUrl(projectId, sh.clip, sh.start)} alt="" loading="lazy" /><i>#{String(sh.clip).padStart(2, '0')}</i>
                  </a>))}
              </div>
            )}
            {lines.length > 0 && total > 0 && (
              <div className="pf-tl" aria-hidden="true">
                {lines.map((l, i) => (
                  <i key={i} className={`${i === cur ? 'on' : ''} ${ed(i).drop ? 'drop' : ''} ${ed(i).star ? 'star' : ''}`}
                    style={{ left: `${(l.start / total) * 100}%`, width: `${Math.max(0.8, ((l.end - l.start) / total) * 100)}%` }} onClick={() => seek(l.start)} />))}
                {video.current && <b className="pf-cursor" style={{ left: `${((video.current.currentTime || 0) / total) * 100}%` }} />}
              </div>
            )}
          </div>
          <ol className="pf-lines" ref={listRef}>
            {loading && <li className="muted small pf-empty">載入旁白稿…</li>}
            {!loading && lines.length === 0 && <li className="muted small pf-empty">找不到這支的旁白稿。剪輯師交付時會附旁白稿，之後再來校對。</li>}
            {lines.map((l, i) => {
              const e = ed(i); const isOpen = open === i
              const shown = e.text ?? l.text
              return (
                <li key={i} className={`pf-line ${i === cur ? 'on' : ''} ${e.drop ? 'drop' : ''} ${e.star ? 'star' : ''} ${isOpen ? 'open' : ''}`}>
                  <div className="pf-row" onClick={() => seek(l.start)}>
                    <span className="pf-n">{i + 1}</span>
                    <span className="pf-tc">{tc(l.start)}</span>
                    <span className="pf-text">
                      {e.star && <em className="pf-badge star">重點</em>}{e.drop && <em className="pf-badge drop">刪掉</em>}
                      {e.text !== undefined && !e.drop && <em className="pf-badge ed">已改</em>}{e.say !== undefined && !e.drop && <em className="pf-badge say">唸法</em>}{e.take && !e.drop && <em className="pf-badge take">我唸的</em>}
                      {shown}
                    </span>
                    <a className="pf-more" onClick={ev => { ev.stopPropagation(); setOpen(isOpen ? null : i) }} aria-label="改這句">{isOpen ? '收合' : '⋯'}</a>
                  </div>
                  {isOpen && (
                    <div className="pf-edit">
                      <label><span>字幕怎麼寫</span><input value={shown} onChange={ev => patch(i, { text: ev.target.value })} disabled={!!e.drop} /></label>
                      <label><span>怎麼唸<small>唸錯字時，用同音字寫給配音看；字幕不受影響</small></span>
                        <div className="pf-say">
                          <input value={e.say ?? ''} placeholder={shown} onChange={ev => patch(i, { say: ev.target.value })} disabled={!!e.drop} />
                          <button type="button" className="btn small" disabled={saying !== null || !!e.drop} onClick={() => say(i)}>{saying === i ? '播放中…' : `▶ 試聽這句 · ${sayPts} 點`}</button>
                        </div>
                      </label>
                      <div className="pf-take">
                        <span>還是唸錯？<small>自己唸這一整句（3–5 秒），配音會用影片的聲音照你的唸法再念一次</small></span>
                        {rec?.i === i && rec.phase === 'rec' ? <button type="button" className="btn small danger" onClick={takeStop}>■ 唸完了</button>
                          : rec?.i === i && rec.phase === 'up' ? <button type="button" className="btn small" disabled>轉換中…</button>
                          : <button type="button" className="btn small" disabled={!!e.drop || (rec !== null && rec.phase !== 'done')} onClick={() => takeStart(i)}>🎙 {e.take ? '再唸一次' : `我唸這句 · ${sayPts} 點`}</button>}
                        {e.take && rec?.i === i && rec.url && <a className="small" onClick={() => { audio.current?.pause(); const a = new Audio(rec.url!); audio.current = a; a.play().catch(() => {}) }}>▶ 聽結果</a>}
                        {e.take && <a className="small muted" onClick={() => { patch(i, { take: undefined }); setRec(null) }}>不用我唸的</a>}
                      </div>
                      <div className="pf-acts">
                        <button type="button" className={`btn small ${e.star ? 'primary' : ''}`} disabled={!e.star && stars >= STAR_MAX || !!e.drop} onClick={() => patch(i, { star: !e.star })}>⭐ {e.star ? '取消重點' : stars >= STAR_MAX ? `重點最多 ${STAR_MAX} 句` : '這句是重點'}</button>
                        <button type="button" className={`btn small ${e.drop ? 'primary' : ''}`} onClick={() => patch(i, { drop: !e.drop })}>✕ {e.drop ? '這句還是要' : '刪掉這句'}</button>
                        {edits[i] && <a className="small muted" onClick={() => setEdits(m => { const c = { ...m }; delete c[i]; return c })}>還原這句</a>}
                      </div>
                    </div>
                  )}
                </li>)
            })}
          </ol>
        </div>
        {err && <div className="error small pf-err">{err}</div>}
        <div className="pf-foot">
          <span>{changed > 0 ? <><b>已改 {changed} 句</b><small className="muted">會算一輪修改</small></> : <span className="muted small">還沒有改動</span>}</span>
          <span className="spacer" />
          {changed > 0 && <a className="small muted" onClick={() => setEdits({})}>全部還原</a>}
          <button className="btn primary" disabled={changed === 0} onClick={() => { onSend(message()); onClose() }}>重新輸出 →</button>
        </div>
      </div>
    </div>
  )
}
