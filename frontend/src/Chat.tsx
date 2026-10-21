import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { api, verLabel, type Analysis, type Asset, type DeliverableVersion, type DriveCheck, type LineEdit, type Me, type Msg, type ProjectDetail, type Voice } from './api'
import { Proof } from './Proof'
import { OwnRead, type Take } from './OwnRead'
import { Timeline } from './Timeline'
import { Deliverables } from './Deliverables'
import { RecBar, useRecorder } from './Recorder'
import { IcClip, IcKeyboard, IcPencil } from './icons'
import { CAPTION_STYLES, CapPicker, FONTS, FontPicker, SUPER_STYLES, SuperPicker, StyleHint } from './captionStyles'
import { VoiceCloneDialog } from './VoiceClone'
import { CLOUD_SECS_PER_VIDEO, CloudDl, DropZone, PickGuide, needsPickGuide, MAX_FILES, MAX_FILE_BYTES, UploadQueue, fmtMB, type Up } from './Uploads'
import { fmtBytes } from './Storage'
import { ask } from './Dialog'
import { SCRIPT_BLOCK, ScriptCard, Teleprompter, VoiceSwapCtx, parseScript, type Line, type VoiceSwap } from './Script'

type Live = { text: string; thinking: string; tools: { name: string; status: 'run' | 'ok' | 'err'; seconds?: number; summary?: string; charged?: number; balance?: number; startedAt?: number }[] }
const fmtDur = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒` }
const emptyLive = (): Live => ({ text: '', thinking: '', tools: [] })
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
const IS_TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
/* Voice input: record with MediaRecorder (works in Chrome, Safari, iOS, LINE's browser), send the clip to
   /api/stt and paste the transcript. The Web Speech API was unreliable (silent failures, no Safari/Android
   support in many builds), so recognition happens server side. */
const CAN_REC = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
const MIC_MAX_SECONDS = 60
/* 用說的: the same recorder as everywhere else (level meter, clock, one stop button), then speech-to-text
   into the box. The composer swaps to the red recording strip while it runs, so the state is unmistakable. */
function useMic(onText: (t: string) => void, projectId: string, onError: (m: string) => void) {
  const [busy, setBusy] = useState(false)
  const r = useRecorder(async blob => {
    if (blob.size < 1000) return
    setBusy(true)
    try {
      const res = await api.stt(blob, projectId)
      if (res.text) onText(res.text); else onError('沒有聽到聲音，請靠近麥克風再說一次。')
    } catch (e) { onError((e as Error).message || '語音辨識失敗') } finally { setBusy(false) }
  })
  useEffect(() => { if (r.err) onError(r.err) }, [r.err]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (r.rec && r.secs >= MIC_MAX_SECONDS) r.stop() }, [r.rec, r.secs]) // eslint-disable-line react-hooks/exhaustive-deps
  const start = () => { if (!CAN_REC) { onError('這個瀏覽器不支援錄音，請改用 Safari 或 Chrome。'); return } r.start() }
  return { rec: r, on: r.rec, busy, seconds: r.secs, toggle: () => (r.rec ? r.stop() : !busy ? start() : undefined), available: CAN_REC }
}
/** 辨識中 strip: same shape as the recording strip, so the eye stays in one place. */
const SttBar = () => <div className="recbar busy" role="status" aria-live="polite"><span className="spinner" /><span className="recbar-lab"><b>辨識中</b><em>文字馬上出現</em></span></div>
const MicIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5a4 4 0 0 0 4 4zm7-4a7 7 0 0 1-14 0M12 18v3M8 21h8" />
  </svg>
)
const CRIOS = /CriOS|FxiOS|EdgiOS/.test(navigator.userAgent)  // third-party iOS browsers: file picker is flakier than Safari
type Stage = 'start' | 'working' | 'progress' | 'revise'
const PLACEHOLDER: Record<Stage, string> = {
  start: '貼雲端連結＋賣點、價格、語氣…',
  working: '剪輯師工作中，可以先輸入下一步想法…',
  progress: '回覆剪輯師，或說「照建議做」',
  revise: '直接說想怎麼改，例如「第 2 段換泳池、價格字再大」',
}
const CHIPS: Record<Stage, string[]> = {
  start: [], working: [],
  progress: ['照建議做', '先給我看分鏡', '旁白稿先給我看'],
  revise: ['時間軸細調', '換成我的聲音', '更多改法…'],
}
// The chip that is the default answer for a stage: shown as the main button, and sent when the box is empty.
const DEFAULT_CHIP: Partial<Record<Stage, string>> = { progress: '照建議做' }
const NO_VOICE = 'none'
const OB_STEPS = ['給素材', '解析素材', '風格與賣點']
// 輕鬆模式: two big answers per stage instead of five chips. `send` goes to the editor; `focus` opens the box; `files` opens 成品.
const EASY_CHIPS: Record<Stage, { label: string; send?: string; focus?: boolean; files?: boolean; proof?: boolean; own?: boolean; main?: boolean }[]> = {
  start: [], working: [],
  progress: [{ label: '好，就這樣 ✓', send: '照建議做', main: true }, { label: '要改一下', focus: true }],
  revise: [{ label: '很好，看成品 👍', files: true, main: true }, { label: '換成我的聲音 🎙', own: true }, { label: '旁白有唸錯', proof: true }, { label: '要改別的', focus: true }],
}
const EASY_SAVING_TWD = 2500 - 100 * 3.9   // 市場平均一支 vs 100 點; refined from /api/pricing when loaded
/** 輕鬆模式: the editor's reply as one conclusion line + the rest (shown behind 看細節). The editor is asked to put
    a 25-字 conclusion first and details after "---"; without the marker the first sentence is the conclusion. */
function splitConclusion(text: string): { head: string; rest: string } {
  const cut = text.search(/\n-{3,}\s*\n/)
  if (cut > 0) return { head: clean(text.slice(0, cut)), rest: text.slice(cut).replace(/^\s*-{3,}\s*/, '') }
  const lines = text.split('\n')
  const i = lines.findIndex(l => l.trim())
  if (i < 0) return { head: '', rest: text }
  let head = clean(lines[i])
  const m = head.match(/^(.{6,60}?[。！？!?])/)
  let rest = lines.slice(i + 1).join('\n')
  if (m && m[1].length < head.length) { rest = head.slice(m[1].length) + '\n' + rest; head = m[1] }
  else if (head.length > 60) { rest = head + '\n' + rest; head = head.slice(0, 40) + '…' }
  return { head, rest }
}
/** A selling point short enough for the phone preview: the part before the first comma, at most n characters. */
const shortPt = (s = '', n = 12) => {
  const head = s.split(/[，,、。；;]/)[0].trim()
  const t = head.length >= 2 ? head : s.trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
const clean = (s: string) => s.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, '').trim()
// 影片長度：travel short-form. 標準 is the default; each brief line goes into the first message.
const LENGTHS = [
  { id: 'short', name: '短版', secs: '12–20 秒', icon: '⚡', desc: '一個最強亮點＋優惠，最容易被看完。適合投廣告、限時優惠、限動。',
    brief: '長度：短版 12–20 秒（目標 15 秒），3–6 個鏡頭，只講最強賣點和優惠。' },
  { id: 'std', name: '標準', secs: '30–40 秒', icon: '★', tag: '預設', desc: '賣點、氛圍、價格一次講完。適合 Reels／抖音日常貼文。',
    brief: '長度：標準 30–40 秒（目標 36–37 秒）。' },
  { id: 'long', name: '完整導覽', secs: '45–60 秒', icon: '🧭', desc: '照入住動線走一圈：房型、設施、周邊。適合包棟、多房型、一日行程。',
    brief: '長度：完整導覽 45–60 秒（目標 50 秒，素材多再往 60 秒靠，不超過 60 秒），照入住動線分段導覽。' },
]
const ANALYZE_POINTS = 14   // = backend analyze.ANALYZE_POINTS (probe_footage)
const ROLE_LABEL: Record<string, string> = { hook: '開場', feature: '賣點', price: '價格', cta: '行動' }
const STAR_MAX = 3            // more than this and nothing is a highlight
const REWRITE = '\u0000rewrite'   // edits[n] marker: let the editor rewrite the line
// 還缺 helpers: information gaps vs footage gaps, the words a gap is looked up by, and the （價格）-style placeholders
const INFO_RE = /價格|價錢|費用|多少錢|套餐|菜單|店名|名稱|名字|地址|地點|位置|電話|營業|時間|訂房|訂位|連結|優惠|方案|房型|人數|日期/
const SYN: string[][] = [['價格', '價錢', '費用', '套餐', '多少錢'], ['店名', '名稱', '名字', '店家'], ['地址', '地點', '位置'], ['電話', '聯絡'], ['營業', '時間'], ['優惠', '方案', '折扣']]
const PLACE_RE = /（[^）]+）|\([^)]+\)/
const cleanMiss = (m: string) => m.replace(/^(補充?|建議補|請補|缺少?)/, '').replace(/[。，、\s]+$/, '').trim()
const missKeys = (m: string) => {
  const parts = m.split(/[與和、／/或及\s]+/).map(s => s.trim()).filter(k => k.length >= 2)
  const out = new Set(parts)
  for (const k of parts) for (const g of SYN) if (g.some(w => k.includes(w))) g.forEach(w => out.add(w))
  return [...out]
}
const bigrams = (s: string) => { const t = s.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, ''); const o: string[] = []; for (let i = 0; i + 2 <= t.length; i++) o.push(t.slice(i, i + 2)); return o }
type MissItem = { m: string; kind: 'info' | 'footage'; line: { n: number; text: string } | null; state: 'open' | 'line' | 'fill' | 'footage' | 'skip' }
const AN_PHASES = ['看每個畫面', '找出賣點', '排分鏡', '寫旁白稿', '估算點數']
const EXAMPLE_BRIEF = '宜蘭海邊的包棟民宿，25 米戲水池、龜山島海景、KTV、電動麻將、寵物友善。價格「平日每人 NT$1,500」。語氣輕鬆活潑，結尾請大家點連結查空房。'
const STYLES = [
  { id: 'travel', name: '旅遊短影音', tag: '預設', desc: '節奏快、前 3 秒就是最強賣點，每句旁白對一個畫面，口語活潑。',
    brief: '風格：旅遊短影音。節奏明快，Hook 放在前 3 秒（地點＋最強賣點），設施快剪每句對一個畫面，旁白口語有活力，配樂 upbeat（tropical house / pop，約 120 BPM），字幕放大重點詞，結尾 CTA 查空房。' },
  { id: 'premium', name: '質感形象', tag: '', desc: '慢節奏長鏡頭，旁白沉穩少字，像品牌形象片。',
    brief: '風格：質感形象片。節奏放慢、多用空拍與長鏡頭，旁白沉穩、句子短、留白多，配樂鋼琴或 lo-fi 氛圍，字幕精簡，Super title 強調店名與空間名稱，價格低調放在結尾。' },
  { id: 'promo', name: '促銷活動', tag: '', desc: '價格與優惠放最前面，倒數限時感，CTA 強。',
    brief: '風格：促銷活動。開頭 3 秒就講優惠與價格，價格用跳數強調，營造限時感（例如「只到月底」），CTA 出現兩次（中段＋結尾），配樂有力、節奏強，字幕用大字與對比色。' },
]
/* 導演模式「更多改法」: ready-made requests. Picking one drops it into the box (to edit or combine before
   sending) — the point is to show that any change can simply be asked for. `tool` opens a panel instead. */
type Idea = { l: string; send?: string; tool?: 'style' | 'timeline' }
const IDEAS: { t: string; items: Idea[] }[] = [
  { t: '風格', items: [
    ...STYLES.map(st => ({ l: `改成${st.name}`, send: `整支改成「${st.name}」風格重剪：${st.brief.replace(/^風格：[^。]*。/, '')}` })),
    { l: '節奏再快一點', send: '節奏再快一點，多剪幾刀，每個畫面短一點。' },
    { l: '節奏放慢', send: '節奏放慢，鏡頭停久一點，留點呼吸。' }] },
  { t: '字幕', items: [
    { l: '換字幕樣式、字型、大小', tool: 'style' },
    { l: '重點詞再放大', send: '重點詞的字幕再放大、更明顯。' },
    { l: '加店名／房型標題', send: '上方加上店名和房型的標題字（Super title）。' }] },
  { t: '畫面', items: [
    { l: '調每段長度（時間軸）', tool: 'timeline' },
    { l: '開頭換更吸睛的畫面', send: '開頭 3 秒換成最吸睛的畫面。' },
    { l: '多用空拍和戶外', send: '多用空拍和戶外的畫面，室內少一點。' },
    { l: '換一張封面畫面', send: '換一張封面畫面。' }] },
  { t: '旁白', items: [
    { l: '逐句改字、改唸法', tool: 'timeline' },
    { l: '更口語、更活潑', send: '旁白改得更口語、更活潑一點。' },
    { l: '旁白短一點', send: '旁白再精簡，每句短一點，留多一點畫面。' }] },
  { t: '配樂與長度', items: [
    { l: '配樂音量、旁白速度', tool: 'timeline' },
    { l: '換一首配樂', send: '換一首不同感覺的配樂。' },
    { l: '再剪一支短版', send: `再剪一支短版：${LENGTHS[0].brief}` },
    { l: '再剪一支完整導覽', send: `再剪一支完整導覽版：${LENGTHS[2].brief}` }] },
]
const EZ_STYLE_DESC: Record<string, string> = { travel: '活潑、快節奏', premium: '慢慢的、有質感', promo: '價格優惠放最前' }
const ClipIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21.4 11.05 12.2 20.25a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
)
/* One small icon per kind of work, so a glance at the step list says what the editor is doing. */
const TOOL_KIND: Record<string, string> = {
  list_drive_folder: 'drive', download_footage: 'drive', probe_footage: 'look', sample_frames: 'look',
  build_cut: 'cut', search_voices: 'voice', generate_voice: 'voice', generate_music: 'music', generate_sfx: 'music',
  preview_video: 'look', compose_audio: 'music', render_captions: 'text', export_video: 'export', make_cover: 'image', revision_turn: 'cut',
}
const ICON_PATH: Record<string, string> = {
  drive: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  look: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  cut: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12',
  voice: 'M12 15a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5a4 4 0 0 0 4 4zm7-4a7 7 0 0 1-14 0M12 18v3',
  music: 'M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  text: 'M4 6h16M4 12h10M4 18h7',
  export: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM10 9l5 3-5 3z',
  image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9h.01',
}
function ToolIcon({ name }: { name: string }) {
  const d = ICON_PATH[TOOL_KIND[name] ?? 'cut']
  return <span className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg></span>
}
const shortSummary = (s?: string) => {
  if (!s) return ''
  const t = s.replace(/\s+/g, ' ').trim()
  return /^[[{]/.test(t) || t.length < 4 ? '' : t.slice(0, 90)
}

const TOOL_LABEL: Record<string, string> = {
  list_drive_folder: '讀取 Drive 資料夾', download_footage: '下載素材', probe_footage: '分析素材',
  sample_frames: '放大檢視畫面', build_cut: '剪輯畫面', search_voices: '搜尋聲音', generate_voice: '生成旁白並核對',
  generate_music: '生成配樂', generate_sfx: '生成音效', preview_video: '做預覽', compose_audio: '混音',
  render_captions: '燒字幕', export_video: '輸出成品', make_cover: '做封面', revision_turn: '修改回合',
}

export function Chat({ projectId, name, easy = false, onUsage, onTopUp, onCredits, onStorage, onProjectsChanged, feedbackUnread = 0, onFeedbackRead, onMode }:
  { projectId: string; name?: string; easy?: boolean; onUsage: () => void; onTopUp: (needPoints?: number) => void; onCredits?: () => void; onStorage?: () => void; onProjectsChanged?: () => void; feedbackUnread?: number; onFeedbackRead?: () => void; onMode?: (m: 'easy' | 'pro') => void }) {
  const [tab, setTab] = useState<'chat' | 'files'>('chat')
  const [fbOpen, setFbOpen] = useState(false)
  const [prompter, setPrompter] = useState<Line[] | null>(null)
  const [reply, setReply] = useState('')
  const [replying, setReplying] = useState(false)
  const sendReply = async () => {
    const t = reply.trim(); if (!t || replying) return
    setReplying(true)
    try { const c = await api.replyComment(projectId, t); setProj(p => p && { ...p, client_comments: [...(p.client_comments ?? []), c] }); setReply('') }
    catch (e) { setErr((e as Error).message) } finally { setReplying(false) }
  }
  const openFeedback = async () => {
    setFbOpen(true)
    const p = await api.project(projectId); setProj(p)   // fresh list, then mark as seen
    if (p.client_comments?.some(c => !c.read)) { await api.markCommentsRead(projectId); onFeedbackRead?.(); setProj(x => x && { ...x, client_comments: x.client_comments?.map(c => ({ ...c, read: true })) }) }
  }
  const [proj, setProj] = useState<ProjectDetail | null>(null)
  useEffect(() => {   // a new export landed during this visit → 輕鬆模式 celebrates it
    const n = proj?.exports ?? null
    if (n === null) return
    if (prevExports.current !== null && n > prevExports.current && easy) setCheer(n)
    prevExports.current = n
  }, [proj?.exports]) // eslint-disable-line react-hooks/exhaustive-deps
  const [live, setLive] = useState<Live>(emptyLive())
  const [running, setRunning] = useState(false)
  const [text, setText] = useState('')
  const mic = useMic(t => setText(x => (x ? x.replace(/\s*$/, '') : '') + t), projectId, m => setErr(m))
  const [err, setErr] = useState('')
  const [needCredits, setNeedCredits] = useState<{ needed: number; balance: number } | null>(null)
  const [needStorage, setNeedStorage] = useState<{ used_bytes: number; quota_bytes: number } | null>(null)
  const [uploads, setUploads] = useState<Up[]>([])
  const prog = useRef<Record<string, { t: number; l: number; rate: number }>>({})
  const [picking, setPicking] = useState(false)
  const [pickFail, setPickFail] = useState(false)
  const [style, setStyle] = useState('travel')
  const [length, setLength] = useState('std')   // 影片長度，預設標準 30–40 秒
  // 主題: decided before the editor looks — 旅遊／住宿 (default) or a few words of the customer's own
  const [theme, setTheme] = useState<'travel' | 'custom'>('travel')
  const [themeText, setThemeText] = useState('')
  const themeLine = () => theme === 'custom' && themeText.trim() ? `主題：${themeText.trim()}` : '主題：旅遊／住宿（民宿、飯店、景點、行程）'
  const [obStep, setObStep] = useState(0)
  const [link, setLink] = useState('')
  const [drive, setDrive] = useState<{ state: 'idle' | 'checking' | 'ok' | 'err'; info?: DriveCheck; error?: string }>({ state: 'idle' })
  // Verify the folder as soon as a Drive link is pasted: shows what's inside, or why it can't be opened.
  useEffect(() => {
    const m = /^https?:\/\/\S+\.\S+/.test(link.trim())
    if (!m) { setDrive({ state: 'idle' }); return }
    let dead = false
    setDrive({ state: 'checking' })
    const t = setTimeout(() => {
      api.driveCheck(projectId, link.trim()).then(info => { if (!dead) setDrive({ state: 'ok', info }) }).catch(e => { if (!dead) setDrive({ state: 'err', error: (e as Error).message }) })
    }, 500)
    return () => { dead = true; clearTimeout(t) }
  }, [link, projectId])
  // 先解析素材 (wizard step 2): one call that returns selling points, storyboard, script and the estimate
  const [analyzing, setAnalyzing] = useState(false)
  const [anStart, setAnStart] = useState(0)
  const [anErr, setAnErr] = useState('')
  const [anNeed, setAnNeed] = useState<{ needed: number; balance: number } | null>(null)
  const [skipAn, setSkipAn] = useState(false)
  const [picked, setPicked] = useState<string[] | null>(null)   // selling points the user kept (null = all)
  // 調整 on the analysed plan: all one tap, compiled into the first message as 「調整：」 lines.
  const [extraPts, setExtraPts] = useState<string[]>([])            // selling points the user added
  const [addingPt, setAddingPt] = useState(false)
  const [newPt, setNewPt] = useState('')
  const [stars, setStars] = useState<number[]>([])                  // ⭐ shots (max STAR_MAX)
  const [drops, setDrops] = useState<number[]>([])                  // ✕ shots
  const [edits, setEdits] = useState<Record<number, string>>({})    // ✎ narration line: text, or REWRITE
  const [editing, setEditing] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [pins, setPins] = useState<number[]>([])                    // 📌 clips that must be used
  const [sheet, setSheet] = useState<number | null>(null)           // shot open in the bottom sheet
  const [cheer, setCheer] = useState<number | null>(null)           // 輕鬆模式: 影片完成 celebration (export count)
  const [proof, setProof] = useState<{ version: DeliverableVersion | null } | null>(null)   // 輕鬆模式: 校對旁白
  const [capStyle, setCapStyle] = useState<string>('gold')            // 導演模式: 字幕樣式 for the first cut
  const [font, setFont] = useState<string>('black')                   // 導演模式: 字型
  const [superStyle, setSuperStyle] = useState<string>('chip')        // 導演模式: 標題樣式
  const [moreStyle, setMoreStyle] = useState(false)                   // 字型與標題樣式 unfolded on step 3
  const [uqFold, setUqFold] = useState(false)                         // the upload list folds to one line once the editor has the files
  // 還缺: how each gap the analysis found gets resolved (see missItems below)
  const [fills, setFills] = useState<Record<string, string>>({})      // typed in directly (價格、店名…)
  const [skips, setSkips] = useState<string[]>([])                    // decided not to fill
  const [missFiles, setMissFiles] = useState<Record<string, number>>({})   // footage added for it after the analysis
  const [missOpen, setMissOpen] = useState<string | null>(null)       // the gap whose 直接填 box is open on the review step
  const [missBusy, setMissBusy] = useState<string | null>(null)       // the gap whose footage is uploading right now
  const missInput = useRef<HTMLInputElement>(null)
  const missFor = useRef('')
  const [timeline, setTimeline] = useState<{ version: DeliverableVersion | null; tab: 'tracks' | 'style' } | null>(null)   // 時間軸 (導演模式)
  const [voicePick, setVoicePick] = useState(false)                  // 換成我的聲音: 我親自一句一句配音 or AI 生成我的聲音
  const [ownRead, setOwnRead] = useState<DeliverableVersion | null | false>(false)   // 我親自配音 flow
  const carryTakes = useRef<Record<string, Take>>({})                // 我親自配音 takes kept across ← 返回
  const carry = useRef<Record<string, LineEdit>>({})                  // line edits (incl. the owner's takes) kept across 輕鬆 ⇄ 導演
  const [ideas, setIdeas] = useState(false)                            // 導演模式: 更多改法 sheet
  const [ownBusy, setOwnBusy] = useState(false)                        // re-voicing the video with the owner's voice
  const [vidVoice, setVidVoice] = useState<string | null>(null)        // the voice the latest version was narrated with
  const afterQuick = () => { reload(); onProjectsChanged?.(); onUsage(); setTab('files') }
  const openProof = async (version?: DeliverableVersion) => {
    let v = version ?? null
    if (!v) { try { v = (await api.deliverables(projectId)).versions[0] ?? null } catch { v = null } }
    setProof({ version: v })
  }
  const openTimeline = async (tab: 'tracks' | 'style' = 'tracks', version?: DeliverableVersion | null) => {
    let v = version ?? null
    if (!v) { try { v = (await api.deliverables(projectId)).versions[0] ?? null } catch { v = null } }
    setTimeline({ version: v, tab })
  }
  // 輕鬆 ⇄ 導演 while editing: the open panel changes shape but keeps the line edits and the owner's takes.
  useEffect(() => {
    if (easy && timeline) { setTimeline(null); setProof({ version: timeline.version }) }
    if (!easy && proof) { setProof(null); setTimeline({ version: proof.version, tab: 'tracks' }) }
  }, [easy]) // eslint-disable-line react-hooks/exhaustive-deps
  // The wizard's choices survive a reload or a mode switch.
  const draftKey = `lk_draft_${projectId}`
  useEffect(() => {
    try { const d = JSON.parse(sessionStorage.getItem(draftKey) || 'null'); if (d) { if (d.text) setText(d.text); if (d.style) setStyle(d.style); if (d.length) setLength(d.length); if (d.theme) setTheme(d.theme); if (d.themeText) setThemeText(d.themeText); if (d.capStyle) setCapStyle(d.capStyle); if (d.font) setFont(d.font); if (d.superStyle) setSuperStyle(d.superStyle); if (d.link) setLink(d.link) } } catch { /* ignore */ }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!proj || proj.messages.length) return
    try { sessionStorage.setItem(draftKey, JSON.stringify({ text, style, length, theme, themeText, capStyle, font, superStyle, link })) } catch { /* ignore */ }
  }, [text, style, length, theme, themeText, capStyle, font, superStyle, link]) // eslint-disable-line react-hooks/exhaustive-deps
  const prevExports = useRef<number | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [voices, setVoices] = useState<Voice[]>([])
  const [voice, setVoice] = useState<string | null>(null)   // voice_id, NO_VOICE, or null = not loaded yet
  const [me, setMe] = useState<Me | null>(null)
  const [cloning, setCloning] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const uploading = uploads.some(u => u.status === 'wait' || u.status === 'up')
  const bottom = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const liveAssets = useRef<Asset[]>([])
  // Only follow new content while the reader is already at the bottom. If they scrolled up to read,
  // leave them alone and offer a "jump to latest" button instead.
  const atBottom = useRef(true)
  const [unseen, setUnseen] = useState(false)
  const firstLoad = useRef(true)
  // Elapsed-time display while the editor works (like Claude's "running… 1m 23s").
  const turnStart = useRef<number | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running && !analyzing) { turnStart.current = null; return }
    if (running && !turnStart.current) turnStart.current = Date.now()
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running, analyzing])

  const reload = () => api.project(projectId).then(p => {
    setProj(p); setRunning(p.running)
    if (p.running) {
      const lastUser = [...p.messages].reverse().find(m => m.role === 'user')
      const t = lastUser ? Date.parse(lastUser.created_at.endsWith('Z') || lastUser.created_at.includes('+') ? lastUser.created_at : lastUser.created_at + 'Z') : NaN
      if (!turnStart.current && !isNaN(t)) turnStart.current = t
      listen()
    }
  })
  useEffect(() => { reload() }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!proj) return
    if (firstLoad.current) { firstLoad.current = false; if (proj.messages.length) bottom.current?.scrollIntoView(); return }
    if (atBottom.current) bottom.current?.scrollIntoView({ behavior: 'smooth' }); else setUnseen(true)
  }, [proj, live])
  useEffect(() => {
    if (!proj) return
    // The wizard picks a default voice; in a running project the list feeds 旁白稿 → 換一個聲音.
    const fresh = proj.messages.length === 0
    api.voices().then(vs => { setVoices(vs); if (fresh) setVoice(v => v ?? (easy ? vs.find(x => !x.custom) : vs[0])?.voice_id ?? NO_VOICE) }).catch(() => { if (fresh) setVoice(NO_VOICE) })
    if (fresh) api.me().then(setMe).catch(() => {})
  }, [proj?.id, proj?.messages.length === 0]) // eslint-disable-line react-hooks/exhaustive-deps
  const recloneForScript = useRef(false)   // the clone was (re)recorded from a 旁白稿 card: re-voice with it
  const recloneQuick = useRef(false)   // cloned from the 校對台: re-voice the finished video with the new voice via 微調
  const onCloned = (v: Voice) => {
    setCloning(false)
    setVoices(vs => [v, ...vs.filter(x => !x.custom)]); setVoice(v.voice_id)
    api.me().then(setMe).catch(() => {})
    if (recloneQuick.current) {
      recloneQuick.current = false
      setOwnBusy(true)
      api.quick(projectId, { voice_id: v.voice_id }).then(() => { setVidVoice(v.voice_id); afterQuick() }).finally(() => setOwnBusy(false)).catch(() => submit(`旁白改用我的聲音「${v.name}」（voice_id ${v.voice_id}）重新生成，稿子、秒數和其他都不變，配好後重新輸出影片。`))
      return
    }
    if (recloneForScript.current) {
      recloneForScript.current = false
      submit(`我重新錄了自己的聲音。旁白改用我的聲音「${v.name}」（voice_id ${v.voice_id}）重新生成，稿子、秒數和其他都不變，配好後重新輸出影片。`)
    }
  }
  // 換成我的聲音: re-voice the finished video with the owner's cloned voice via 微調 (record one first if needed).
  const ownVoice = voices.find(v => v.custom)
  const usedOwn = !!ownVoice && vidVoice === ownVoice.voice_id
  const exportsN = proj?.credits.exports ?? 0
  useEffect(() => { if (exportsN > 0) api.script(projectId).then(r => setVidVoice(r.voice_id || null)).catch(() => {}) }, [exportsN, projectId])
  const switchToOwnVoice = () => setVoicePick(true)
  const openOwnRead = async () => { setVoicePick(false); let v: DeliverableVersion | null = null; try { v = (await api.deliverables(projectId)).versions[0] ?? null } catch { v = null } setOwnRead(v) }
  // AI 生成我的聲音: re-voice the finished video with the cloned voice (record the 30-second sample first if needed)
  const useAiVoice = async () => {
    setVoicePick(false)
    if (!ownVoice) { recloneQuick.current = true; setCloning(true); return }
    setOwnBusy(true)
    try { await api.quick(projectId, { voice_id: ownVoice.voice_id }); setVidVoice(ownVoice.voice_id); afterQuick() }
    catch (e) {
      const ex = e as Error & { needed?: number }
      if (ex.needed) onTopUp(ex.needed)
      else submit(`旁白改用我的聲音「${ownVoice.name}」（voice_id ${ownVoice.voice_id}）重新生成，稿子、秒數和其他都不變，配好後重新輸出影片。`)
    } finally { setOwnBusy(false) }
  }
  const pickIdea = (it: Idea) => {
    setIdeas(false)
    if (it.tool === 'style') return void openTimeline('style')
    if (it.tool === 'timeline') return void openTimeline()
    setText(t => (t.trim() ? t.replace(/\s*$/, '\n') : '') + (it.send ?? ''))
    setTimeout(() => taRef.current?.focus(), 50)
  }
  // ▶ plays a voice's preview; the cloned voice also has the original recording (key `${id}:sample`).
  const preview = (v: Voice, which: 'preview' | 'sample' = 'preview') => {
    const url = which === 'sample' ? v.sample_url : v.preview_url
    const key = which === 'sample' ? `${v.voice_id}:sample` : v.voice_id
    if (!url) return
    if (playing === key) { audioRef.current?.pause(); setPlaying(null); return }
    audioRef.current?.pause()
    const a = new Audio(url); audioRef.current = a; setPlaying(key)
    a.onended = () => setPlaying(null); a.play().catch(() => setPlaying(null))
  }
  // Coming back from the 成品 tab remounts the thread at the top: jump to the latest message.
  useEffect(() => {
    if (tab !== 'chat') return
    const id = requestAnimationFrame(() => { bottom.current?.scrollIntoView(); atBottom.current = true; setUnseen(false) })
    return () => cancelAnimationFrame(id)
  }, [tab])
  const onScroll = () => {
    const el = threadRef.current; if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (atBottom.current) setUnseen(false)
  }
  const jump = () => { atBottom.current = true; setUnseen(false); bottom.current?.scrollIntoView({ behavior: 'smooth' }) }

  // The stream endpoint replays the whole turn on every connect, so (re)connecting always starts
  // from an empty live state. Railway's edge closes any HTTP request after 15 minutes, and phones
  // drop connections when the screen locks; both just mean "connect again", the turn keeps running
  // on the server.
  const retries = useRef(0)
  function listen() {
    setRunning(true)
    setLive(emptyLive()); liveAssets.current = []
    const es = new EventSource(`/api/projects/${projectId}/stream`)
    es.onmessage = e => {
      retries.current = 0
      const ev = JSON.parse(e.data)
      switch (ev.type) {
        case 'text': setLive(l => ({ ...l, text: l.text + ev.text })); break
        case 'thinking': setLive(l => ({ ...l, thinking: (l.thinking + ev.text).slice(-600) })); break
        case 'tool_run': setLive(l => ({ ...l, tools: [...l.tools, { name: ev.name, status: 'run', startedAt: Date.now() }] })); break
        case 'tool_end': setLive(l => {
          const tools = [...l.tools]; const i = tools.map(t => t.name).lastIndexOf(ev.name)
          if (i >= 0) tools[i] = { ...tools[i], status: ev.ok ? 'ok' : 'err', seconds: ev.seconds, summary: ev.summary }
          return { ...l, tools }
        }); break
        case 'asset': liveAssets.current.push(ev.asset); setLive(l => ({ ...l })); break
        case 'credits': onUsage(); setLive(l => {  // attach the charge to the running tool so the thread shows "−3 點"
          const tools = [...l.tools]; const i = tools.map(t => t.name).lastIndexOf(ev.tool)
          if (i >= 0) tools[i] = { ...tools[i], charged: ev.charged, balance: ev.balance }
          return { ...l, tools }
        }); break
        case 'need_credits': setNeedCredits({ needed: ev.needed, balance: ev.balance }); break
        case 'need_storage': setNeedStorage({ used_bytes: ev.used_bytes, quota_bytes: ev.quota_bytes }); break
        case 'error': setErr(ev.message); break
        case 'idle': es.close(); setRunning(false); break
        case 'done': es.close(); setRunning(false); setLive(emptyLive()); liveAssets.current = []; reload(); onUsage(); break
      }
    }
    es.onerror = () => {
      es.close()
      if (retries.current < 30) { const n = ++retries.current; setTimeout(listen, Math.min(n, 5) * 2000); return }
      retries.current = 0; setRunning(false); reload()
    }
  }

  const okUploads = uploads.filter(u => u.status === 'ok').length
  const linkOk = drive.state === 'ok' && (drive.info?.media ?? 0) > 0
  const analysis = proj?.analysis ?? null
  const hasFootage = linkOk || okUploads > 0 || !!analysis
  const ezBrief = easy && !!analysis   // 輕鬆模式 with an analysis: no text box, the brief is the kept selling points + the fills
  const briefText = () => {
    if (!ezBrief) return text.trim()
    return [`賣點：${pickedPoints.join('、')}`, ...missLines()].join('\n')
  }
  const canStart = hasFootage && (ezBrief || text.trim().length > 0) && !uploading && voice !== null
  const obDone = [hasFootage, !!analysis || skipAn, (ezBrief || text.trim().length > 0) && voice !== null]
  const start = async () => {
    if (!canStart || running) return
    const st = STYLES.find(x => x.id === style) ?? STYLES[0]
    const v = voices.find(x => x.voice_id === voice)
    const len = LENGTHS.find(x => x.id === length) ?? LENGTHS[1]
    const parts = [
      themeLine(),
      analysis ? `素材已上傳並解析過（${analysis.n_clips} 個）。` : linkOk ? `素材在這個雲端分享連結（${drive.info?.label}）：${link.trim()} 。請用 list_drive_folder 讀取再下載。` : `我上傳了 ${okUploads} 支素材。`,
      briefText(),
      st.brief,
      len.brief,
      !easy ? `字幕樣式：${capStyle}（${CAPTION_STYLES.find(c => c.id === capStyle)?.name ?? ''}）` : '',
      !easy && font !== 'black' ? `字型：${font}（${FONTS.find(c => c.id === font)?.name ?? ''}）` : '',
      !easy && superStyle !== 'chip' ? `標題樣式：${superStyle}（${SUPER_STYLES.find(c => c.id === superStyle)?.name ?? ''}）` : '',
      ...adjustLines(),
      ...(ezBrief ? [] : missLines().filter(l => !text.includes(l))),   // 導演模式: the gaps resolved outside the text box (素材、不補)
      voice === NO_VOICE ? '不要配音：只要配樂和字幕，賣點用字幕呈現。'
        : v ? `旁白用 ${v.name}（voice_id ${v.voice_id}），直接做到輸出影片和封面，不用再問我選聲音或確認稿子。` : '',
    ]
    api.clientLog('start_project', { style: st.id, length: len.id, theme, adjust: nAdjust, voice, link: linkOk, uploads: okUploads, analysis: !!analysis })
    try { sessionStorage.removeItem(draftKey) } catch { /* ignore */ }
    await submit(parts.filter(Boolean).join('\n'), !!analysis)
  }
  const runAnalyze = async () => {
    if (analyzing || running) return
    setAnalyzing(true); setAnErr(''); setAnNeed(null); setAnStart(Date.now())
    api.clientLog('analyze_start', { link: linkOk && !okUploads, uploads: okUploads })
    try {
      const a = await api.analyze(projectId, { brief: [themeLine(), text.trim()].filter(Boolean).join('\n'), drive_url: linkOk && !okUploads ? link.trim() : '' })
      atBottom.current = false   // land on the selling points, not the bottom of the card
      setProj(p => p && { ...p, analysis: a }); setPicked(null); setSkipAn(false); setFills({}); setSkips([]); setMissFiles({}); setMissOpen(null)
      onUsage()
      setTimeout(() => { threadRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); setUnseen(false) }, 60)
    } catch (e) {
      const ex = e as Error & { needed?: number; balance?: number }
      if (ex.needed) setAnNeed({ needed: ex.needed, balance: ex.balance ?? 0 }); else setAnErr(ex.message)
    } finally { setAnalyzing(false) }
  }
  const goStep = (i: number) => { setObStep(i); requestAnimationFrame(() => threadRef.current?.scrollTo({ top: 0 })) }
  const pickedPoints = analysis ? (picked ?? analysis.selling_points) : []
  const togglePoint = (s: string) => setPicked(p => { const cur = p ?? analysis?.selling_points ?? []; return cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s] })
  const toggleIn = (set: (f: (a: number[]) => number[]) => void, n: number) => set(a => a.includes(n) ? a.filter(x => x !== n) : [...a, n])
  const addPoint = () => { const t = newPt.trim(); if (t && !extraPts.includes(t)) { setExtraPts(a => [...a, t]); setPicked(p => [...(p ?? analysis?.selling_points ?? []), t]) } setNewPt(''); setAddingPt(false) }
  const usedClips = new Set((analysis?.storyboard ?? []).map(s => s.clip))
  const nAdjust = extraPts.length + stars.length + drops.length + Object.keys(edits).length + pins.length
  const resetAdjust = () => { setExtraPts([]); setStars([]); setDrops([]); setEdits({}); setPins([]); setEditing(null) }
  const adjustLines = (): string[] => {
    if (!analysis) return []
    const shot = (n: number) => analysis.storyboard.find(x => x.n === n)
    const out: string[] = []
    for (const n of stars) { const x = shot(n); if (x && !drops.includes(n)) out.push(`調整：第 ${n} 段（#${String(x.clip).padStart(2, '0')} ${x.shot}）是重點，多講一句、鏡頭多停 1–2 秒、字幕放大。`) }
    for (const n of drops) { const x = shot(n); if (x) out.push(`調整：不要第 ${n} 段（#${String(x.clip).padStart(2, '0')} ${x.shot}），用其他素材補時長。`) }
    for (const [k, v] of Object.entries(edits)) { const n = Number(k); if (drops.includes(n)) continue; out.push(v === REWRITE ? `調整：第 ${n} 段的旁白請重寫一句。` : `調整：第 ${n} 段的旁白改成「${v}」，照這句念（數字可改國字）。`) }
    for (const c of pins) { const cl = analysis.clips.find(x => x.n === c); out.push(`調整：素材 #${String(c).padStart(2, '0')}${cl ? `（${cl.photo ? '照片' : `${Math.round(cl.dur)} 秒影片`}）` : ''} 一定要用，請排進分鏡。`) }
    return out
  }
  // ---- 還缺 ---------------------------------------------------------------------------------
  // One model for the gaps the analysis found, shared by the review step and the easy-mode brief. Each gap
  // is an information gap (店名、價格…) or a footage gap (外觀、夜景…) and is resolved one of four ways:
  // editing the narration line that waits for it, typing it in, adding footage for it, or deciding not
  // to fill it. A gap that belongs only to a selling point the user un-ticked disappears with it.
  const missLine = (m: string) => {
    if (!analysis) return null
    const keys = missKeys(m)
    const hit = (t: string) => keys.some(k => t.includes(k))
    // the line with a （價格）-style placeholder for it first, then any line that mentions it — never a random placeholder
    return analysis.script.find(l => { const ph = l.text.match(PLACE_RE)?.[0]; return !!ph && hit(ph) }) ?? analysis.script.find(l => hit(l.text)) ?? null
  }
  const missItems = (): MissItem[] => {
    if (!analysis) return []
    const dropped = analysis.selling_points.filter(s => !pickedPoints.includes(s))
    const out: MissItem[] = []
    for (const raw of analysis.missing) {
      const m = cleanMiss(raw)
      if (!m || out.some(x => x.m === m)) continue
      if (dropped.some(s => bigrams(s).some(b => m.includes(b)))) continue   // only there for a selling point that is gone
      const kind: MissItem['kind'] = INFO_RE.test(m) ? 'info' : 'footage'
      const line = kind === 'info' ? missLine(m) : null
      const ed = line ? edits[line.n] : undefined
      const state: MissItem['state'] = fills[m]?.trim() ? 'fill' : (missFiles[m] ?? 0) > 0 ? 'footage'
        : line && ed !== undefined && ed !== REWRITE && !drops.includes(line.n) ? 'line' : skips.includes(m) ? 'skip' : 'open'
      out.push({ m, kind, line, state })
    }
    return out
  }
  const missGone = () => analysis ? [...new Set(analysis.missing.map(cleanMiss))].filter(m => m && !missItems().some(x => x.m === m)) : []
  // what the editor is told about them (the edited narration lines travel separately, see adjustLines)
  const missLines = (): string[] => missItems().flatMap(it =>
    it.state === 'fill' ? [`${it.m}：${fills[it.m].trim()}`]
      : it.state === 'footage' ? [`補充素材：為了「${it.m}」在解析之後又上傳了 ${missFiles[it.m]} 個素材，請一併看過並用上。`]
        : it.state === 'skip' ? [`「${it.m}」先不補，照現有素材做。`] : [])
  // 改那句旁白 → the line opened for editing, scrolled into view. A gap with no line gets the 直接填 box instead.
  const jumpMissing = (it: MissItem) => {
    const line = it.line
    if (!line) { setMissOpen(it.m); return }
    setEditText(edits[line.n] && edits[line.n] !== REWRITE ? edits[line.n] : line.text); setEditing(line.n); setSheet(null)
    setTimeout(() => threadRef.current?.querySelector(`[data-n="${line.n}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50)
  }
  const skipMiss = (m: string, on: boolean) => { setSkips(s => on ? [...new Set([...s, m])] : s.filter(x => x !== m)); if (on) { setMissOpen(o => (o === m ? null : o)); setFills(f => { const c = { ...f }; delete c[m]; return c }) } }
  const addFootage = (m: string) => { missFor.current = m; missInput.current?.click() }
  const onMissFiles = async (files: FileList | null) => {
    const m = missFor.current; if (!m || !files?.length) return
    setMissBusy(m); skipMiss(m, false)
    const ok = await onFiles(files)
    setMissBusy(null)
    if (ok) setMissFiles(f => ({ ...f, [m]: (f[m] ?? 0) + ok }))
  }
  // Step 2 → 3: the kept selling points become the brief (the user can still edit it).
  const useAnalysis = () => {
    if (easy) { goStep(2); return }
    if (analysis && !text.trim()) {
      const items = missItems()
      const filled = items.filter(i => i.state === 'fill').map(i => `${i.m}：${fills[i.m].trim()}`)
      const open = items.filter(i => i.kind === 'info' && i.state === 'open').map(i => `${i.m}：`)
      setText([`賣點：${pickedPoints.join('、')}`, ...filled, ...open].join('\n'))
    } else if (analysis && extraPts.length && !extraPts.every(x => text.includes(x))) {
      setText(t => t.replace(/\s*$/, '\n') + `也要講：${extraPts.filter(x => !text.includes(x)).join('、')}`)
    }
    goStep(2)
  }
  // The 還缺 rows: on the review step (both modes) and again as 還要補的 on the easy-mode brief step.
  const renderMiss = (brief: boolean) => {
    if (!analysis) return null
    const items = missItems(), gone = missGone()
    if (!items.length && !gone.length) return null
    const open = items.filter(i => i.state === 'open')
    const hint = (m: string) => /價格|價錢|費用|套餐/.test(m) ? '例：平日每人 1,500' : /店名|名稱/.test(m) ? '例：雲岫海景會館' : /地點|地址/.test(m) ? '例：宜蘭頭城' : /電話/.test(m) ? '例：03-123-4567' : /營業|時間/.test(m) ? '例：11:00–21:00' : ''
    const label = (it: MissItem) => it.state === 'line' ? `✓ 已改第 ${it.line!.n} 句` : it.state === 'fill' ? (brief ? '✓ 已填' : `✓ 已填：${fills[it.m].trim()}`) : it.state === 'footage' ? `✓ 加了 ${missFiles[it.m]} 個素材` : it.state === 'skip' ? '先不補' : ''
    return (
      <div className={`an-sec miss ${brief ? 'ez-miss' : ''}`}>
        <div className="miss-h"><b>{brief ? '還要補的' : '還缺'}</b>
          <span className="muted small">{!items.length ? '都齊了' : !open.length ? '都處理好了' : brief ? '補了影片更完整，也可以先不補' : '改那句旁白、直接填或補素材，也可以先不補'}</span>
          {open.length > 1 && <a className="small" onClick={() => open.forEach(i => skipMiss(i.m, true))}>全部先不補</a>}
        </div>
        {items.map(it => {
          const boxOpen = it.kind === 'info' && it.state !== 'skip' && it.state !== 'line' && (brief || missOpen === it.m)
          return (
            <div key={it.m} className={`miss-row ${it.state} ${it.kind}`}>
              <div className="miss-top">
                <i className="miss-ic" aria-hidden="true">{it.kind === 'info' ? 'ℹ︎' : '🎬'}</i><b>{it.m}</b>
                {it.state !== 'open' && <em className={`miss-badge ${it.state === 'skip' ? '' : 'ok'}`}>{label(it)}</em>}
                {missBusy === it.m && <em className="miss-badge wait"><span className="spinner" />上傳中</em>}
                <span className="spacer" />
                {it.state === 'skip' && <a className="small" onClick={() => skipMiss(it.m, false)}>還是要補</a>}
                {it.state === 'line' && <a className="small" onClick={() => (brief ? (goStep(1), setTimeout(() => jumpMissing(it), 80)) : jumpMissing(it))}>再改</a>}
                {it.state === 'fill' && !brief && missOpen !== it.m && <a className="small" onClick={() => setMissOpen(it.m)}>改</a>}
                {it.state === 'footage' && missBusy !== it.m && <a className="small" onClick={() => addFootage(it.m)}>再加</a>}
              </div>
              {boxOpen && (
                <div className="miss-in">
                  <input value={fills[it.m] ?? ''} placeholder={hint(it.m) || `寫在這裡`} autoFocus={!brief && missOpen === it.m && !fills[it.m]} inputMode={/價格|價錢|費用|電話/.test(it.m) ? 'text' : undefined}
                    onChange={e => setFills(f => ({ ...f, [it.m]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { (e.target as HTMLInputElement).blur(); setMissOpen(null) } }} />
                  {!brief && <button type="button" className="btn small primary" onClick={() => setMissOpen(null)}>好了</button>}
                </div>
              )}
              {it.state === 'open' && missBusy !== it.m && (
                <div className="miss-acts">
                  {it.kind === 'info' && it.line && <button type="button" className="pf-tb" onClick={() => (brief ? (goStep(1), setTimeout(() => jumpMissing(it), 80)) : jumpMissing(it))}><i><IcPencil /></i>改那句旁白</button>}
                  {it.kind === 'info' && !brief && !boxOpen && <button type="button" className="pf-tb" onClick={() => setMissOpen(it.m)}><i><IcKeyboard /></i>直接填</button>}
                  {it.kind === 'footage' && <button type="button" className="pf-tb" onClick={() => addFootage(it.m)}><i><IcClip /></i>補上傳素材</button>}
                  <button type="button" className="pf-tb quiet" onClick={() => skipMiss(it.m, true)}>先不補</button>
                </div>
              )}
            </div>)
        })}
        {gone.length > 0 && <div className="muted small miss-gone">跟著拿掉的賣點一起略過：{gone.join('、')}</div>}
        <input ref={missInput} type="file" multiple accept="video/*,image/*,.mp4,.mov,.m4v,.jpg,.jpeg,.png,.webp,.heic" hidden onChange={e => { onMissFiles(e.target.files); e.target.value = '' }} />
      </div>
    )
  }
  const copyScript = () => { if (analysis) navigator.clipboard?.writeText(analysis.script.map(l => l.text).join('\n')).catch(() => {}) }
  const stageNow = (): Stage => !proj ? 'start' : running ? 'working' : proj.messages.length === 0 ? 'start' : proj.credits.exports > 0 ? 'revise' : 'progress'
  const send = async () => {
    const t = text.trim() || DEFAULT_CHIP[stageNow()] || ''   // empty box: the stage's default answer (照建議做)
    if (!t || running) return
    await submit(t)
  }
  const submit = async (t: string, withAnalysis = false) => {
    setErr(''); setText(''); setNeedCredits(null); setNeedStorage(null); atBottom.current = true; turnStart.current = Date.now()
    if (uploads.length && uploads.every(u => u.status === 'ok')) setUqFold(true)
    setProj(p => p && { ...p, messages: [...p.messages, { id: 'tmp', role: 'user', parts: [{ type: 'text', text: t }], created_at: '' }] })
    try { await api.send(projectId, t, withAnalysis ? { with_analysis: true } : {}); setLive(emptyLive()); listen() } catch (e) { setErr((e as Error).message) }
  }

  const patchUp = (id: string, u: Partial<Up>) => setUploads(us => us.map(x => (x.id === id ? { ...x, ...u } : x)))
  const runUpload = async (up: Up) => {
    patchUp(up.id, { status: 'up', loaded: 0, error: undefined, rate: undefined })
    prog.current[up.id] = { t: Date.now(), l: 0, rate: 0 }
    const t0 = Date.now()
    try {
      const server = await api.uploadOne(projectId, up.file, loaded => {
        const pr = prog.current[up.id]; const now = Date.now(); const dt = (now - pr.t) / 1000
        if (dt >= 0.5) { const inst = (loaded - pr.l) / dt; pr.rate = pr.rate ? pr.rate * 0.7 + inst * 0.3 : inst; pr.t = now; pr.l = loaded }
        patchUp(up.id, { loaded, rate: pr.rate || undefined })
      })
      patchUp(up.id, { status: 'ok', loaded: up.size, server })
      api.clientLog('upload_ok', { name: up.name, size: up.size, seconds: (Date.now() - t0) / 1000 })
      return true
    } catch (e) {
      const msg = (e as Error).message
      patchUp(up.id, { status: 'err', error: msg })
      api.clientLog('upload_err', { name: up.name, size: up.size, seconds: (Date.now() - t0) / 1000, error: msg })
      return false
    }
  }
  const onFiles = async (files: FileList | File[] | null): Promise<number> => {
    setPicking(false); setPickFail(false); setPickBack(false)
    const list = Array.from(files ?? [])
    api.clientLog('files_selected', { n: list.length, files: list.map(f => ({ name: f.name, size: f.size, type: f.type })) })
    if (!list.length) return 0
    setErr('')
    if (list.length > MAX_FILES) { setErr(`素材超過 ${MAX_FILES} 個：建議放進雲端資料夾（Google 雲端、Dropbox、iCloud），把分享連結貼在下面就好，不用一個個傳。這次先傳前 ${MAX_FILES} 個。`); list.splice(MAX_FILES) }
    const ups: Up[] = list.map(f => ({ id: Math.random().toString(36).slice(2, 10), file: f, name: f.name || 'clip.mp4', size: f.size, loaded: 0,
      status: f.size > MAX_FILE_BYTES ? 'err' : 'wait', error: f.size > MAX_FILE_BYTES ? `超過 1 GB 上限（${fmtMB(f.size)}），請先壓縮，或放到 Google Drive 貼連結` : undefined }))
    setUploads(us => [...us, ...ups])
    let ok = 0
    for (const up of ups) {
      if (up.status === 'err') { api.clientLog('upload_skipped_too_large', { name: up.name, size: up.size }); continue }
      if (await runUpload(up)) ok++
    }
    if (ok && proj && proj.messages.length > 0) setText(t => t || `我上傳了 ${ok} 支素材，請先分析。`)
    return ok
  }
  const retryUpload = (id: string) => setUploads(us => { const u = us.find(x => x.id === id); if (u) queueMicrotask(() => { runUpload(u) }); return us })
  const removeUpload = (id: string) => setUploads(us => us.filter(u => u.id !== id))
  // A finished upload the user no longer wants: delete it on the server too. Clip numbers shift, so any
  // 先解析 result is dropped and the next analysis / probe starts from the files that are left.
  const deleteUpload = async (id: string) => {
    const u = uploads.find(x => x.id === id); if (!u?.server) return
    if (running) { setErr('剪輯師正在工作，等這一輪結束再刪素材。'); return }
    const msg = `刪掉「${u.name}」？${analysis ? '\n刪掉後要重新解析一次素材（不用重新上傳其他的）。' : ''}`
    if (!await ask.confirm(msg, { ok: '刪掉', danger: true })) return
    patchUp(id, { status: 'del' })
    try {
      await api.deleteUpload(projectId, u.server)
      setUploads(us => us.filter(x => x.id !== id))
      if (analysis) { setProj(p => p && { ...p, analysis: null }); setPicked(null); setFills({}); setSkips([]); setMissFiles({}); setMissOpen(null) }
      api.clientLog('upload_deleted', { name: u.server })
    } catch (e) { patchUp(id, { status: 'ok' }); setErr((e as Error).message) }
  }
  const [pickAt, setPickAt] = useState(0)
  const [pickGuide, setPickGuide] = useState(false)   // composer 📎 on iPhone: picture guide before the picker
  const attachInput = useRef<HTMLInputElement>(null)
  const attachBypass = useRef(false)
  const [pickBack, setPickBack] = useState(false)   // the picker closed and the browser is still preparing the files
  const pick = () => { setPicking(true); setPickFail(false); setPickBack(false); setPickAt(Date.now()); api.clientLog('picker_open') }
  // iOS hides the page while the photo picker is open and, after 「加入」, can take a while to hand
  // the (converted) videos to the page. Once the page is visible again, show that we're receiving.
  useEffect(() => {
    if (!picking) return
    const back = () => { if (document.visibilityState === 'visible' && Date.now() - pickAt > 800) setPickBack(true) }
    window.addEventListener('focus', back); document.addEventListener('visibilitychange', back)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => { window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back); clearInterval(tick) }
  }, [picking, pickAt])
  // iOS never tells the page that the picker was dismissed. If no change event arrives, show the workarounds.
  useEffect(() => {
    if (!picking) return
    // Cloud originals take ~15 s each, so 30 picked clips can legitimately need several minutes.
    const t = setTimeout(() => { setPicking(false); setPickBack(false); setPickFail(true); api.clientLog('picker_no_file_480s') }, 480000)
    return () => clearTimeout(t)
  }, [picking])

  if (!proj) return <div className="center muted">載入中…</div>
  // 旁白稿 → 換一個聲音: the same voice list as the wizard; a pick becomes a plain instruction to the editor.
  const voiceSwap: VoiceSwap = {
    voices, current: voice && voice !== NO_VOICE ? voice : null, playing, onPreview: v => preview(v), onSample: v => preview(v, 'sample'), disabled: running,
    canClone: !!me?.can_clone_voice || voices.some(v => v.custom),
    onReclone: () => { recloneForScript.current = true; setCloning(true) },
    onPick: v => { setVoice(v.voice_id); submit(`旁白改用「${v.name}」的聲音（voice_id ${v.voice_id}）重新生成，稿子、秒數和其他都不變，配好後重新輸出影片。`) },
    onMore: () => submit('這份旁白稿想換個聲音：請再找 3 個台灣腔的聲音，各用稿子第一句做試聽給我選，先不要重新輸出。'),
    onProof: running ? undefined : () => (easy ? openProof() : openTimeline()),
  }
  const voiceBlock = (
    <>
                    <div className="muted small ob-sub">旁白聲音</div>
                    <div className="voice-row">
                      {/* 推薦用自己的聲音：還沒錄的人這張卡排第一；錄過的人自己的聲音本來就排第一、預設選中 */}
                      {me && !voices.some(v => v.custom) && (
                        <div className="voice add rec" onClick={() => setCloning(true)}>
                          <div className="voice-name">{!easy && <span className="pill rec">推薦</span>}＋ AI 生成我的聲音{me.voice_trial && <span className="lock-tag">試用 {me.voice_trial.limit} 秒</span>}</div>
                          <div className="muted small">錄 30 秒讓 AI 學你的聲音，旁白就用它配；做好後也可以改成親自一句一句唸</div>
                        </div>)}
                      {voices.map(v => (
                        <div key={v.voice_id} className={`voice ${voice === v.voice_id ? 'sel' : ''} ${v.custom ? 'mine' : ''}`} onClick={() => setVoice(v.voice_id)}>
                          <div className="voice-name">{v.custom && <>{!easy && <span className="pill rec">推薦</span>}<span className="mine-tag">AI · 我的聲音</span></>}{v.name}<span className="muted small"> {v.gender === 'female' ? '女' : v.gender === 'male' ? '男' : ''}</span></div>
                          {v.description && <div className="muted small">{v.description}</div>}
                          {v.preview_url && <a className="small" onClick={e => { e.stopPropagation(); preview(v) }}>{playing === v.voice_id ? '■ 停止' : v.custom ? '▶ 試聽 AI 配出來的樣子' : '▶ 試聽'}</a>}
                          {v.sample_url && <a className="small muted" onClick={e => { e.stopPropagation(); preview(v, 'sample') }}>{playing === `${v.voice_id}:sample` ? '■ 停止' : '▶ 聽我的原始錄音'}</a>}
                          {v.custom && me?.voice_trial && <div className="muted small">試用剩 {Math.max(0, Math.round(me.voice_trial.limit - me.voice_trial.used))} 秒，儲值後不限</div>}
                          {v.custom && <a className="small" onClick={e => { e.stopPropagation(); setCloning(true) }}>重新錄</a>}
                        </div>
                      ))}
                      <div className={`voice ${voice === NO_VOICE ? 'sel' : ''}`} onClick={() => setVoice(NO_VOICE)}>
                        <div className="voice-name">不要配音</div>
                        <div className="muted small">只要配樂＋字幕</div>
                      </div>
                      {voice === null && <span className="muted small">載入聲音中…</span>}
                    </div>
    </>
  )
  const stage: Stage = running ? 'working' : proj.messages.length === 0 ? 'start' : proj.credits.exports > 0 ? 'revise' : 'progress'
  const anPhase = analyzing ? Math.min(AN_PHASES.length - 1, Math.floor((now - anStart) / 9000)) : 0
  // Assets are produced by tools during an assistant turn: show each under the assistant
  // message whose time window (previous message → next message) contains it.
  const assetsFor = (m: Msg, i: number) => {
    if (m.role !== 'assistant') return []
    const prev = proj.messages[i - 1]?.created_at ?? ''
    const next = proj.messages[i + 1]?.created_at ?? '9999'
    return proj.assets.filter(a => a.created_at > prev && a.created_at <= next)
  }

  return (
    <div className="chat">
      <header>
        <h2>{name ?? proj.name}</h2>
        <div className="seg mini">
          <a className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>對話</a>
          <a className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>成品{(proj.exports ?? 0) > 0 && <span className="cnt">{proj.exports}</span>}</a>
        </div>
        {proj.credits.in_free && <span className="chip" onClick={onCredits} role="button">
          {proj.credits.free_revisions_left === null ? '免費專案：第一版 + 封面免費' : `免費專案：免費修改還剩 ${proj.credits.free_revisions_left} 輪`}
        </span>}
        {running && <span className="working-chip"><span className="spinner" />工作中 {turnStart.current ? fmtDur(now - turnStart.current) : ''}</span>}
        {running && <button className="btn small" onClick={() => api.cancel(projectId)}>停止</button>}
        {((proj.client_comments?.length ?? 0) > 0 || feedbackUnread > 0) && (
          <button className={`fb-bell ${feedbackUnread > 0 ? 'new' : ''}`} onClick={openFeedback} title="朋友的反饋" aria-label="朋友的反饋">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.4A8 8 0 1 1 21 12z" /></svg>
            <span>反饋</span>{feedbackUnread > 0 && <i>{feedbackUnread}</i>}
          </button>)}
      </header>
      {fbOpen && (
        <>
          <div className="scrim fb-scrim" onClick={() => setFbOpen(false)} />
          <aside className="drawer fb-drawer">
            <div className="dr-head"><div><div className="dr-email">朋友的反饋</div><div className="muted small">分享頁底下的留言串，大家都看得到。不會打斷剪輯師；想改再按「照這個改」，想回話就在下面回。</div></div><a className="dr-close" onClick={() => setFbOpen(false)}>✕</a></div>
            {(proj.client_comments?.length ?? 0) === 0 && <div className="muted small">還沒有人留言。到「成品」頁把影片分享給朋友，他們看完可以直接留話。</div>}
            <div className="fb-list">
              {(proj.client_comments ?? []).map(c => (
                <div key={c.id} className={`fb-item ${c.read ? '' : 'new'} ${c.owner ? 'mine' : ''}`}>
                  <div className="fb-item-head"><b>{c.owner ? '我' : (c.name || '朋友')}</b>{!c.read && <em>新</em>}<span className="muted small">{new Date(c.created_at.endsWith('Z') || c.created_at.includes('+') ? c.created_at : c.created_at + 'Z').toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}{c.version ? ` · 看的是${verLabel(c.version)}` : ''}</span></div>
                  <div className="fb-text">{c.text}</div>
                  {!c.owner && <div className="fb-act">
                    <a className="small" onClick={() => { setText(t => (t ? t + '\n' : '') + `朋友說：${c.text}。請照這個改。`); setFbOpen(false); setTab('chat') }}>照這個改</a>
                    <a className="small muted" onClick={() => setReply(r => r || `${c.name ? c.name + '，' : ''}`)}>回覆</a>
                  </div>}
                </div>))}
            </div>
            <div className="fb-reply">
              <textarea rows={2} value={reply} onChange={e => setReply(e.target.value)} placeholder="回覆大家（會出現在分享頁的留言串）"
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !IS_TOUCH) { e.preventDefault(); sendReply() } }} />
              <button className="btn primary small" disabled={!reply.trim() || replying} onClick={sendReply}>{replying ? '送出中…' : '回覆'}</button>
            </div>
          </aside>
        </>
      )}
      {tab === 'files' && <Deliverables key={`${projectId}:${proj.assets.length}:${proj.exports ?? 0}`} projectId={projectId} onStorage={onStorage} onChanged={() => { reload(); onProjectsChanged?.() }} onProof={running ? undefined : v => (easy ? openProof(v) : openTimeline('tracks', v))} onTweak={running || easy ? undefined : () => openTimeline('style')} />}
      {proof && easy && <Proof projectId={projectId} version={proof.version} onOwnVoice={() => { setProof(null); setVoicePick(true) }}
        onPro={onMode ? () => onMode('pro') : undefined} initialLines={carry.current} onLines={l => { carry.current = l }} onClose={() => setProof(null)} onUsage={onUsage} onDone={() => { carry.current = {}; afterQuick() }} />}
      {ownRead !== false && <OwnRead projectId={projectId} version={ownRead} initialTakes={carryTakes.current} onTakes={t => { carryTakes.current = t }} onClose={() => setOwnRead(false)} onDone={() => { carryTakes.current = {}; afterQuick() }} onUsage={onUsage} />}
      {voicePick && (
        <div className="sh-scrim" onClick={e => { if (e.target === e.currentTarget) setVoicePick(false) }}>
          <div className="sh vpick" role="dialog" aria-label="換成我的聲音">
            <div className="ideas-h"><b>換成我的聲音</b><span className="muted small">兩種做法，選一個</span></div>
            <button type="button" className="sh-act big" onClick={openOwnRead}>
              <i>🎙</i><span><b>我親自一句一句配音<em className="qr-rec">推薦</em></b><small>照著旁白稿一句一句唸，影片裡就是你本人的聲音。約 3 分鐘，不扣點。</small></span></button>
            <button type="button" className="sh-act big" onClick={useAiVoice}>
              <i>✨</i><span><b>AI 生成我的聲音</b><small>{ownVoice ? `用 AI 學好的「${ownVoice.name}」重配整支，以後每一版自動用它。` : '錄 30 秒讓 AI 學你的聲音，之後每一版都自動用它配。'}</small></span></button>
            <a className="sh-cancel" onClick={() => setVoicePick(false)}>關閉</a>
          </div>
        </div>)}
      {timeline && !easy && <Timeline projectId={projectId} version={timeline.version} tab={timeline.tab} initialLines={carry.current} onLines={l => { carry.current = l }} onClose={() => setTimeline(null)} onDone={() => { carry.current = {}; afterQuick() }} onUsage={onUsage} />}
      {tab === 'chat' && <>
      <VoiceSwapCtx.Provider value={voiceSwap}>
      <div className="thread" ref={threadRef} onScroll={onScroll}>
        {stage === 'start' && (
          <div className="ob-wiz">
            <div className="ob-prog">
              {OB_STEPS.map((t, i) => (
                <a key={t} className={`ob-pn ${i === obStep ? 'on' : ''} ${obDone[i] ? 'done' : ''}`} onClick={() => i <= obStep || obDone[i - 1] ? goStep(i) : null}>
                  <i>{obDone[i] && i !== obStep ? '✓' : i + 1}</i><span>{easy && i === 1 ? '剪輯師先看' : easy && i === 2 ? '挑重點' : t}</span>
                </a>
              ))}
              <span className="ob-count muted small">第 {obStep + 1} 步，共 3 步 · 註冊送的 110 點夠做第一支</span>
            </div>

            <div className="ob-main">
              <section className="card ob-card" key={obStep}>
                {obStep === 0 && (
                  <>
                    <h3>先丟素材給剪輯師</h3>
                    <div className={`spot ${!okUploads && !uploading && !linkOk ? 'on' : ''}`}>
                      {!okUploads && !uploading && !linkOk && <span className="coach">點這裡選影片</span>}
                      <DropZone onFiles={onFiles} onPick={pick} disabled={uploading} count={okUploads} />
                    </div>
                    {uploads.length > 0 && <UploadQueue ups={uploads} onRetry={retryUpload} onRemove={removeUpload} onDelete={deleteUpload} onClose={() => setUploads([])} hint={IOS ? '別離開這頁' : undefined} />}
                    <div className={`link-chat ${drive.state}`}>
                      <span className="lc-ic" aria-hidden="true">☁️</span>
                      <input placeholder="或貼雲端連結（Google、Dropbox、iCloud）" value={link}
                        onChange={e => setLink(e.target.value)} inputMode="url" autoComplete="off" />
                      {drive.state === 'checking' && <span className="spinner" />}
                      {drive.state === 'ok' && <span className="dg-ok">✓</span>}
                      {link && drive.state !== 'checking' && <a className="small" onClick={() => setLink('')}>清除</a>}
                    </div>
                    {drive.state === 'ok' && drive.info && (drive.info.media > 0
                      ? <div className="lc-msg ok">{drive.info.label}：{drive.info.folder_zip ? '讀到一個資料夾，下載時自動解開' : `讀到 ${drive.info.media} 個素材（${drive.info.videos} 支影片、${drive.info.photos} 張照片）`}</div>
                      : <div className="lc-msg err">連結打得開，但裡面沒有影片或照片。</div>)}
                    {drive.state === 'err' && <div className="lc-msg err">{drive.error}</div>}
                    {link && drive.state === 'idle' && <div className="lc-msg">🔓 要 https:// 開頭，並開放「知道連結的人可檢視」</div>}
                    <div className="theme">
                      <div className="theme-h"><b>這支影片要講什麼？</b><span className="muted small">剪輯師會照這個抓重點</span></div>
                      <div className="theme-opts" role="radiogroup" aria-label="主題">
                        <button type="button" className={`theme-o ${theme === 'travel' ? 'on' : ''}`} role="radio" aria-checked={theme === 'travel'} onClick={() => setTheme('travel')}>
                          <i aria-hidden="true">🧳</i><b>旅遊 · 住宿</b><small>民宿、飯店、景點、行程</small></button>
                        <button type="button" className={`theme-o ${theme === 'custom' ? 'on' : ''}`} role="radio" aria-checked={theme === 'custom'} onClick={() => setTheme('custom')}>
                          <i aria-hidden="true">✏️</i><b>自己定主題</b><small>打幾個字就好</small></button>
                      </div>
                      {theme === 'custom' && (
                        <div className="theme-in">
                          <input autoFocus value={themeText} maxLength={30} placeholder="例如：老屋改建、親子一日遊、手沖咖啡" onChange={e => setThemeText(e.target.value)} />
                          <div className="chips inline">{['老屋改建', '親子一日遊', '手沖咖啡', '夜市美食', '露營車', '婚禮花絮'].map(x => <a key={x} className={`chipbtn ${themeText === x ? 'on' : ''}`} onClick={() => setThemeText(x)}>{x}</a>)}</div>
                        </div>
                      )}
                    </div>
                    <div className="ob-nav">
                      <span className="muted small">{analysis ? `已有 ${analysis.n_clips} 個素材（已解析）` : okUploads > 0 ? `已上傳 ${okUploads} 個素材` : linkOk ? `${drive.info?.label}連結就緒` : uploading ? '上傳中…' : drive.state === 'checking' ? '讀取連結中…' : '還沒有素材'}</span>
                      <button className={`btn primary ${hasFootage && !uploading ? 'glow' : ''}`} disabled={!hasFootage || uploading || (theme === 'custom' && !themeText.trim())} onClick={() => { goStep(1); if (easy && !analysis) setTimeout(runAnalyze, 50) }}>{easy ? `讓剪輯師先看一遍 →` : '下一步：解析素材 →'}</button>
                    </div>
                  </>
                )}
                {obStep === 1 && !analysis && (
                  <>
                    <h3>{analyzing ? '剪輯師正在看素材' : '先讓剪輯師看一遍'}</h3>
                    {!analyzing && <p className="muted">看完告訴你賣點、分鏡、要花幾點。</p>}
                    {analyzing ? (
                      <div className="an-run">
                        <div className="an-run-head"><span className="spinner" /><b>已 {fmtDur(now - anStart)}</b><span className="muted">· 通常 1–2 分鐘{linkOk && !okUploads ? '，雲端素材更久' : ''}</span></div>
                        <ol className="an-phases">
                          {AN_PHASES.map((p, i) => <li key={p} className={i < anPhase ? 'done' : i === anPhase ? 'on' : ''}><i>{i < anPhase ? '✓' : i + 1}</i>{p}</li>)}
                        </ol>
                        <div className="an-skel"><span /><span /><span /><span /><span /></div>
                      </div>
                    ) : (
                      <>
                        <div className="an-cta">
                          <div className={`spot inline ${!anNeed ? 'on' : ''}`}>
                            {!anNeed && <span className="coach">按這裡</span>}
                            <button className="btn primary start glow" onClick={runAnalyze} disabled={running || uploading}>
                              解析 {analysis ? '' : okUploads > 0 ? `${okUploads} 個` : ''}素材<small>{ANALYZE_POINTS} 點</small>
                            </button>
                          </div>
                          <div className="an-cta-list">
                            {['賣點', '分鏡', '旁白稿', '要花幾點'].map(x => <span key={x}>✓ {x}</span>)}
                          </div>
                        </div>
                        {anNeed && (
                          <div className="card need">
                            <div><b>點數不足</b>：解析需要 {anNeed.needed} 點，目前 {anNeed.balance} 點。<div className="muted small">儲值後回來再按一次。</div></div>
                            <button className="btn primary small" onClick={() => onTopUp(Math.max(0, anNeed.needed - anNeed.balance))}>去儲值</button>
                          </div>
                        )}
                        {anErr && <div className="error">{anErr}</div>}
                      </>
                    )}
                    <div className="ob-nav">
                      <a className="small" onClick={() => goStep(0)}>← 上一步</a>
                      {!analyzing && <a className="small muted" onClick={() => { setSkipAn(true); goStep(2) }}>跳過 →</a>}
                    </div>
                  </>
                )}
                {obStep === 1 && analysis && (
                  <>
                    <h3>剪輯師看完了：{analysis.summary || `${analysis.n_clips} 個素材`}</h3>
                    <p className="muted">{easy ? '這些是剪輯師看到的重點。不想講的點掉，覺得可以就按下一步。' : '覺得可以就直接下一步。想調：點掉不要的賣點，或點一段分鏡標重點、改旁白、拿掉。'}</p>
                    <div className="an-sec">
                      <div className="an-h"><b>賣點</b><span className="muted small">留 {pickedPoints.length} 個</span></div>
                      <div className="an-chips">
                        {analysis.selling_points.map((s, i) => (
                          <a key={s} className={`an-chip ${pickedPoints.includes(s) ? 'on' : ''} ${i === 0 ? 'top' : ''}`} onClick={() => togglePoint(s)}>{i === 0 && <em>最強</em>}{s}</a>))}
                        {extraPts.map(s => (
                          <a key={s} className={`an-chip mine ${pickedPoints.includes(s) ? 'on' : ''}`} onClick={() => togglePoint(s)}><em>我加的</em>{s}</a>))}
                        {addingPt
                          ? <span className="an-chip add-in"><input autoFocus value={newPt} placeholder="例：老闆手沖咖啡" maxLength={20} onChange={e => setNewPt(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) addPoint(); if (e.key === 'Escape') { setNewPt(''); setAddingPt(false) } }} onBlur={addPoint} /></span>
                          : <a className="an-chip add" onClick={() => setAddingPt(true)}>＋ 加一個</a>}
                      </div>
                    </div>
                    <div className="an-sec">
                      <div className="an-h"><b>分鏡與旁白稿</b><span className="muted small">{analysis.storyboard.length} 個鏡頭 · 約 {Math.round(analysis.total_seconds)} 秒 · 點一段可以調</span><a className="small" onClick={copyScript}>複製逐字稿</a></div>
                      <ol className="an-sb">
                        {analysis.storyboard.map(s => {
                          const line = analysis.script.find(l => l.n === s.n)
                          const star = stars.includes(s.n), drop = drops.includes(s.n), ed = edits[s.n]
                          return (
                            <li key={s.n} data-n={s.n} className={`an-shot ${s.role} ${star ? 'star' : ''} ${drop ? 'drop' : ''}`} onClick={() => editing === s.n ? null : setSheet(s.n)}>
                              <span className="an-fr"><img src={api.frameUrl(projectId, s.clip, s.t)} alt="" loading="lazy" /><i>#{String(s.clip).padStart(2, '0')} · {s.dur}s</i>{star && <b className="an-star">⭐</b>}</span>
                              <span className="an-shot-main">
                                <span className="an-shot-top"><b>{s.n}</b><em className={`an-role ${s.role}`}>{ROLE_LABEL[s.role]}</em><span>{s.shot}</span>
                                  {drop ? <span className="an-badge drop">不要這段</span> : star ? <span className="an-badge star">重點</span> : null}
                                  {ed !== undefined && !drop && <span className="an-badge ed">{ed === REWRITE ? '請剪輯師重寫' : '已改'}</span>}
                                </span>
                                {editing === s.n ? (
                                  <span className="an-edit" onClick={e => e.stopPropagation()}>
                                    <textarea rows={2} autoFocus value={editText} onChange={e => setEditText(e.target.value)} maxLength={60} />
                                    <span className="an-edit-btns">
                                      <button type="button" className="btn primary small" onClick={() => { const t = editText.trim(); setEdits(m => { const c = { ...m }; if (t && t !== line?.text) c[s.n] = t; else delete c[s.n]; return c }); setEditing(null) }}>好了</button>
                                      <button type="button" className="btn small" onClick={() => { setEdits(m => ({ ...m, [s.n]: REWRITE })); setEditing(null) }}>讓剪輯師重寫</button>
                                      <a className="small muted" onClick={() => setEditing(null)}>取消</a>
                                    </span>
                                  </span>
                                ) : line && <span className={`an-line ${ed !== undefined && ed !== REWRITE ? 'ed' : ''}`}>「{ed !== undefined && ed !== REWRITE ? ed : line.text}」</span>}
                              </span>
                              <span className="an-more" aria-hidden="true">⋯</span>
                            </li>)
                        })}
                      </ol>
                      {analysis.clips.length > 0 && (
                        <div className="an-clips">
                          <div className="an-h"><b>素材</b><span className="muted small">{analysis.clips.length} 個 · 灰的沒用到，點一下就一定會用</span></div>
                          <div className="an-strip">
                            {analysis.clips.map(c => {
                              const used = usedClips.has(c.n), pin = pins.includes(c.n)
                              return (
                                <a key={c.n} className={`an-clip ${used ? 'used' : ''} ${pin ? 'pin' : ''}`} onClick={() => !used && toggleIn(setPins, c.n)} title={c.name}>
                                  <img src={api.frameUrl(projectId, c.n, c.photo ? 0 : Math.min(1, c.dur / 2))} alt="" loading="lazy" />
                                  <i>#{String(c.n).padStart(2, '0')}{c.photo ? '' : ` · ${Math.round(c.dur)}s`}</i>
                                  {pin && <b>📌 一定要用</b>}
                                  {used && !pin && <b className="ok">✓</b>}
                                </a>)
                            })}
                          </div>
                        </div>
                      )}
                      {nAdjust > 0 && <div className="an-adj"><b>已調整 {nAdjust} 處</b><span className="muted small">會一起交給剪輯師</span><a className="small" onClick={resetAdjust}>全部還原</a></div>}
                      {analysis.transcript_notes && <div className="muted small">現場音：{analysis.transcript_notes}</div>}
                    </div>
                    {renderMiss(false)}
                    <div className={`an-est ${analysis.estimate.enough_two ? 'ok' : analysis.estimate.enough_first ? 'warn' : 'short'}`}>
                      <div className="an-est-rows">
                        <div><span>第一版影片＋封面</span><b>{analysis.estimate.first_video_points} 點</b></div>
                        <div><span>每輪修改</span><b>{analysis.estimate.revision_points} 點</b></div>
                        <div className="tot"><span>含 2 輪修改（平均兩輪就定稿）</span><b>{analysis.estimate.two_revisions_points} 點</b></div>
                      </div>
                      <div className="an-est-bal">
                        <span className="muted small">目前餘額</span><b>{analysis.estimate.balance} 點</b>
                        {analysis.estimate.enough_two ? <span className="ok">✓ 足夠做完含修改</span>
                          : analysis.estimate.enough_first ? <span className="warn">夠做第一版，修改差 {analysis.estimate.short_two} 點</span>
                            : <span className="short">差 {analysis.estimate.short_first} 點才能開始</span>}
                        {!analysis.estimate.enough_two && <button className="btn small primary" onClick={() => onTopUp(analysis.estimate.short_two)}>去儲值</button>}
                      </div>
                    </div>
                    <div className="ob-nav">
                      <span><a className="small" onClick={() => goStep(0)}>← 上一步</a><a className="small muted" style={{ marginLeft: 14 }} onClick={runAnalyze}>重新解析（{ANALYZE_POINTS} 點）</a></span>
                      <div className="spot inline on">
                        <span className="coach">用這些賣點</span>
                        <button className="btn primary glow" onClick={useAnalysis}>下一步：選風格 →</button>
                      </div>
                    </div>
                  </>
                )}
                {obStep === 2 && (
                  <>
                    <h3>{easy ? '選你的聲音和風格' : '最後：賣點、風格、字幕、長度、聲音'}</h3>
                    <p className="muted">{easy ? '選一個聲音，或錄 30 秒讓 AI 學你的聲音。做好後也能改成親自一句一句配音。'  : analysis ? '賣點已經幫你填好，想改就改；加上價格、店名、語氣更好。' : '地點、特色、價格、語氣，想到什麼寫什麼。不會寫就按「給我範例」。'}</p>
                    {easy && voiceBlock}
                    {easy && <>
                      <div className="muted small ob-sub">風格</div>
                      <div className="ez-styles" role="radiogroup" aria-label="風格">
                        {STYLES.map(st => <button type="button" key={st.id} role="radio" aria-checked={style === st.id} className={`ez-st ${style === st.id ? 'on' : ''}`} onClick={() => setStyle(st.id)}><b>{st.name}</b><small>{EZ_STYLE_DESC[st.id]}</small></button>)}
                      </div>
                      <div className="muted small ob-sub">影片長度</div>
                      <div className="ez-styles" role="radiogroup" aria-label="影片長度">
                        {LENGTHS.map(l => <button type="button" key={l.id} role="radio" aria-checked={length === l.id} className={`ez-st ${length === l.id ? 'on' : ''}`} onClick={() => setLength(l.id)}><b>{l.icon} {l.name}</b><small>{l.secs}</small></button>)}
                      </div>
                      {!ezBrief && <div className="muted small ob-sub">一句話說這支要賣什麼</div>}
                    </>}
                    {ezBrief && analysis && (renderMiss(true) ?? <div className="ez-miss"><div className="ez-miss-ok">✓ 賣點都齊了，剪輯師會照上一步留的賣點做。</div></div>)}
                    {!ezBrief && <div className={`spot ${!text.trim() ? 'on' : ''}`}>
                      {!text.trim() && <span className="coach">在這裡打字</span>}
                      <textarea rows={4} value={text} onChange={e => setText(e.target.value)} autoFocus={!text}
                        placeholder={'例：宜蘭海邊的包棟民宿，25 米戲水池、龜山島海景、KTV、電動麻將、寵物友善。價格「平日每人 NT$1,500」。語氣輕鬆活潑。'} />
                      {mic.available && !mic.on && !mic.busy && <button type="button" className="attach mic ob-mic" title="用說的" aria-label="語音輸入" onClick={mic.toggle}><MicIcon /></button>}
                    </div>}
                    {!ezBrief && mic.on && <RecBar r={mic.rec} label="說出這支要賣什麼" stopLabel="說完了" hint="地點、特色、價格，想到什麼說什麼" />}
                    {!ezBrief && mic.busy && <SttBar />}
                    {!ezBrief && <div className="chips inline">
                      {!analysis && <a className="chipbtn on" onClick={() => setText(EXAMPLE_BRIEF)}>給我範例</a>}
                      {['地點：', '價格：平日每人 NT$', '店名：', '語氣：輕鬆活潑'].map(c => (
                        <a key={c} className="chipbtn" onClick={() => setText(t => (t ? t.replace(/\s*$/, '\n') : '') + c)}>{c}</a>))}
                    </div>}
                    <div className={`ob-opts ${easy ? 'hide' : ''}`}>
                    {!easy && <>
                    <div className="muted small ob-sub">風格</div>
                    <div className="styles">
                      {STYLES.map(st => (
                        <div key={st.id} className={`stylec ${style === st.id ? 'sel' : ''}`} onClick={() => setStyle(st.id)}>
                          <div className="stylec-name">{st.name}{st.tag && <span className="pill">{st.tag}</span>}</div>
                          <div className="muted small">{st.desc}</div>
                        </div>
                      ))}
                    </div>
                    <div className="muted small ob-sub">字幕樣式<span className="ob-sub-note">做好後也能在「時間軸」換，不用重剪</span></div>
                    <CapPicker value={capStyle} onChange={setCapStyle} font={font} />
                    <a className="ob-more-s" onClick={() => setMoreStyle(m => !m)}>{moreStyle ? '收起字型與標題樣式 ▴' : <>字型與標題樣式 ▾<small>目前：{FONTS.find(f => f.id === font)?.name} · {SUPER_STYLES.find(x => x.id === superStyle)?.name}</small></>}</a>
                    {moreStyle && <>
                      <div className="muted small ob-sub">字型</div>
                      <FontPicker value={font} onChange={setFont} style={capStyle} />
                      <div className="muted small ob-sub">標題樣式<span className="ob-sub-note">上方的店名、房型等補充資訊</span></div>
                      <SuperPicker value={superStyle} onChange={setSuperStyle} font={font} />
                      <StyleHint what="字幕或標題風格" />
                    </>}
                    </>}
                    <div className="muted small ob-sub">影片長度</div>
                    {(() => {
                      const cur = LENGTHS.find(l => l.id === length) ?? LENGTHS[1]
                      return (
                        <div className="lenbox">
                          <div className="lenseg" role="radiogroup" aria-label="影片長度">
                            {LENGTHS.map(l => (
                              <button type="button" key={l.id} className={`lenseg-b ${length === l.id ? 'on' : ''}`} onClick={() => setLength(l.id)} role="radio" aria-checked={length === l.id}>
                                <span className="lenseg-ic" aria-hidden="true">{l.icon}</span><b>{l.name}</b><small>{l.secs}</small>
                              </button>
                            ))}
                          </div>
                          <div className="lentl" aria-hidden="true">
                            <i style={{ width: `${cur.id === 'short' ? 27 : cur.id === 'std' ? 60 : 100}%` }} />
                            <span className="lentl-0">0s</span><span className="lentl-60">60s</span>
                          </div>
                          <div className="lendesc small"><b>{cur.name}{cur.tag ? '（預設）' : ''}</b>{cur.desc}</div>
                        </div>)
                    })()}
                    </div>
                    {!easy && voiceBlock}
                    <div className="ob-nav">
                      <a className="small" onClick={() => goStep(1)}>← 上一步</a>
                      <div className={`spot inline ${canStart ? 'on' : ''}`}>
                        {canStart && <span className="coach">按下去就開始</span>}
                        <button className={`btn primary start ${canStart ? 'glow' : ''}`} disabled={!canStart} onClick={start}>
                          {!hasFootage ? '先回第 1 步給素材' : !ezBrief && !text.trim() ? '寫一點賣點就能開始' : voice === null ? '載入聲音中…' : '開始剪輯'}
                        </button>
                      </div>
                    </div>
                    <div className="muted small" style={{ textAlign: 'center' }}>
                      送出後剪輯師會一路做到輸出影片與封面，約 15 分鐘，中途不會停下來問。
                    </div>
                  </>
                )}
              </section>
              <ObPreview projectId={projectId} step={obStep} style={style} length={length} voiceName={voice === NO_VOICE ? null : voices.find(v => v.voice_id === voice)?.name ?? null} uploads={uploads.filter(u => u.status === 'ok').length} linkOk={linkOk} text={text} analysis={analysis} analyzing={analyzing} />
            </div>
          </div>
        )}
        {proj.messages.map((m, i) => <Bubble key={m.id} m={m} easy={easy} brief={m.role === 'user' && i === proj.messages.findIndex(x => x.role === 'user')} assets={assetsFor(m, i)} onOpenFiles={() => setTab('files')} onRecord={running ? undefined : setPrompter} />)}
        {running && easy && (
          <div className="bubble assistant ez">
            <div className="working"><span className="spinner" /><b>剪輯師正在做</b>{turnStart.current && <span className="muted">· 已 {fmtDur(now - turnStart.current)}</span>}</div>
            <div className="muted">做好會直接出現在這裡，可以先離開，回來看就好。</div>
            {liveAssets.current.map(a => <AssetCard key={a.id} a={a} onOpenFiles={() => setTab('files')} />)}
          </div>
        )}
        {running && !easy && (
          <div className="bubble assistant">
            {(() => { const cur = [...live.tools].reverse().find(t => t.status === 'run'); return (
              <div className="working">
                <span className="spinner" />
                <b>剪輯師工作中</b>
                <span className="muted">· {cur ? TOOL_LABEL[cur.name] ?? cur.name : live.text ? '回覆中' : '思考中'}</span>
                {turnStart.current && <span className="muted">· 已 {fmtDur(now - turnStart.current)}</span>}
              </div>) })()}
            {live.thinking && <details className="thinking"><summary>思考中</summary><div>{live.thinking}</div></details>}
            {live.tools.length > 0 && (
              <ol className="steps">
                {live.tools.map((t, i) => (
                  <li key={i} className={`sx ${t.status}`}>
                    <ToolIcon name={t.name} />
                    <span className="sx-label">{TOOL_LABEL[t.name] ?? t.name}</span>
                    <span className="sx-meta">
                      {t.status === 'run' ? (t.startedAt ? fmtDur(now - t.startedAt) : '') : t.status === 'err' ? '失敗' : t.seconds !== undefined ? `${t.seconds}s` : ''}
                    </span>
                    {t.status === 'ok' && shortSummary(t.summary) && <span className="sx-sum">{shortSummary(t.summary)}</span>}
                  </li>
                ))}
              </ol>
            )}
            {liveAssets.current.map(a => <AssetCard key={a.id} a={a} onOpenFiles={() => setTab('files')} />)}
            {live.text && <Md text={live.text} />}
            {!live.text && live.tools.every(t => t.status !== 'run') && <span className="muted">…</span>}
          </div>
        )}
        {needCredits && (
          <div className="card need">
            <div><b>點數不足</b>：這一步需要 {needCredits.needed} 點，目前 {needCredits.balance} 點，差 {Math.max(0, needCredits.needed - needCredits.balance)} 點。
              <div className="muted small">最小 50 點起。儲值入帳後回來輸入「繼續」，剪輯師會接著做。</div></div>
            <button className="btn primary small" onClick={() => onTopUp(Math.max(0, needCredits.needed - needCredits.balance))}>去儲值</button>
          </div>
        )}
        {pickFail && !uploads.length && (
          <div className="card need">
            <b>沒收到檔案</b>
            <div className="pf-tips">
              {CRIOS && <span>🧭 改用 Safari 開</span>}
              <span>🔢 一次少選幾支</span>
              {IOS && <span>▶️ 先在「照片」播一次再選</span>}
              <span>☁️ 或貼雲端連結</span>
            </div>
            <a className="small" onClick={() => setPickFail(false)}>關閉</a>
          </div>
        )}
        {needStorage && (
          <div className="card need">
            <div><b>成品空間已滿</b>：已用 {fmtBytes(needStorage.used_bytes)} / {fmtBytes(needStorage.quota_bytes)}，新的影片與封面先暫停輸出。
              <div className="muted small">刪掉不要的舊版本，或升級空間，再輸入「繼續」，剪輯師會接著輸出。已有的成品照常可看可下載。</div></div>
            <button className="btn primary small" onClick={onStorage}>升級空間</button>
            <button className="btn small" onClick={() => setTab('files')}>刪舊版本</button>
          </div>
        )}
        {uploads.length > 0 && stage !== 'start' && (uqFold && uploads.every(u => u.status === 'ok') ? (
          <div className="uq-fold">
            <span className="uq-fold-ok">✓</span>
            <span><b>{uploads.length} 個素材已交給剪輯師</b><small className="muted"> · {fmtMB(uploads.reduce((a, u) => a + u.size, 0))}</small></span>
            <span className="spacer" />
            <a className="small" onClick={() => setUqFold(false)}>看清單</a>
            <a className="small muted" onClick={() => setUploads([])}>關閉</a>
          </div>
        ) : (
          <div className="card uq-card">
            <UploadQueue ups={uploads} onRetry={retryUpload} onRemove={removeUpload} onDelete={deleteUpload} onClose={() => setUploads([])} hint={IOS ? '別離開這頁' : undefined} />
            {uploads.every(u => u.status === 'ok') && stage !== 'progress' && <a className="small uq-foldlink" onClick={() => setUqFold(true)}>收起</a>}
          </div>
        ))}
        {err && <div className="error">{err}</div>}
        <div ref={bottom} />
      </div>
      </VoiceSwapCtx.Provider>
      {prompter && <Teleprompter lines={prompter} projectId={projectId} onClose={() => setPrompter(null)}
        onUploaded={(key, secs) => { setPrompter(null); submit(`我上傳了自己唸的旁白（key ${key}，${secs} 秒），請用它當旁白，不要再生成 AI 配音；從 0 秒開始放，字幕照我的聲音對齊，然後重新輸出。`) }} />}
      {picking && pickBack && (
        <div className="pick-wait" role="status">
          {(() => {
            const secs = Math.max(0, Math.round((now - pickAt) / 1000))
            const nth = Math.floor(secs / CLOUD_SECS_PER_VIDEO) + 1          // the picker never says how many were chosen: count by the clock
            const lap = ((secs % CLOUD_SECS_PER_VIDEO) / CLOUD_SECS_PER_VIDEO) * 100
            return (
              <div className="pw-card">
                <CloudDl />
                <b>準備影片中…</b>
                <span className="pw-time">{secs} 秒</span>
                <div className="pw-est">
                  <div className="pw-est-row"><span>約第 <b>{nth}</b> 支</span><span className="muted">每支約 {CLOUD_SECS_PER_VIDEO} 秒</span></div>
                  <div className="pw-est-bar"><i style={{ width: `${lap}%` }} /></div>
                </div>
                <ol className="pw-steps"><li className="done">✓ 選好</li><li className="on">⏳ 準備中</li><li>⬆ 上傳</li></ol>
                <p className="pw-short">正常現象，別離開這頁</p>
                <a className="small" onClick={() => { setPicking(false); setPickBack(false) }}>沒有選，關閉</a>
              </div>)
          })()}
        </div>
      )}
      {sheet !== null && analysis && (() => {
        const s = analysis.storyboard.find(x => x.n === sheet); if (!s) return null
        const line = analysis.script.find(l => l.n === s.n)
        const star = stars.includes(s.n), drop = drops.includes(s.n), full = !star && stars.length >= STAR_MAX
        return (
          <div className="sh-scrim" onClick={e => { if (e.target === e.currentTarget) setSheet(null) }}>
            <div className="sh" role="dialog" aria-label={`第 ${s.n} 段`}>
              <div className="sh-head">
                <img src={api.frameUrl(projectId, s.clip, s.t)} alt="" />
                <div><b>第 {s.n} 段 · {s.shot}</b>{line && <div className="muted small">「{line.text}」</div>}</div>
              </div>
              <button type="button" className={`sh-act ${star ? 'on' : ''}`} disabled={full || drop} onClick={() => { toggleIn(setStars, s.n); setSheet(null) }}>
                <i>⭐</i><span><b>{star ? '取消重點' : '這段是重點'}</b><small>{full ? `最多 ${STAR_MAX} 個重點，先取消一個` : '多停一點、多講一句、字幕放大'}</small></span></button>
              <button type="button" className="sh-act" disabled={drop || !line} onClick={() => { setEditText(edits[s.n] && edits[s.n] !== REWRITE ? edits[s.n] : line?.text ?? ''); setEditing(s.n); setSheet(null) }}>
                <i>✎</i><span><b>改這句旁白</b><small>自己改，或讓剪輯師重寫</small></span></button>
              <button type="button" className={`sh-act ${drop ? 'on' : ''}`} onClick={() => { toggleIn(setDrops, s.n); setSheet(null) }}>
                <i>✕</i><span><b>{drop ? '這段還是要' : '不要這段'}</b><small>剪輯師會用別的素材補</small></span></button>
              <a className="sh-cancel" onClick={() => setSheet(null)}>關閉</a>
            </div>
          </div>)
      })()}
      {ideas && (
        <div className="sh-scrim" onClick={e => { if (e.target === e.currentTarget) setIdeas(false) }}>
          <div className="sh ideas" role="dialog" aria-label="更多改法">
            <div className="ideas-h"><b>想怎麼改？</b><span className="muted small">點一下放進對話框，可以再改字、或多選幾項一起送</span></div>
            {IDEAS.map(g => (
              <div key={g.t} className="ideas-g"><div className="ideas-t">{g.t}</div>
                <div className="ideas-row">{g.items.map(it => <button key={it.l} type="button" className={`ideas-o ${it.tool ? 'tool' : ''}`} onClick={() => pickIdea(it)}>{it.l}{it.tool && <small>馬上改</small>}</button>)}</div>
              </div>))}
            <div className="ideas-tip">💬 這些只是例子。任何想法都能直接打字或用 🎙 說給剪輯師聽，就像跟真人剪輯師溝通，例如「第 3 句換成泳池畫面，價格放到最後」。</div>
            <a className="sh-cancel" onClick={() => setIdeas(false)}>關閉</a>
          </div>
        </div>)}
      {cheer !== null && (
        <div className="cheer-scrim" onClick={e => { if (e.target === e.currentTarget) setCheer(null) }}>
          <div className="cheer" role="dialog" aria-label="影片完成">
            <div className="cheer-emoji" aria-hidden="true">🎉</div>
            <h3>{cheer === 1 ? '第一支影片做好了！' : `${verLabel(cheer)}做好了！`}</h3>
            <p>比外包剪一支，大約省了 <b>NT${Math.round(EASY_SAVING_TWD).toLocaleString()}</b></p>
            <button className="btn primary block lg" onClick={() => { setCheer(null); setTab('files') }}>看成品、分享給朋友</button>
            <button className="btn block cheer-own" onClick={() => { setCheer(null); setVoicePick(true) }}>🎙 換成我的聲音</button>
            <a className="cheer-later" onClick={() => setCheer(null)}>等一下再看</a>
          </div>
        </div>
      )}
      {pickGuide && <PickGuide onGo={() => { attachBypass.current = true; attachInput.current?.click() }} onClose={() => setPickGuide(false)} />}
      {cloning && <VoiceCloneDialog current={voices.find(v => v.custom)} onClose={() => { recloneForScript.current = false; setCloning(false) }} onDone={onCloned} />}
      {unseen && <a className="jump" onClick={jump}>↓ 有新內容</a>}
      {ownBusy && <div className="own-busy"><span className="spinner" />正在把旁白換成你的聲音，約 1–2 分鐘…</div>}
      {easy && stage !== 'start' && EASY_CHIPS[stage].length > 0 && !uploading && (
        <div className="qr ez">
          <div className="qr-row">
            {EASY_CHIPS[stage].filter(c => !(c.own && usedOwn)).map(c => (
              <button key={c.label} type="button" className={`qrb ez ${c.main ? 'main' : ''} ${c.own ? 'own' : ''}`} disabled={running || ownBusy}
                onClick={() => { if (c.send) submit(c.send); else if (c.files) setTab('files'); else if (c.proof) openProof(); else if (c.own) switchToOwnVoice(); else taRef.current?.focus() }}>{c.own && <em className="qr-rec">推薦</em>}{c.label}</button>))}
          </div>
        </div>
      )}
      {!easy && stage !== 'start' && CHIPS[stage].length > 0 && !uploading && (
        <div className="qr">
          <span className="qr-lbl">{stage === 'revise' ? '細調 · 或直接打字跟剪輯師說想怎麼改' : '下一步 · 點一下就送出'}</span>
          <div className="qr-row">
            {CHIPS[stage].filter(c => !(c === '換成我的聲音' && usedOwn)).map(c => {
              const main = c === DEFAULT_CHIP[stage] || c === '時間軸細調'
              return (
                <button key={c} type="button" className={`qrb ${main ? 'main' : ''}`} disabled={running || ownBusy} onClick={() => c === '時間軸細調' ? openTimeline() : c === '換成我的聲音' ? switchToOwnVoice() : c === '更多改法…' ? setIdeas(true) : submit(c)}>
                  {main && <em>建議</em>}<span>{c}</span>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>)
            })}
          </div>
        </div>
      )}
      {stage !== 'start' && <footer className="composer">
        <label className={`attach ${uploading ? 'busy' : ''}`} title="上傳影片" aria-label="上傳影片"
          onClick={e => { if (attachBypass.current) { attachBypass.current = false; return } if (!uploading && needsPickGuide()) { e.preventDefault(); setPickGuide(true) } }}>
          <ClipIcon />
          <input ref={attachInput} type="file" multiple accept="video/*,.mp4,.mov,.m4v" hidden disabled={uploading} onClick={pick}
            onChange={e => { onFiles(e.target.files); e.target.value = '' }} /></label>
        {mic.on ? <RecBar r={mic.rec} label="說出要改什麼" stopLabel="說完了" hint="例如「第 2 段換泳池、價格字再大」" />
          : mic.busy ? <SttBar /> : <>
            {/* a chat box, not a form field: no password / card / address autofill */}
            <textarea ref={taRef} value={text} onChange={e => setText(e.target.value)} rows={2} name="instruction" autoComplete="off" autoCapitalize="off" spellCheck={false} lang="zh-Hant" {...{ 'data-lpignore': 'true', 'data-1p-ignore': '' }}
              placeholder={uploading ? '上傳中，完成後再送出…' : PLACEHOLDER[stage]}
              onKeyDown={e => {
                // Enter sends only on desktop, never while the IME (注音／拼音) is still composing, and never on phones
                // (there Enter is a newline; send with the button). Shift+Enter is always a newline.
                const composing = e.nativeEvent.isComposing || e.keyCode === 229
                if (e.key === 'Enter' && !e.shiftKey && !composing && !IS_TOUCH) { e.preventDefault(); send() }
              }} />
            {mic.available && <button type="button" className="attach mic" title="語音輸入（按一下開始說）" aria-label="語音輸入" onClick={mic.toggle}><MicIcon /></button>}
            <button className="btn primary" onClick={send} disabled={running || uploading || (!text.trim() && !DEFAULT_CHIP[stage])}>{!text.trim() && DEFAULT_CHIP[stage] ? DEFAULT_CHIP[stage] : '送出'}</button>
            {!IS_TOUCH && <span className="composer-hint muted small">Enter 送出 · Shift+Enter 換行 · 🎙 可以用說的</span>}
          </>}
      </footer>}
      </>}
    </div>
  )
}

/* 需求摘要: the first message is the wizard's whole brief (theme, footage, selling points, style, length, caption
   style, adjustments, voice) — far too much to read back. Both modes show the gist as chips; 導演模式 can unfold it. */
const BRIEF_KEYS: [RegExp, string][] = [[/^主題：/, '主題'], [/^風格：/, '風格'], [/^長度：/, '長度'], [/^字幕樣式：/, '字幕'], [/^字型：/, '字型'], [/^標題樣式：/, '標題'], [/^旁白用 /, '聲音'], [/^不要配音/, '聲音']]
function BriefCard({ text, easy }: { text: string; easy: boolean }) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const chips: { k: string; v: string }[] = []
  const free: string[] = []
  let adjust = 0
  for (const l of lines) {
    const hit = BRIEF_KEYS.find(([re]) => re.test(l))
    if (hit) {
      let v = l.replace(hit[0], '').split(/[。（(]/)[0].replace(/^(旅遊短影音|質感形象片|促銷活動|短版|標準|完整導覽)\b.*/, '$1').trim()
      if (hit[1] === '聲音') v = l.startsWith('不要配音') ? '不配音，只有字幕' : l.replace(/^旁白用 /, '').split('（')[0]
      if (hit[1] === '主題') v = v.replace(/（.*$/, '')
      if (hit[1] === '長度') v = v.split(' ')[0]
      if (!chips.some(c => c.k === hit[1])) chips.push({ k: hit[1], v })
    } else if (/^調整：/.test(l)) adjust++
    else if (/^素材(已上傳|在這個)|^我上傳了 \d+ 支素材/.test(l)) { /* footage line: implied */ }
    else free.push(l)
  }
  const gist = free.join(' ').replace(/https?:\/\/\S+\s*。?/g, '').replace(/^素材在\s*/, '').replace(/^賣點：/, '').trim()
  return (
    <div className="brief">
      <div className="brief-h">你的需求</div>
      {gist && <div className="brief-gist">{gist.length > 90 ? gist.slice(0, 90) + '…' : gist}</div>}
      <div className="brief-chips">{chips.map(c => <span key={c.k}><i>{c.k}</i>{c.v}</span>)}{adjust > 0 && <span><i>調整</i>{adjust} 處</span>}</div>
      {!easy && <details className="brief-more"><summary>看完整需求</summary><pre>{text}</pre></details>}
    </div>
  )
}

function Bubble({ m, assets, onOpenFiles, onRecord, easy = false, brief = false }: { m: Msg; assets: Asset[]; onOpenFiles?: () => void; onRecord?: (lines: Line[]) => void; easy?: boolean; brief?: boolean }) {
  if (brief) return <BriefCard text={m.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n')} easy={easy} />
  // Consecutive tool parts collapse into one quiet "did N steps" line; the editor's words stay prominent.
  const groups: ({ kind: 'text'; text: string } | { kind: 'tools'; names: string[] })[] = []
  for (const p of m.parts) {
    const last = groups[groups.length - 1]
    if (p.type === 'text') groups.push({ kind: 'text', text: p.text })
    else if (last && last.kind === 'tools') last.names.push(p.name)
    else groups.push({ kind: 'tools', names: [p.name] })
  }
  if (easy && m.role === 'user') {
    const t = m.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n')
    return <details className="ez-user"><summary>你送出的需求</summary><div>{t}</div></details>
  }
  if (easy && m.role === 'assistant') {
    // 輕鬆模式: one conclusion line, the deliverables, and everything else behind 看細節.
    const texts = groups.filter(g => g.kind === 'text').map(g => (g as { text: string }).text).join('\n\n')
    const { head, rest } = splitConclusion(texts)
    const tools = groups.filter(g => g.kind === 'tools').flatMap(g => (g as { names: string[] }).names)
    const more = rest.trim().length > 0 || tools.length > 0
    return (
      <div className="bubble assistant ez">
        {head && <div className="ez-head">{head}</div>}
        {assets.map(a => <AssetCard key={a.id} a={a} onOpenFiles={onOpenFiles} />)}
        {more && (
          <details className="ez-more">
            <summary>看細節</summary>
            {rest.trim() && <Md text={rest} onRecord={onRecord} />}
            {tools.length > 0 && <div className="muted small">做了 {tools.length} 步：{[...new Set(tools.map(n => TOOL_LABEL[n] ?? n))].join('、')}</div>}
          </details>
        )}
      </div>
    )
  }
  return (
    <div className={`bubble ${m.role}`}>
      {groups.map((g, i) => g.kind === 'text'
        ? <Md key={i} text={g.text} onRecord={m.role === 'assistant' ? onRecord : undefined} />
        : (
          <details key={i} className="steps-done">
            <summary><span className="chev" />做了 {g.names.length} 步<span className="muted">· {[...new Set(g.names.map(n => TOOL_LABEL[n] ?? n))].slice(0, 4).join(' → ')}{g.names.length > 4 ? ' …' : ''}</span></summary>
            <ol className="steps">{g.names.map((n, k) => <li key={k} className="sx ok"><ToolIcon name={n} /><span className="sx-label">{TOOL_LABEL[n] ?? n}</span><span className="sx-meta">完成</span></li>)}</ol>
          </details>
        ))}
      {assets.map(a => <AssetCard key={a.id} a={a} onOpenFiles={onOpenFiles} />)}
    </div>
  )
}

/* Markdown with a little semantics: paragraphs that open with ⚠ / ✅ / 請確認 become callouts, so a
   warning, a confirmation request and a plain sentence don't all look the same. */
function Md({ text, onRecord }: { text: string; onRecord?: (lines: Line[]) => void }) {
  // ```旁白 blocks become script cards; the rest is markdown
  const parts: ({ md: string } | { lines: Line[] })[] = []
  let last = 0
  for (const m of text.matchAll(SCRIPT_BLOCK)) {
    if (m.index! > last) parts.push({ md: text.slice(last, m.index) })
    const lines = parseScript(m[1])
    parts.push(lines.length ? { lines } : { md: m[0] })
    last = m.index! + m[0].length
  }
  if (parts.length) {
    if (last < text.length) parts.push({ md: text.slice(last) })
    return <>{parts.map((p, i) => 'lines' in p ? <ScriptCard key={i} lines={p.lines} onRecord={onRecord ? () => onRecord(p.lines) : undefined} /> : <MdHtml key={i} text={p.md} />)}</>
  }
  return <MdHtml text={text} />
}

function MdHtml({ text }: { text: string }) {
  let html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string)
  html = html
    .replace(/<p>(⚠|注意[:：]|請確認|請注意)/g, '<p class="callout warn">$1')
    .replace(/<p>(✅|完成[:：]|已完成)/g, '<p class="callout ok">$1')
    .replace(/<p>(❓|問題[:：]|請選擇|要不要)/g, '<p class="callout ask">$1')
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

export function AssetCard({ a, onOpenFiles }: { a: Asset; onOpenFiles?: () => void }) {
  const mb = a.meta?.size_mb ? ` · ${a.meta.size_mb} MB` : ''
  if (a.version != null) {  // exported videos & covers live in the 成品 tab; keep the thread light
    if (a.role && a.role !== 'upload' && a.kind === 'video') return null
    return (
      <div className="deliv-note">
        <span className="pill final">{verLabel(a.version)}</span>
        <span>{a.kind === 'image' ? a.name : `影片已輸出${mb}`}</span>
        <a onClick={onOpenFiles}>看成品</a>
      </div>
    )
  }
  return (
    <div className="asset">
      {a.kind === 'video' && <video src={a.url} controls preload="metadata" />}
      {a.kind === 'audio' && <audio src={a.url} controls preload="metadata" />}
      {a.kind === 'image' && <img src={a.url} alt={a.name} />}
      <div className="asset-meta"><span>{a.name}{mb}</span><a href={a.url} download>下載</a></div>
    </div>
  )
}


/* Right-hand "this is what you'll get" panel of the onboarding wizard: changes with the step and the choices. */
function ObPreview({ projectId, step, style, length, voiceName, uploads, linkOk, text, analysis, analyzing }:
  { projectId: string; step: number; style: string; length: string; voiceName: string | null; uploads: number; linkOk: boolean; text: string; analysis: Analysis | null; analyzing: boolean }) {
  const st = STYLES.find(x => x.id === style) ?? STYLES[0]
  const textPlace = (text.match(/^(.{2,12}?)(的|，|、|。)/) || [])[1]
  const sumPlace = (analysis?.summary.match(/^(.{2,12}?)(的|，|、|。|$)/) || [])[1]
  const place = (analysis ? sumPlace : textPlace) || textPlace || '宜蘭海邊包棟'
  const hook = analysis?.script[0]?.text
  const price = (text.match(/NT\$\s?[\d,]{3,}|[\d,]{3,}\s?元/) || [])[0]
  // real frames for the cover mock-ups: the hook shot, and the next different clip
  const sb = analysis?.storyboard ?? []
  const frameA = sb[0] ? api.frameUrl(projectId, sb[0].clip, sb[0].t, true) : null
  const altB = sb.find(x => x.clip !== sb[0]?.clip) ?? sb[1]
  const frameB = altB ? api.frameUrl(projectId, altB.clip, altB.t, true) : null
  const altC = sb.find(x => x.clip !== sb[0]?.clip && x.clip !== altB?.clip) ?? sb[2] ?? sb[0]
  const frameC = altC ? api.frameUrl(projectId, altC.clip, altC.t, true) : null
  return (
    <aside className="ob-prev">
      <div className="ob-prev-head">
        <span className="eyebrow">{step === 2 ? '15 分鐘後你會拿到' : step === 1 ? (analysis ? '封面會像這樣' : analyzing ? '解析完你會看到' : '解析完你會看到') : '選好或貼好，剪輯師會自己把素材抓下來'}</span>
        {step === 1 && analysis && <span className="ob-prev-sub">完成時會有 2–3 款可選</span>}
      </div>
      {step === 1 && !analysis && (
        <div className="ob-prev-an">
          <div className="pa-chips">{['無邊際泳池看海', '包棟', '龜山島日出', '寵物友善'].map((c, i) => <span key={c} className={i === 0 ? 'top' : ''}>{c}</span>)}</div>
          {[['開場', '泳池全景', '宜蘭海邊，推開門就是泳池'], ['賣點', '客廳＋KTV', '包棟，唱到半夜也沒人管'], ['價格', '房間窗景', '平日每人（價格）'], ['行動', '海邊日落', '點連結查空房']].map(([r, s, l], i) => (
            <div key={r} className={`pa-row ${analyzing ? 'wait' : ''}`} style={{ animationDelay: `${i * .25}s` }}>
              <span className={`pa-fr f${i}`} /><span className="pa-main"><b>{i + 1}</b><em>{r}</em><span>{s}</span><small>「{l}」</small></span>
            </div>))}
          <div className="pa-est"><span>第一版＋封面 <b>64 點</b></span><span>含 2 輪修改 <b>100 點</b></span></div>
          <div className="muted small">示意。你的素材解析完會換成真的畫面與賣點。</div>
        </div>
      )}
      {step === 1 && analysis && (
        <div className="pc-set">
          <div className={`pc pc-${style}`}>
            {frameA && <img src={frameA} alt="" />}
            <div className="pc-grad" />
            <div className="pc-top">{analysis.selling_points.slice(1, 3).map(x => shortPt(x, 8)).join(' · ')}</div>
            <div className="pc-title">{place}<em>{shortPt(analysis.selling_points[0])}</em></div>
            <div className="pc-price">{price ?? '價格補上後會放這裡'}</div>
            <span className="pc-tag">1 · 這款的概念</span>
          </div>
          {/* the other variants: same facts, different picture and layout — the real ones come with the video */}
          <div className="pc-alts" aria-label="其他款">
            <div className={`pc-alt v2 pc-${style}`}>{frameB && <img src={frameB} alt="" />}<i /><b>{shortPt(analysis.selling_points[0], 8)}</b><em>{price ?? '價格'}</em><span>2</span></div>
            <div className={`pc-alt v3 pc-${style}`}>{frameC && <img src={frameC} alt="" />}<i /><b>{place}</b><em>{shortPt(analysis.selling_points[1] ?? analysis.selling_points[0], 8)}</em><span>3</span></div>
            <div className="pc-alts-note muted small">另外 1–2 款換畫面和排版，做好一起給你挑</div>
          </div>
        </div>
      )}
      {step === 0 && (
        <div className="ob-prev-up">
          {[['DJI_0001.MP4', 'a', '影片'], ['IMG_5540.JPG', 'b', '照片'], ['DJI_0007.MP4', 'c', '影片']].map(([n, c, k], i) => (
            <div key={n} className={`ps-uqrow ok ${i < Math.max(uploads, linkOk ? 3 : 0) ? 'real' : ''}`} style={{ animationDelay: `${i * .2}s` }}>
              <span className={`ps-th ${c}`}><i className={k === '照片' ? 'photo' : ''}>{k}</i></span>
              <span className="ps-uqmain"><span className="ps-uqname">{n}</span><small>完成</small><span className="ps-uqbar"><i style={{ width: '100%' }} /></span></span><em>✓</em>
            </div>))}
          <div className="muted small">資料夾裡的每一個影片、照片剪輯師都會自己看完，挑最好的畫面。{uploads > 0 && <b> 你已經上傳 {uploads} 個。</b>}</div>
        </div>
      )}
      {step === 2 && (
        <div className="ob-prev-done">
          <div className="ps-vhead"><b>初版</b><span className="ps-pill">成品</span><small>影片＋封面 · {st.name} · {(LENGTHS.find(l => l.id === length) ?? LENGTHS[1]).secs}</small></div>
          <div className="ps-result">
            <div className={`ps-video ob-style ${style}`}>
              <div className="ps-super">{st.id === 'promo' ? '限時優惠 · 只到月底' : st.id === 'premium' ? place : analysis?.selling_points.slice(1, 3).map(x => shortPt(x, 10)).join(' · ') || 'KTV · 電動麻將 · 寵物友善'}</div>
              <div className="ps-headline">{st.id === 'promo' ? <>平日每人<br /><em>NT$1,500</em></> : st.id === 'premium' ? <>海的旁邊<br /><em>一棟只給你們</em></> : <>{place}<br /><em>{shortPt(analysis?.selling_points[0]) || '25米戲水池'}</em></>}</div>
              {voiceName && <div className="ps-narr"><i className="ps-mic" /><span className="ps-wave"><b /><b /><b /><b /><b /><b /></span><small>{voiceName} 旁白</small></div>}
              <div className="ps-sub">{st.id === 'promo' ? '現在訂省 NT$500' : st.id === 'premium' ? '慢下來，聽海' : hook || '推開窗就是龜山島海景'}</div>
              <div className="ps-play" />
              <div className="ob-style-note">{st.id === 'promo' ? '價格開頭、節奏強' : st.id === 'premium' ? '慢節奏、長鏡頭、少字' : '前 3 秒放最強賣點、快剪'}{voiceName ? '' : ' · 只有配樂與字幕'}</div>
            </div>
            <div className="ps-covers">
              <div className={`ps-cover a ${frameA ? 'real' : ''}`} style={frameA ? { backgroundImage: `url(${frameA})` } : undefined}><span>封面 A</span><b>{place}</b><em>{price ?? 'NT$1,500'}</em></div>
              <div className={`ps-cover b ${frameB ? 'real' : ''}`} style={frameB ? { backgroundImage: `url(${frameB})` } : undefined}><span>封面 B</span><b>{shortPt(analysis?.selling_points[0], 10) || '25 米戲水池'}</b><em>{price ? `平日每人 ${price}` : '平日每人 1,500'}</em></div>
            </div>
          </div>
          <div className="muted small">做好會自動歸檔到「成品」頁，可以一鍵分享給朋友。</div>
        </div>
      )}
    </aside>
  )
}
