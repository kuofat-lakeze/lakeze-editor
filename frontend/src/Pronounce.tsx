import { useState } from 'react'
import { sayCached } from './preview'

/* 唸錯了: the simple way to fix an AI mispronunciation. Tap the wrong character(s), write how they should
   sound (a homophone: 重→蟲, 行→形), listen, confirm. The caption keeps the real words; only what the AI reads
   changes. If the AI still gets it wrong, the way out is 我親自唸這一句 (the owner's own recording for that
   line, fitted into its slot on the timeline). */
const PUNCT = /[\s，。、！？；：「」『』（）()!?,.:;…—-]/

export function FixSay({ text, say, projectId, voiceId, onSay, onOwn, onClose, onUsage }:
  { text: string; say?: string; projectId: string; voiceId: string; onSay: (say: string | undefined) => void; onOwn?: () => void; onClose: () => void; onUsage?: () => void }) {
  const chars = [...text]
  const [sel, setSel] = useState<number[]>([])
  const [rep, setRep] = useState('')
  const [playing, setPlaying] = useState(false)
  const [err, setErr] = useState('')
  const [audio] = useState(() => ({ a: null as HTMLAudioElement | null }))
  const tap = (i: number) => {
    if (PUNCT.test(chars[i])) return
    setSel(s => {
      if (s.includes(i)) return s.filter(x => x !== i)
      if (!s.length) return [i]
      const lo = Math.min(...s, i), hi = Math.max(...s, i)   // keep a contiguous run
      return Array.from({ length: hi - lo + 1 }, (_, k) => lo + k)
    })
    setRep('')
  }
  const picked = sel.length ? sel.map(i => chars[i]).join('') : ''
  const preview = sel.length && rep.trim() ? chars.map((c, i) => (i === sel[0] ? rep.trim() : sel.includes(i) ? '' : c)).join('') : (say ?? text)
  const changed = preview !== text
  const listen = async () => {
    if (playing) { audio.a?.pause(); setPlaying(false); return }
    setErr(''); setPlaying(true)
    try { const r = await sayCached(projectId, preview, voiceId); if (!r.cached) onUsage?.(); const a = new Audio(r.url); audio.a = a; a.onended = () => setPlaying(false); await a.play() }
    catch (x) { const ex = x as Error & { needed?: number }; setErr(ex.needed ? `點數不足：試聽要 ${ex.needed} 點` : ex.message); setPlaying(false) }
  }
  return (
    <div className="sh-scrim" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sh fix" role="dialog" aria-label="唸錯了">
        <div className="ideas-h"><b>哪個字唸錯了？</b><span className="muted small">點那個字，寫它該怎麼唸（同音字就好）。字幕不會變，只改 AI 怎麼唸。</span></div>
        <div className="fix-chars">{chars.map((c, i) => <button type="button" key={i} className={`fix-ch ${sel.includes(i) ? 'on' : ''} ${PUNCT.test(c) ? 'p' : ''}`} onClick={() => tap(i)}>{c}</button>)}</div>
        {!sel.length && !say && <div className="fix-coach">👆 先點上面唸錯的那個字</div>}
        {sel.length > 0 && (
          <label className="fix-rep"><span>「{picked}」要唸成</span>
            <input autoFocus value={rep} placeholder="寫同音字，例如 重→蟲、行→形、樂→月" onChange={e => setRep(e.target.value)} /></label>)}
        {say && !sel.length && <div className="muted small">目前的唸法：{say}</div>}
        {changed && <div className="fix-prev">AI 會唸成：<b>{preview}</b></div>}
        <div className="fix-acts">
          <button type="button" className="pf-tb" disabled={!changed} onClick={listen}><i>▶</i>{playing ? '停' : '試聽新唸法'}</button>
          <span className="spacer" />
          {say && <button type="button" className="btn" onClick={() => { onSay(undefined); onClose() }}>還原</button>}
          <button type="button" className="btn primary" disabled={!changed} onClick={() => { onSay(preview); onClose() }}>就這樣唸</button>
        </div>
        {err && <div className="error small">{err}</div>}
        {onOwn && <>
          <div className="fix-or"><span>AI 還是唸不對？</span></div>
          <button type="button" className="fix-own" onClick={() => { onClose(); onOwn() }}>
            <i className="fix-own-ic" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5a4 4 0 0 0 4 4zm7-4a7 7 0 0 1-14 0M12 18v3M8 21h8" /></svg></i>
            <span><b>我親自唸這一句</b><small>用你本人的聲音錄這句，自動對上影片的時間</small></span>
            <em aria-hidden="true">›</em>
          </button>
        </>}
        <a className="sh-cancel" onClick={onClose}>取消</a>
      </div>
    </div>
  )
}
