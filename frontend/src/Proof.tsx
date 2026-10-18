import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type DeliverableVersion } from './api'
import type { Line } from './Script'

/* 校對台 (導演模式): the finished video and its narration side by side, and the copy is edited right
   here. Every line is a text box — tap it and type. The line you are on grows a small toolbar: 試聽,
   我唸這句 (speech-to-speech in the video's voice), 唸法 (homophones for the voice only), ⭐ 重點, ✕ 刪掉,
   ＋ 加一句. 整篇改 opens the whole script as one text. The edits become one 校對結果 message; only the
   changed lines are re-voiced. */
type Row = { id: number; n: number | null; start: number; end: number; text: string }   // n: original line number (null = added here)
type Edit = { text?: string; say?: string; star?: boolean; drop?: boolean; take?: string; rewrite?: boolean }
type Shot = { i: number; clip: number; start: number; dur: number; at: number }
const STAR_MAX = 3
const tc = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function Proof({ projectId, version, lines: given, onClose, onSend, onUsage }:
  { projectId: string; version: DeliverableVersion | null; lines?: Line[]; onClose: () => void; onSend: (text: string) => void; onUsage?: () => void }) {
  const toRows = (ls: Line[]): Row[] => ls.map((l, i) => ({ id: i + 1, n: i + 1, start: l.start, end: l.end, text: l.text }))
  const [rows, setRows] = useState<Row[]>(toRows(given ?? []))
  const nextId = useRef(1000)
  const [voiceId, setVoiceId] = useState('')
  const [sayPts, setSayPts] = useState(1)
  const [shots, setShots] = useState<Shot[]>([])
  const [loading, setLoading] = useState(!given)
  const [edits, setEdits] = useState<Record<number, Edit>>({})
  const [active, setActive] = useState<number | null>(null)     // row id whose toolbar is open
  const [sayOpen, setSayOpen] = useState<number | null>(null)   // row id with the 唸法 box open
  const [whole, setWhole] = useState<string | null>(null)       // 整篇改 text, while open
  const [cur, setCur] = useState(-1)
  const [saying, setSaying] = useState<number | null>(null)
  const [rec, setRec] = useState<{ id: number; phase: 'rec' | 'up' | 'done'; url?: string } | null>(null)
  const [err, setErr] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const mr = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    api.script(projectId).then(r => { if (!given?.length) setRows(toRows(r.lines)); setVoiceId(r.voice_id); setSayPts(r.say_points); setShots(r.shots ?? []) }).catch(() => {}).finally(() => setLoading(false))
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { audio.current?.pause(); mr.current?.stream.getTracks().forEach(t => t.stop()) }, [])
  const total = useMemo(() => Math.max(rows[rows.length - 1]?.end ?? 0, shots.length ? shots[shots.length - 1].at + shots[shots.length - 1].dur : 0, video.current?.duration || 0), [rows, shots, cur])
  const now = video.current?.currentTime ?? 0
  const curShot = shots.findIndex(sh => now >= sh.at && now < sh.at + sh.dur)
  const src = version?.videos.find(v => v.role === 'preview')?.url ?? version?.main?.url ?? null

  const onTime = () => {
    const t = video.current?.currentTime ?? 0
    const i = rows.findIndex(l => t >= l.start && t < l.end)
    if (i !== cur) { setCur(i); if (i >= 0 && active === null) listRef.current?.children[i]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }
  }
  const seek = (t: number) => { if (video.current) { video.current.currentTime = t; video.current.play().catch(() => {}) } }
  const ed = (id: number) => edits[id] ?? {}
  const row = (id: number) => rows.find(r => r.id === id)!
  const shown = (r: Row) => ed(r.id).text ?? r.text
  const patch = (id: number, p: Edit) => setEdits(m => {
    const r = row(id); const next = { ...(m[id] ?? {}), ...p }
    if (next.text !== undefined && r.n !== null && next.text.trim() === r.text) delete next.text
    if (next.say !== undefined && (!next.say.trim() || next.say.trim() === (next.text ?? r.text))) delete next.say
    for (const k of ['star', 'drop', 'take', 'rewrite'] as const) if (!next[k]) delete next[k]
    const c = { ...m }; if (Object.keys(next).length) c[id] = next; else delete c[id]; return c
  })
  const stars = Object.values(edits).filter(e => e.star).length
  const added = rows.filter(r => r.n === null)
  const changed = Object.keys(edits).length + added.filter(r => !edits[r.id]).length
  const addAfter = (id: number) => {
    const i = rows.findIndex(r => r.id === id); const prev = rows[i]
    const nid = nextId.current++
    const nr: Row = { id: nid, n: null, start: prev.end, end: prev.end + 2, text: '' }
    setRows(rs => [...rs.slice(0, i + 1), nr, ...rs.slice(i + 1)]); setActive(nid)
    setTimeout(() => (listRef.current?.querySelector(`[data-id="${nid}"] textarea`) as HTMLTextAreaElement | null)?.focus(), 30)
  }
  const removeAdded = (id: number) => { setRows(rs => rs.filter(r => r.id !== id)); setEdits(m => { const c = { ...m }; delete c[id]; return c }); setActive(null) }
  const grow = (el: HTMLTextAreaElement | null) => { if (el) { el.style.height = '0'; el.style.height = `${el.scrollHeight}px` } }

  const say = async (id: number) => {
    const r = row(id); const e = ed(id)
    const text = (e.say ?? e.text ?? r.text).trim()
    if (!text || saying !== null) return
    setSaying(id); setErr('')
    try {
      video.current?.pause()
      const res = await api.say(projectId, text, voiceId)
      onUsage?.(); audio.current?.pause()
      const a = new Audio(res.url); audio.current = a; a.onended = () => setSaying(null); await a.play()
    } catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? `點數不足：試聽要 ${ex.needed} 點` : ex.message); setSaying(null) }
  }
  const takeStart = async (id: number) => {
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
      setRec({ id, phase: 'up' })
      try {
        const n = row(id).n ?? rows.findIndex(x => x.id === id) + 1
        const fd = new FormData(); fd.append('audio', blob, blob.type.includes('mp4') ? 'take.m4a' : 'take.webm'); fd.append('n', String(n)); fd.append('voice_id', voiceId)
        const res = await fetch(`/api/projects/${projectId}/take`, { method: 'POST', body: fd })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) throw Object.assign(new Error(d.detail ?? '轉換失敗'), { needed: d.needed })
        onUsage?.(); patch(id, { take: d.key }); setRec({ id, phase: 'done', url: d.url })
        audio.current?.pause(); const a = new Audio(d.url); audio.current = a; a.play().catch(() => {})
      } catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? `點數不足：需要 ${ex.needed} 點` : ex.message); setRec(null) }
    }
    mr.current = r; r.start(250); video.current?.pause(); setRec({ id, phase: 'rec' })
  }
  const takeStop = () => { if (mr.current && mr.current.state !== 'inactive') mr.current.stop() }

  // 整篇改: one line per row; same count → per-line edits, different count → a new script
  const applyWhole = () => {
    if (whole === null) return
    const ls = whole.split('\n').map(x => x.trim()).filter(Boolean)
    if (ls.length === rows.length) { rows.forEach((r, i) => patch(r.id, { text: ls[i] })) }
    else {
      const base = rows[0]?.start ?? 0
      setEdits({})
      setRows(ls.map((t, i) => ({ id: nextId.current++, n: null, start: base + i * 3, end: base + i * 3 + 3, text: t })))
    }
    setWhole(null)
  }

  const message = () => {
    const out: string[] = ['校對結果，請照著修改後重新輸出（只重配有改的句子，其他句子的音檔沿用；畫面盡量沿用）：']
    if (rows.length && rows.every(r => r.n === null)) {
      out[0] = '校對結果：整份旁白稿改成下面這樣，請重新配音、字幕、輸出（畫面盡量沿用，長度依新稿調整）：'
      rows.forEach((r, i) => out.push(`${i + 1}. ${shown(r).trim()}${ed(r.id).star ? '（重點：字幕放大、鏡頭多停）' : ''}`))
      return out.join('\n')
    }
    rows.forEach((r, i) => {
      const e = edits[r.id]
      if (r.n === null) { const t = shown(r).trim(); if (t) out.push(`- 在第 ${rows[i - 1]?.n ?? i} 句後面加一句「${t}」（配音、字幕都加，畫面挑合適的素材）${e?.star ? '；這句是重點' : ''}`); return }
      if (!e) return
      const bits: string[] = []
      if (e.drop) bits.push('刪掉這句，畫面用其他素材補')
      else {
        if (e.rewrite) bits.push('這句請重寫得更順、更有畫面感')
        if (e.text !== undefined) bits.push(`字幕改成「${e.text.trim()}」`)
        if (e.take) bits.push(`配音用我唸的版本（key ${e.take}，已轉成影片的聲音），這句不要再生成`)
        else if (e.say !== undefined) bits.push(`唸法用「${e.say.trim()}」（字幕仍顯示${e.text !== undefined ? '上面那句' : '原句'}）`)
        if (e.star) bits.push('這句是重點：字幕放大、鏡頭多停 1–2 秒')
      }
      out.push(`- 第 ${r.n} 句（${tc(r.start)} 「${r.text}」）：${bits.join('；')}`)
    })
    return out.join('\n')
  }

  return (
    <div className="pf-scrim" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="pf" role="dialog" aria-label="校對台">
        <div className="pf-head">
          <b>校對台</b>{version && <span className="pf-ver">v{version.version}</span>}
          <span className="muted small">點句子直接改字 · 點秒數跳到那段</span>
          <span className="spacer" />
          {rows.length > 0 && <a className="pf-whole" onClick={() => setWhole(whole === null ? rows.map(shown).join('\n') : null)}>{whole === null ? '整篇改' : '回到逐句'}</a>}
          <a className="pf-x" onClick={onClose} aria-label="關閉">✕</a>
        </div>
        <div className="pf-body">
          <div className="pf-video">
            {src ? <video ref={video} src={src} controls playsInline preload="metadata" poster={version?.poster ?? undefined} onTimeUpdate={onTime} onLoadedMetadata={onTime} />
              : <div className="pf-novideo muted small">這一版還沒有影片檔，先校對文字；重新輸出後就有畫面可以對照。</div>}
            {shots.length > 0 && total > 0 && (
              <div className="pf-shots" aria-label="分鏡">
                {shots.map(sh => (
                  <a key={sh.i} className={`pf-shot ${sh.i === curShot ? 'on' : ''}`} style={{ width: `${(sh.dur / total) * 100}%` }} onClick={() => seek(sh.at)} title={`第 ${sh.i + 1} 段 · 素材 #${String(sh.clip).padStart(2, '0')} · ${sh.dur.toFixed(1)} 秒`}>
                    <img src={api.frameUrl(projectId, sh.clip, sh.start)} alt="" loading="lazy" /><i>#{String(sh.clip).padStart(2, '0')}</i>
                  </a>))}
              </div>
            )}
            {rows.length > 0 && total > 0 && (
              <div className="pf-tl" aria-hidden="true">
                {rows.map((l, i) => (
                  <i key={l.id} className={`${i === cur ? 'on' : ''} ${ed(l.id).drop ? 'drop' : ''} ${ed(l.id).star ? 'star' : ''}`}
                    style={{ left: `${(l.start / total) * 100}%`, width: `${Math.max(0.8, ((l.end - l.start) / total) * 100)}%` }} onClick={() => seek(l.start)} />))}
                {video.current && <b className="pf-cursor" style={{ left: `${((video.current.currentTime || 0) / total) * 100}%` }} />}
              </div>
            )}
          </div>

          {whole !== null ? (
            <div className="pf-wholebox">
              <div className="muted small">一行一句。行數一樣就逐句對應；行數不一樣就當成新稿，剪輯師會重新配音、對畫面。</div>
              <textarea value={whole} onChange={e => setWhole(e.target.value)} rows={Math.max(8, whole.split('\n').length + 1)} />
              <div className="pf-acts"><button className="btn primary" onClick={applyWhole}>套用</button><a className="small muted" onClick={() => setWhole(null)}>取消</a></div>
            </div>
          ) : (
            <ol className="pf-lines" ref={listRef}>
              {loading && <li className="muted small pf-empty">載入旁白稿…</li>}
              {!loading && rows.length === 0 && <li className="muted small pf-empty">找不到這支的旁白稿。剪輯師交付時會附旁白稿，之後再來校對。</li>}
              {rows.map((r, i) => {
                const e = ed(r.id); const on = active === r.id; const txt = shown(r)
                return (
                  <li key={r.id} data-id={r.id} className={`pf-line ${i === cur ? 'cur' : ''} ${on ? 'on' : ''} ${e.drop ? 'drop' : ''} ${e.star ? 'star' : ''} ${r.n === null ? 'added' : ''}`} onClick={() => setActive(r.id)}>
                    <div className="pf-row">
                      <a className="pf-tc" onClick={ev => { ev.stopPropagation(); seek(r.start) }} title="跳到這句"><b>{i + 1}</b><span>{r.n === null ? '新' : tc(r.start)}</span></a>
                      <div className="pf-txt">
                        <div className="pf-badges">
                          {e.star && <em className="pf-badge star">重點</em>}{e.drop && <em className="pf-badge drop">刪掉</em>}
                          {e.text !== undefined && !e.drop && r.n !== null && <em className="pf-badge ed">已改</em>}{e.rewrite && !e.drop && <em className="pf-badge ed">請重寫</em>}
                          {e.say !== undefined && !e.drop && !e.take && <em className="pf-badge say">唸法</em>}{e.take && !e.drop && <em className="pf-badge take">我唸的</em>}
                          {r.n === null && <em className="pf-badge add">加的</em>}
                        </div>
                        <textarea ref={grow} rows={1} value={txt} placeholder={r.n === null ? '打這一句要講的話…' : ''} disabled={!!e.drop}
                          onFocus={() => setActive(r.id)} onChange={ev => { patch(r.id, { text: ev.target.value }); grow(ev.target) }} />
                        {e.text !== undefined && r.n !== null && !e.drop && <a className="pf-undo" onClick={ev => { ev.stopPropagation(); patch(r.id, { text: undefined }) }}>還原原句</a>}
                      </div>
                    </div>
                    {on && !e.drop && sayOpen === r.id && (
                      <div className="pf-saybox" onClick={ev => ev.stopPropagation()}>
                        <span>怎麼唸<small>唸錯字時，用同音字寫給配音看；字幕不受影響</small></span>
                        <input value={e.say ?? ''} placeholder={txt} onChange={ev => patch(r.id, { say: ev.target.value })} />
                      </div>
                    )}
                    {on && (
                      <div className="pf-tools" onClick={ev => ev.stopPropagation()}>
                        {!e.drop && <>
                          <button type="button" className="pf-tb" disabled={saying !== null || !txt.trim()} onClick={() => say(r.id)}><i>▶</i>{saying === r.id ? '播放中' : `試聽 ${sayPts} 點`}</button>
                          {rec?.id === r.id && rec.phase === 'rec' ? <button type="button" className="pf-tb rec" onClick={takeStop}><i>■</i>唸完了</button>
                            : rec?.id === r.id && rec.phase === 'up' ? <button type="button" className="pf-tb" disabled><i>…</i>轉換中</button>
                            : <button type="button" className={`pf-tb ${e.take ? 'on' : ''}`} disabled={rec !== null && rec.phase !== 'done'} onClick={() => takeStart(r.id)} title="自己唸這一句，配音會用影片的聲音照你的唸法再念一次"><i>🎙</i>{e.take ? '再唸' : `我唸 ${sayPts} 點`}</button>}
                          <button type="button" className={`pf-tb ${sayOpen === r.id || e.say !== undefined ? 'on' : ''}`} onClick={() => setSayOpen(sayOpen === r.id ? null : r.id)}><i>ㄅ</i>唸法</button>
                          <button type="button" className={`pf-tb ${e.star ? 'on' : ''}`} disabled={!e.star && stars >= STAR_MAX} onClick={() => patch(r.id, { star: !e.star })} title={stars >= STAR_MAX && !e.star ? `重點最多 ${STAR_MAX} 句` : ''}><i>⭐</i>重點</button>
                          {r.n !== null && <button type="button" className={`pf-tb ${e.rewrite ? 'on' : ''}`} onClick={() => patch(r.id, { rewrite: !e.rewrite })}><i>✨</i>請剪輯師重寫</button>}
                        </>}
                        {r.n === null
                          ? <button type="button" className="pf-tb" onClick={() => removeAdded(r.id)}><i>✕</i>不加了</button>
                          : <button type="button" className={`pf-tb ${e.drop ? 'on' : ''}`} onClick={() => patch(r.id, { drop: !e.drop })}><i>✕</i>{e.drop ? '還是要' : '刪掉'}</button>}
                        <button type="button" className="pf-tb" onClick={() => addAfter(r.id)}><i>＋</i>後面加一句</button>
                        {e.take && rec?.id === r.id && rec.url && <a className="small" onClick={() => { audio.current?.pause(); const a = new Audio(rec.url!); audio.current = a; a.play().catch(() => {}) }}>▶ 聽我唸的</a>}
                        {edits[r.id] && r.n !== null && <a className="small muted" onClick={() => { setEdits(m => { const c = { ...m }; delete c[r.id]; return c }); setSayOpen(null) }}>還原這句</a>}
                      </div>
                    )}
                  </li>)
              })}
            </ol>
          )}
        </div>
        {err && <div className="error small pf-err">{err}</div>}
        <div className="pf-foot">
          <span>{changed > 0 ? <><b>已改 {changed} 句</b><small className="muted">會算一輪修改</small></> : <span className="muted small">還沒有改動 · 點句子就能改</span>}</span>
          <span className="spacer" />
          {changed > 0 && <a className="small muted" onClick={() => { setEdits({}); setRows(rs => rs.filter(r => r.n !== null)) }}>全部還原</a>}
          <button className="btn primary" disabled={changed === 0 || rows.some(r => r.n === null && !shown(r).trim())} onClick={() => { onSend(message()); onClose() }}>重新輸出 →</button>
        </div>
      </div>
    </div>
  )
}
