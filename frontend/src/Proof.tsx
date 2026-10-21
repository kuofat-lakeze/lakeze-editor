import { useEffect, useMemo, useRef, useState } from 'react'
import { api, verLabel, type DeliverableVersion, type LineEdit, type QuickEdits, type ScriptInfo } from './api'
import { RecBar, SheetHead, useRecorder } from './Recorder'
import { FixSay } from './Pronounce'
import { sayCached, useLinePreview } from './preview'
import { IcMic, IcMinus, IcPencil, IcPlay, IcSpeech, IcStop, IcUndo } from './icons'

/* 校對旁白 (輕鬆模式): the finished video and its narration, one big row per line. Each row can be
   listened to, re-read by the owner (speech-to-speech in the video's voice) or dropped — the picture
   segment goes with it. ▶ plays that segment of the current version. 導演模式 has the 時間軸 for anything finer. */
type Row = { line: ScriptInfo['lines'][number]; shot: ScriptInfo['shots'][number] | undefined }
type State = { order: number[]; drops: Set<number>; lines: Record<string, LineEdit> }
const tc = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function Proof({ projectId, version, onClose, onUsage, onDone, onOwnVoice, onPro, initialLines, onLines }:
  { projectId: string; version: DeliverableVersion | null; onClose: () => void; onUsage?: () => void; onDone?: () => void
    onOwnVoice?: () => void; onPro?: () => void; initialLines?: Record<string, LineEdit>; onLines?: (l: Record<string, LineEdit>) => void }) {
  const [info, setInfo] = useState<ScriptInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [st, setSt] = useState<State>({ order: [], drops: new Set(), lines: initialLines ?? {} })
  const past = useRef<State[]>([]); const [, bump] = useState(0)
  const [cur, setCur] = useState(-1)
  const [takeFor, setTakeFor] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)   // row whose 改字 box is open
  const [fixing, setFixing] = useState<Row | null>(null)        // row in the 唸錯了 sheet
  const [draft, setDraft] = useState('')
  const [takeBusy, setTakeBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [err, setErr] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const stopAt = useRef<number | null>(null)
  const src = version?.videos.find(v => v.role === 'preview')?.url ?? version?.main?.url ?? null
  // 改完馬上聽: the new line over the old picture (see preview.ts); takeUrls = the owner's recordings by key
  const pv = useLinePreview(video)
  const takeUrls = useRef<Record<string, string>>({})
  const [hearing, setHearing] = useState<string | null>(null)   // line whose new voice is being generated
  useEffect(() => {
    api.script(projectId).then(r => { setInfo(r); takeUrls.current = r.takes ?? {}; setSt(s => ({ ...s, order: (r.shots ?? []).map(x => x.i) })) }).catch(() => {}).finally(() => setLoading(false))
  }, [projectId])
  useEffect(() => { onLines?.(st.lines) }, [st.lines]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { audio.current?.pause() }, [])

  const shots = info?.shots ?? [], lines = info?.lines ?? []
  const recut = !!info?.recut
  const shotOf = (l: ScriptInfo['lines'][number]) => shots.find(s => l.start >= s.at - 1e-6 && l.start < s.at + s.dur - 1e-6)
  // rows in their current order: segments as ordered, each with the line that starts in it; lines in no segment at the end
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const i of st.order) { const s = shots.find(x => x.i === i); if (!s) continue; for (const l of lines) if (shotOf(l)?.i === i) out.push({ line: l, shot: s }) }
    for (const l of lines) if (!shotOf(l)) out.push({ line: l, shot: undefined })
    return out
  }, [st.order, shots, lines]) // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (f: (s: State) => State) => { setSt(s => { past.current = [...past.current.slice(-40), s]; return f(s) }); bump(x => x + 1) }
  const undo = () => { const p = past.current.pop(); if (p) { setSt(p); bump(x => x + 1) } }
  const isDropped = (r: Row) => !!st.lines[r.line.key ?? '']?.drop
  const toggleDrop = (r: Row) => commit(s => {
    const key = r.line.key ?? ''; const drop = !s.lines[key]?.drop
    const ln = { ...s.lines }; const cur = { ...(ln[key] ?? {}) }; if (drop) cur.drop = true; else delete cur.drop; if (Object.keys(cur).length) ln[key] = cur; else delete ln[key]
    const drops = new Set(s.drops)
    if (r.shot) { const others = lines.filter(l => l !== r.line && shotOf(l)?.i === r.shot!.i && !ln[l.key ?? '']?.drop); if (drop && !others.length) drops.add(r.shot.i); else drops.delete(r.shot.i) }
    return { ...s, lines: ln, drops }
  })
  const setTake = (key: string, take: string) => commit(s => ({ ...s, lines: { ...s.lines, [key]: { ...(s.lines[key] ?? {}), take } } }))
  const setText = (r: Row, text: string) => commit(s => { const key = r.line.key ?? ''; const cur = { ...(s.lines[key] ?? {}) }; if (text.trim() && text.trim() !== r.line.text) cur.text = text.trim(); else delete cur.text; const ln = { ...s.lines }; if (Object.keys(cur).length) ln[key] = cur; else delete ln[key]; return { ...s, lines: ln } })
  const setSay = (r: Row, say: string | undefined) => commit(s => { const key = r.line.key ?? ''; const cur = { ...(s.lines[key] ?? {}) }; if (say) cur.say = say; else delete cur.say; const ln = { ...s.lines }; if (Object.keys(cur).length) ln[key] = cur; else delete ln[key]; return { ...s, lines: ln } })
  const nTexts = Object.values(st.lines).filter(e => e.text !== undefined).length
  const nSays = Object.values(st.lines).filter(e => e.say !== undefined && !e.take).length
  const nTakes = Object.values(st.lines).filter(e => e.take).length
  const nDrops = Object.values(st.lines).filter(e => e.drop).length
  const moved = st.order.some((i, k) => shots[k]?.i !== i)
  const changed = nTakes + nDrops + nTexts + nSays + (moved ? 1 : 0)
  const keptRows = rows.filter(r => !isDropped(r))

  const onTime = () => { const v = video.current; if (!v) return; const t = v.currentTime; setCur(rows.findIndex(r => t >= r.line.start && t < r.line.end)); if (stopAt.current !== null && t >= stopAt.current) { v.pause(); stopAt.current = null } }
  const play = (r: Row) => { pv.stop(); const v = video.current; if (!v) return; stopAt.current = r.line.end + 0.1; v.currentTime = r.line.start; v.play().catch(() => {}) }
  /** Hear the line as it will sound after 套用: the owner's take, or a freshly generated line (one sample, cached). */
  const hearNew = async (r: Row, o?: { text?: string; say?: string; takeUrl?: string }) => {
    const key = r.line.key ?? ''; const e = st.lines[key] ?? {}
    pv.unlock(); setErr(''); stopAt.current = null
    const takeUrl = o?.takeUrl ?? (e.take ? takeUrls.current[e.take] : undefined)
    if (takeUrl) { pv.play(key, r.line.start, r.line.end, takeUrl); return }
    const text = (o?.say ?? o?.text ?? e.say ?? e.text ?? r.line.text).trim()
    if (!text) return
    setHearing(key)
    try { const s = await sayCached(projectId, text, info?.voice_id ?? ''); if (!s.cached) onUsage?.(); await pv.play(key, r.line.start, r.line.end, s.url) }
    catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? `點數不足：聽新配音要 ${ex.needed} 點` : ex.message) } finally { setHearing(null) }
  }
  const recorder = useRecorder(async blob => {
    const key = takeFor; const r = rows.find(x => x.line.key === key); setTakeFor(null)
    if (!key || !r) return
    setTakeBusy(true); setErr('')
    try {
      const fd = new FormData(); fd.append('audio', blob, blob.type.includes('mp4') ? 'take.m4a' : 'take.webm'); fd.append('n', String(r.line.n)); fd.append('mode', 'raw')
      const res = await fetch(`/api/projects/${projectId}/take`, { method: 'POST', body: fd }); const d = await res.json().catch(() => ({}))
      if (!res.ok) throw Object.assign(new Error(d.detail ?? '處理錄音失敗'), { needed: d.needed })
      onUsage?.(); setTake(key, d.key); takeUrls.current[d.key] = d.url; hearNew(r, { takeUrl: d.url })   // hear it in place right away
    } catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? `點數不足：需要 ${ex.needed} 點` : ex.message) } finally { setTakeBusy(false) }
  })
  const startTake = async (r: Row) => { video.current?.pause(); setTakeFor(r.line.key ?? null); if (!await recorder.start()) setTakeFor(null) }

  const apply = async () => {
    if (!info?.quick) { setErr('這支還沒有可以直接套用的版本，請先讓剪輯師重新輸出一次。'); return }
    if ((moved || st.drops.size) && !recut) { setErr('原始素材已超過保存期限（7 天），順序沒辦法再調；自己唸的句子還是可以套用。'); return }
    setApplying(true); setErr('')
    try {
      const e: QuickEdits = {}
      if (moved) e.order = st.order
      if (st.drops.size) e.shots = [...st.drops].map(i => ({ i, drop: true }))
      const ln = Object.entries(st.lines).map(([key, v]) => ({ key, ...v })); if (ln.length) e.lines = ln
      await api.quick(projectId, e); onUsage?.(); onDone?.(); onClose()
    } catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? '點數不足，先儲值再套用' : ex.message); setApplying(false) }
  }
  const cancel = () => { if (!applying) onClose() }   // ← 返回 keeps the edits (Chat holds them) so the sidebar and chat stay reachable

  return (
    <div className="pf-scrim" onClick={e => { if (e.target === e.currentTarget) cancel() }}>
      <div className="pf" role="dialog" aria-label="校對旁白">
        <SheetHead title="校對旁白" badge={version ? verLabel(version.version) : undefined} sub={changed ? '改了還沒套用 · 可先逐句聽，影片套用後才更新' : '聽一聽：改字、唸錯了，或拿掉'} onCancel={cancel} cancelLabel="← 返回"
          right={<button className="btn primary small" disabled={changed === 0 || applying} onClick={apply}>{applying ? '輸出中…' : '套用'}</button>} />
        <div className="pf-body">
          <div className="pf-video">
            {src ? <video ref={video} src={src} controls playsInline preload="metadata" poster={version?.poster ?? undefined} onTimeUpdate={onTime} onLoadedMetadata={onTime} />
              : <div className="pf-novideo muted small">這一版還沒有影片檔。</div>}
            {pv.on ? (
              <div className="pv-bar on" role="status" aria-live="polite"><i className="own-eq"><b /><b /><b /></i>
                <span>正在聽改好的第 {Math.max(1, keptRows.findIndex(r => r.line.key === pv.on) + 1)} 句 · 畫面是原本的，配音是新的</span><a onClick={pv.stop}>停</a></div>
            ) : changed > 0 ? (
              <div className="pv-bar"><i aria-hidden="true">ⓘ</i><span>改好的句子可以先按「聽改好的」；整支影片要按「套用修改」重新輸出後才會更新。{info?.say_points ? `生成新配音每句 ${info.say_points} 點，自己唸的免費。` : ''}</span></div>
            ) : null}
          </div>
          <ol className="pf-lines ez">
            {onOwnVoice && !loading && rows.length > 0 && (
              <li className="pf-own"><div><b><span className="pill rec">推薦</span> 換成你自己的聲音</b><span>親自一句一句配音，或讓 AI 生成你的聲音</span></div><button type="button" className="btn primary" onClick={onOwnVoice}>🎙 換成我的聲音</button></li>)}
            {loading && <li className="muted small pf-empty">載入旁白稿…</li>}
            {!loading && rows.length === 0 && <li className="muted small pf-empty">找不到這支的旁白稿，之後再來校對。</li>}
            {rows.map((r, i) => {
              const e = st.lines[r.line.key ?? ''] ?? {}; const drop = !!e.drop; const n = keptRows.indexOf(r) + 1
              const recHere = recorder.rec && takeFor === r.line.key
              return (
                <li key={r.line.n} className={`pf-line ez ${i === cur ? 'cur' : ''} ${e.take ? 'star' : ''} ${drop ? 'drop' : ''}`}>
                  <div className="pf-row" onClick={() => play(r)}>
                    {r.shot ? <img className="pf-thumb" src={api.frameUrl(projectId, r.shot.clip, r.shot.start)} alt="" /> : <span className="pf-thumb" />}
                    <a className="pf-tc"><b>{drop ? '✕' : n}</b><span>{tc(r.line.start)}</span></a>
                    <div className="pf-txt"><div className="pf-ez-text">{e.text ?? r.line.text}</div>
                      {e.text !== undefined && !drop && <em className="pf-badge ed">已改字</em>}{e.say !== undefined && !e.take && !drop && <em className="pf-badge say">唸法已改</em>}{e.take && !drop && <em className="pf-badge take">✓ 我親自唸的</em>}{drop && <em className="pf-badge drop">會拿掉</em>}
                    </div>
                  </div>
                  {editing === r.line.key && (
                    <div className="pf-editbox" onClick={ev => ev.stopPropagation()}>
                      <textarea rows={2} value={draft} autoFocus onChange={ev => setDraft(ev.target.value)} />
                      <div className="pf-editacts">
                        <button type="button" className="btn" onClick={() => setEditing(null)}>取消</button>
                        {e.text !== undefined && <button type="button" className="btn" onClick={() => { setText(r, r.line.text); setEditing(null) }}>還原原句</button>}
                        <button type="button" className="btn primary" onClick={() => { const t = draft.trim(); setText(r, t); setEditing(null); if (t && t !== (e.text ?? r.line.text)) hearNew(r, { text: t }) }}>改好了，聽聽看</button>
                      </div>
                    </div>)}
                  {recHere ? <RecBar r={recorder} hint="用你本人的聲音唸這一句" /> : (
                    <div className="pf-tools" onClick={ev => ev.stopPropagation()}>
                      {!drop && (e.text !== undefined || e.say !== undefined || e.take) ? <>
                        <button type="button" className={`pf-tb new ${pv.on === r.line.key ? 'on' : ''}`} disabled={hearing === r.line.key} onClick={() => (pv.on === r.line.key ? pv.stop() : hearNew(r))}><i>{hearing === r.line.key ? <span className="spinner" /> : pv.on === r.line.key ? <IcStop /> : <IcPlay />}</i>{hearing === r.line.key ? '生成中' : pv.on === r.line.key ? '停' : '聽改好的'}</button>
                        <button type="button" className="pf-tb quiet" onClick={() => play(r)}>聽原本的</button>
                      </> : !drop && <button type="button" className="pf-tb" onClick={() => play(r)}><i><IcPlay /></i>聽這句</button>}
                      {!drop && <>
                        <button type="button" className={`pf-tb ${e.text !== undefined ? 'on' : ''}`} onClick={() => { setDraft(e.text ?? r.line.text); setEditing(editing === r.line.key ? null : (r.line.key ?? null)) }}><i><IcPencil /></i>改字</button>
                        {!e.take && <button type="button" className={`pf-tb ${e.say !== undefined ? 'on' : ''}`} onClick={() => setFixing(r)}><i><IcSpeech /></i>唸錯了</button>}
                        {e.take && <button type="button" className="pf-tb on" disabled={recorder.rec || takeBusy} onClick={() => startTake(r)}><i><IcMic /></i>{takeBusy ? '處理中…' : '再唸一次'}</button>}
                      </>}
                      <button type="button" className={`pf-tb ${drop ? 'on' : ''}`} disabled={!drop && keptRows.length <= 1} onClick={() => toggleDrop(r)}><i>{drop ? <IcUndo /> : <IcMinus />}</i>{drop ? '還是要' : '拿掉'}</button>
                    </div>)}
                </li>)
            })}
            {onPro && !loading && <li className="pf-topro"><span>想逐句改字、調每段長度？</span><a onClick={onPro}>到導演模式細改 →</a></li>}
          </ol>
        </div>
        {fixing && <FixSay text={fixing.line.text} say={st.lines[fixing.line.key ?? '']?.say} projectId={projectId} voiceId={info?.voice_id ?? ''} onUsage={onUsage}
          onSay={s => { setSay(fixing, s); if (s) hearNew(fixing, { say: s }) }} onOwn={() => startTake(fixing)} onClose={() => setFixing(null)} />}
        {(err || recorder.err) && <div className="error small pf-err">{err || recorder.err}</div>}
        <div className="pf-foot">
          {past.current.length > 0 && !applying && <button type="button" className="btn small" onClick={undo}><IcUndo /> 復原</button>}
          <span className="muted small">{changed > 0 ? [nTexts && `改字 ${nTexts} 句`, nSays && `改唸法 ${nSays} 句`, nTakes && `親自唸 ${nTakes} 句`, nDrops && `拿掉 ${nDrops} 句`, moved && '換了順序'].filter(Boolean).join(' · ') + ' · 套用後重新輸出約 1–2 分鐘' : '唸得都對就不用改'}</span>
          <span className="spacer" />
          <button className="btn primary" disabled={changed === 0 || applying} onClick={apply}>{applying ? '重新輸出中…（約 1–2 分鐘）' : '套用修改 →'}</button>
        </div>
      </div>
    </div>
  )
}
