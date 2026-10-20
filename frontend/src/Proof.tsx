import { useEffect, useMemo, useRef, useState } from 'react'
import { CAPTION_STYLES, CapSample } from './captionStyles'
import { api, type DeliverableVersion, type Voice } from './api'
import type { Line } from './Script'

/* 校對台 (導演模式): the finished video and its narration side by side, and the copy is edited right
   here. Every line is a text box — tap it and type. The line you are on grows a small toolbar: 試聽,
   我唸這句 (speech-to-speech in the video's voice), 唸法 (homophones for the voice only), ⭐ 重點, ✕ 刪掉,
   ＋ 加一句. 整篇改 opens the whole script as one text. The edits become one 校對結果 message; only the
   changed lines are re-voiced. */
type Row = { id: number; n: number | null; key?: string; start: number; end: number; text: string }   // n: original line number (null = added here); key: VO key when the recipe is known
type Edit = { text?: string; say?: string; star?: boolean; drop?: boolean; take?: string; rewrite?: boolean }
type Shot = { i: number; clip: number; start: number; dur: number; at: number }
const STAR_MAX = 3
const tc = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function Proof({ projectId, version, lines: given, onClose, onSend, onUsage, onDone, easy = false, hasOwnVoice = true, onClone, onOwnVoice, onPro, onTimeline }:
  { projectId: string; version: DeliverableVersion | null; lines?: Line[]; onClose: () => void; onSend: (text: string) => void; onUsage?: () => void; onDone?: () => void
    easy?: boolean; hasOwnVoice?: boolean; onClone?: () => void; onOwnVoice?: () => void; onPro?: () => void; onTimeline?: () => void }) {
  const toRows = (ls: (Line & { key?: string })[]): Row[] => ls.map((l, i) => ({ id: i + 1, n: i + 1, key: l.key, start: l.start, end: l.end, text: l.text }))
  const [quickOK, setQuickOK] = useState(false)      // the recipe is known: small changes re-render without the editor
  const [applying, setApplying] = useState(false)
  const [rows, setRows] = useState<Row[]>(toRows(given ?? []))
  const nextId = useRef(1000)
  const [voiceId, setVoiceId] = useState('')
  const [, setSayPts] = useState(1)
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
    api.script(projectId).then(r => { if (r.quick || !given?.length) setRows(toRows(r.lines)); setQuickOK(!!r.quick); setVoiceId(r.voice_id); setSayPts(r.say_points); setShots(r.shots ?? []) }).catch(() => {}).finally(() => setLoading(false))
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

  // 微調 or 剪輯師? Everything on an existing line (text, 唸法, drop, take, star) re-renders from the recipe;
  // a new line or a rewrite needs the editor.
  const needsEditor = added.length > 0 || Object.values(edits).some(e => e.rewrite) || rows.some(r => edits[r.id] && !r.key)
  const quickable = quickOK && !needsEditor && changed > 0
  const applyQuick = async () => {
    setApplying(true); setErr('')
    try {
      const lines = rows.filter(r => r.key && edits[r.id]).map(r => { const e = edits[r.id]; return { key: r.key!, text: e.text?.trim(), say: e.say?.trim(), drop: e.drop, take: e.take, star: e.star } })
      await api.quick(projectId, { lines })
      onUsage?.(); onDone?.(); onClose()
    } catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? '點數不足，先儲值再套用' : ex.message); setApplying(false) }
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
          <span className="muted small">{easy ? '點一句聽聽看，唸錯的自己唸一次就好' : '點句子直接改字 · 點秒數跳到那段'}</span>
          <span className="spacer" />
          {!easy && onTimeline && shots.length > 0 && <a className="pf-whole" onClick={onTimeline}>時間軸</a>}
          {!easy && rows.length > 0 && <a className="pf-whole" onClick={() => setWhole(whole === null ? rows.map(shown).join('\n') : null)}>{whole === null ? '整篇改' : '回到逐句'}</a>}
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
            <ol className={`pf-lines ${easy ? 'ez' : ''}`} ref={listRef}>
              {easy && !hasOwnVoice && onClone && !loading && rows.length > 0 && (
                <li className="pf-own"><div><b>想讓旁白變成你自己的聲音？</b><span>錄 30 秒就好，整支影片會換成你的聲音</span></div><button type="button" className="btn primary" onClick={onClone}>🎙 錄我的聲音</button></li>
              )}
              {easy && hasOwnVoice && onOwnVoice && !loading && rows.length > 0 && (
                <li className="pf-own"><div><b>整支換成你的聲音？</b><span>用你錄好的聲音重配整支旁白，約 1–2 分鐘</span></div><button type="button" className="btn primary" onClick={onOwnVoice}>🎙 換成我的聲音</button></li>
              )}
              {loading && <li className="muted small pf-empty">載入旁白稿…</li>}
              {!loading && rows.length === 0 && <li className="muted small pf-empty">找不到這支的旁白稿。剪輯師交付時會附旁白稿，之後再來校對。</li>}
              {easy && rows.map((r, i) => {
                const e = ed(r.id)
                return (
                  <li key={r.id} data-id={r.id} className={`pf-line ez ${i === cur ? 'cur' : ''} ${e.take ? 'star' : ''}`}>
                    <div className="pf-row" onClick={() => seek(r.start)}>
                      <a className="pf-tc"><b>{i + 1}</b><span>{tc(r.start)}</span></a>
                      <div className="pf-txt"><div className="pf-ez-text">{r.text}</div>
                        {e.take && <em className="pf-badge take">✓ 已換成你唸的</em>}
                      </div>
                    </div>
                    <div className="pf-tools" onClick={ev => ev.stopPropagation()}>
                      <button type="button" className="pf-tb" onClick={() => seek(r.start)}><i>▶</i>聽這句</button>
                      {rec?.id === r.id && rec.phase === 'rec' ? <button type="button" className="pf-tb rec" onClick={takeStop}><i>■</i>唸完了</button>
                        : rec?.id === r.id && rec.phase === 'up' ? <button type="button" className="pf-tb" disabled><i>…</i>轉換中</button>
                        : <button type="button" className={`pf-tb ${e.take ? 'on' : ''}`} disabled={rec !== null && rec.phase !== 'done'} onClick={() => takeStart(r.id)}><i>🎙</i>{e.take ? '再唸一次' : '唸錯了，我自己唸'}</button>}
                      {e.take && rec?.id === r.id && rec.url && <a className="small" onClick={() => { audio.current?.pause(); const a = new Audio(rec.url!); audio.current = a; a.play().catch(() => {}) }}>▶ 聽我唸的</a>}
                    </div>
                  </li>)
              })}
              {easy && onPro && !loading && (
                <li className="pf-topro"><span>想逐句改字、改整篇旁白稿？</span><a onClick={onPro}>到導演模式細改 →</a></li>
              )}
              {!easy && rows.map((r, i) => {
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
                          <button type="button" className="pf-tb" disabled={saying !== null || !txt.trim()} onClick={() => say(r.id)}><i>▶</i>{saying === r.id ? '播放中' : '試聽'}</button>
                          {rec?.id === r.id && rec.phase === 'rec' ? <button type="button" className="pf-tb rec" onClick={takeStop}><i>■</i>唸完了</button>
                            : rec?.id === r.id && rec.phase === 'up' ? <button type="button" className="pf-tb" disabled><i>…</i>轉換中</button>
                            : <button type="button" className={`pf-tb ${e.take ? 'on' : ''}`} disabled={rec !== null && rec.phase !== 'done'} onClick={() => takeStart(r.id)} title="自己唸這一句，配音會用影片的聲音照你的唸法再念一次"><i>🎙</i>{e.take ? '再唸' : '我唸這句'}</button>}
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
          <span>{changed > 0 ? <><b>{easy ? `重唸了 ${changed} 句` : `已改 ${changed} 句`}</b><small className="muted">{quickable ? '直接套用，不用等剪輯師' : needsEditor && quickOK ? '有加句或重寫，要請剪輯師' : ''}</small></> : <span className="muted small">{easy ? '唸得都對就不用改' : '還沒有改動 · 點句子就能改'}</span>}</span>
          <span className="spacer" />
          {changed > 0 && !applying && <a className="small muted" onClick={() => { setEdits({}); setRows(rs => rs.filter(r => r.n !== null)) }}>全部還原</a>}
          {quickable
            ? <button className="btn primary" disabled={applying} onClick={applyQuick}>{applying ? '重新輸出中…（約 1–2 分鐘）' : '套用修改 →'}</button>
            : <button className="btn primary" disabled={changed === 0 || applying || rows.some(r => r.n === null && !shown(r).trim())} onClick={() => { onSend(message()); onClose() }}>{easy ? '套用修改 →' : '請剪輯師修改 →'}</button>}
        </div>
      </div>
    </div>
  )
}


/* 微調: the knobs that never need the editor — caption size, music level, narration speed, price colour,
   the voice. One tap each, then 套用 re-renders from the recipe. */
export function Tweak({ projectId, onClose, onDone, onUsage }: { projectId: string; onClose: () => void; onDone?: () => void; onUsage?: () => void }) {
  const [scale, setScale] = useState<number | null>(null)
  const [gain, setGain] = useState<number | null>(null)
  const [speed, setSpeed] = useState<number | null>(null)
  const [color, setColor] = useState<string | null>(null)
  const [voice, setVoice] = useState<string | null>(null)
  const [cap, setCap] = useState<string | null>(null)
  const [curCap, setCurCap] = useState('gold')
  const [voices, setVoices] = useState<Voice[]>([])
  const [cur, setCur] = useState('')
  const [ok, setOk] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    api.script(projectId).then(r => { setOk(!!r.quick); setCur(r.voice_id); setCurCap(r.caption_style || 'gold') }).catch(() => setOk(false))
    api.voices().then(setVoices).catch(() => {})
  }, [projectId])
  const n = [cap, scale, gain, speed, color, voice].filter(x => x !== null).length
  const apply = async () => {
    setBusy(true); setErr('')
    try {
      await api.quick(projectId, { ...(cap !== null && { caption_style: cap }), ...(scale !== null && { caption_scale: scale }), ...(gain !== null && { music_gain: gain }), ...(speed !== null && { speed }), ...(color !== null && { counter_color: color }), ...(voice !== null && { voice_id: voice }) })
      onUsage?.(); onDone?.(); onClose()
    } catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? '點數不足，先儲值再套用' : ex.message); setBusy(false) }
  }
  const Opt = <T,>({ v, set, options }: { v: T | null; set: (x: T | null) => void; options: { v: T; l: string; d?: boolean }[] }) => (
    <div className="tw-opts">{options.map(o => <button key={String(o.v)} type="button" className={`tw-o ${v === o.v || (v === null && o.d) ? 'on' : ''}`} onClick={() => set(o.d ? null : o.v)}>{o.l}</button>)}</div>)
  return (
    <div className="pf-scrim" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="tw" role="dialog" aria-label="微調">
        <div className="pf-head"><b>微調</b><span className="muted small">不用等剪輯師，改完直接重出</span><span className="spacer" /><a className="pf-x" onClick={onClose} aria-label="關閉">✕</a></div>
        {ok === false ? <div className="pf-novideo muted small" style={{ margin: 14 }}>這支還沒有可以微調的版本，請先讓剪輯師重新輸出一次。</div> : (
          <div className="tw-body">
            <div className="tw-row"><span>字幕樣式</span>
              <div className="tw-caps">{CAPTION_STYLES.map(c => (
                <button key={c.id} type="button" className={`tw-cap ${(cap ?? curCap) === c.id ? 'on' : ''}`} onClick={() => setCap(c.id === curCap ? null : c.id)}><CapSample id={c.id} short /><small>{c.name}</small></button>))}
              </div></div>
            <label><span>字幕大小</span><Opt v={scale} set={setScale} options={[{ v: .85, l: '小' }, { v: 1, l: '標準', d: true }, { v: 1.2, l: '大' }]} /></label>
            <label><span>配樂音量</span><Opt v={gain} set={setGain} options={[{ v: .32, l: '小聲' }, { v: .55, l: '標準', d: true }, { v: .8, l: '大聲' }]} /></label>
            <label><span>旁白速度</span><Opt v={speed} set={setSpeed} options={[{ v: .93, l: '慢一點' }, { v: 1, l: '標準', d: true }, { v: 1.12, l: '快一點' }]} /></label>
            <label><span>價格字幕顏色</span><Opt v={color} set={setColor} options={[{ v: 'gold', l: '金', d: true }, { v: 'white', l: '白' }, { v: 'red', l: '紅' }, { v: 'blue', l: '藍' }]} /></label>
            {voices.length > 0 && <label><span>旁白聲音<small>換聲音會整支重配</small></span>
              <Opt v={voice} set={setVoice} options={voices.map(v => ({ v: v.voice_id, l: (v.custom ? '我的聲音 ' : '') + v.name, d: v.voice_id === cur }))} /></label>}
          </div>
        )}
        {err && <div className="error small pf-err">{err}</div>}
        <div className="pf-foot">
          <span className="muted small">{n > 0 ? `改了 ${n} 項` : '選一項就能套用'}</span><span className="spacer" />
          <button className="btn primary" disabled={!ok || n === 0 || busy} onClick={apply}>{busy ? '重新輸出中…（約 1–2 分鐘）' : '套用 →'}</button>
        </div>
      </div>
    </div>
  )
}
