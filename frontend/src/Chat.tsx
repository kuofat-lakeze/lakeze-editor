import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { api, type Analysis, type Asset, type Me, type Msg, type ProjectDetail, type Voice } from './api'
import { Deliverables } from './Deliverables'
import { VoiceCloneDialog } from './VoiceClone'
import { DropZone, MAX_FILES, MAX_FILE_BYTES, UploadQueue, fmtMB, type Up } from './Uploads'
import { fmtBytes } from './Storage'

type Live = { text: string; thinking: string; tools: { name: string; status: 'run' | 'ok' | 'err'; seconds?: number; summary?: string; charged?: number; balance?: number; startedAt?: number }[] }
const fmtDur = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒` }
const emptyLive = (): Live => ({ text: '', thinking: '', tools: [] })
const IN_APP = /Line\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(navigator.userAgent)
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
const IS_TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
/* Speech: browser-native, free. Mic = 語音輸入 (Web Speech API, zh-TW); speaker = 朗讀 (speechSynthesis). */
type SR = { lang: string; continuous: boolean; interimResults: boolean; start(): void; stop(): void; onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null }
const SRCtor = (window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR }).SpeechRecognition
  ?? (window as unknown as { webkitSpeechRecognition?: new () => SR }).webkitSpeechRecognition
const CAN_TTS = typeof speechSynthesis !== 'undefined'
const plain = (md: string) => md.replace(/```[\s\S]*?```/g, '').replace(/[*_`#>|]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/\n{2,}/g, '。').trim()
function useMic(onText: (t: string) => void) {
  const [on, setOn] = useState(false)
  const rec = useRef<SR | null>(null)
  const stop = () => { rec.current?.stop(); rec.current = null; setOn(false) }
  const start = () => {
    if (!SRCtor) return
    const r = new SRCtor(); r.lang = 'zh-TW'; r.continuous = true; r.interimResults = true
    let committed = ''
    r.onresult = e => {
      let final = '', interim = ''
      for (let i = 0; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) final += t; else interim += t }
      if (final !== committed) { onText(final.slice(committed.length)); committed = final }
      void interim
    }
    r.onend = () => { rec.current = null; setOn(false) }; r.onerror = () => { rec.current = null; setOn(false) }
    rec.current = r; r.start(); setOn(true)
  }
  useEffect(() => () => rec.current?.stop(), [])
  return { on, toggle: () => (on ? stop() : start()), available: !!SRCtor }
}
const MicIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5a4 4 0 0 0 4 4zm7-4a7 7 0 0 1-14 0M12 18v3M8 21h8" />
  </svg>
)
const SpeakIcon = ({ on }: { on: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5 6 9H2v6h4l5 4z" />{on ? <path d="M23 9l-6 6M17 9l6 6" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />}
  </svg>
)
/* One utterance at a time across the whole thread. */
let speakingId: string | number | null = null
const speakListeners = new Set<() => void>()
function speakToggle(id: string | number, text: string) {
  if (!CAN_TTS) return
  const was = speakingId === id
  speechSynthesis.cancel(); speakingId = null
  if (!was) {
    const u = new SpeechSynthesisUtterance(plain(text)); u.lang = 'zh-TW'; u.rate = 1.05
    const v = speechSynthesis.getVoices().find(v => /zh[-_]TW/i.test(v.lang)) ?? speechSynthesis.getVoices().find(v => /^zh/i.test(v.lang))
    if (v) u.voice = v
    u.onend = u.onerror = () => { if (speakingId === id) { speakingId = null; speakListeners.forEach(f => f()) } }
    speakingId = id; speechSynthesis.speak(u)
  }
  speakListeners.forEach(f => f())
}
function useSpeaking(id: string | number) {
  const [, tick] = useState(0)
  useEffect(() => { const f = () => tick(x => x + 1); speakListeners.add(f); return () => { speakListeners.delete(f) } }, [])
  return speakingId === id
}
const CRIOS = /CriOS|FxiOS|EdgiOS/.test(navigator.userAgent)  // third-party iOS browsers: file picker is flakier than Safari
type Stage = 'start' | 'working' | 'progress' | 'revise'
const PLACEHOLDER: Record<Stage, string> = {
  start: '貼 Drive 連結＋賣點、價格、語氣…',
  working: '剪輯師工作中，可以先輸入下一步想法…',
  progress: '回覆剪輯師，或直接說「照建議做」…',
  revise: '要改哪裡？例如：價格字幕放大…',
}
const CHIPS: Record<Stage, string[]> = {
  start: [], working: [],
  progress: ['照建議做', '先給我看分鏡', '旁白稿先給我看'],
  revise: ['價格字幕放大一點', '換一張封面畫面', '旁白慢一點', '配樂小聲一點', '第一句換成游泳池畫面'],
}
const NO_VOICE = 'none'
const OB_STEPS = ['給素材', '解析素材', '風格與賣點']
const ANALYZE_POINTS = 14
const ROLE_LABEL: Record<string, string> = { hook: '開場', feature: '賣點', price: '價格', cta: '行動' }
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

export function Chat({ projectId, name, onUsage, onTopUp, onCredits, onStorage, onProjectsChanged }:
  { projectId: string; name?: string; onUsage: () => void; onTopUp: (needPoints?: number) => void; onCredits?: () => void; onStorage?: () => void; onProjectsChanged?: () => void }) {
  const [tab, setTab] = useState<'chat' | 'files'>('chat')
  const [proj, setProj] = useState<ProjectDetail | null>(null)
  const [live, setLive] = useState<Live>(emptyLive())
  const [running, setRunning] = useState(false)
  const [text, setText] = useState('')
  const mic = useMic(t => setText(x => (x ? x.replace(/\s*$/, '') : '') + t))
  const [err, setErr] = useState('')
  const [needCredits, setNeedCredits] = useState<{ needed: number; balance: number } | null>(null)
  const [needStorage, setNeedStorage] = useState<{ used_bytes: number; quota_bytes: number } | null>(null)
  const [uploads, setUploads] = useState<Up[]>([])
  const prog = useRef<Record<string, { t: number; l: number; rate: number }>>({})
  const [picking, setPicking] = useState(false)
  const [pickFail, setPickFail] = useState(false)
  const [style, setStyle] = useState('travel')
  const [obStep, setObStep] = useState(0)
  const [link, setLink] = useState('')
  // 先解析素材 (wizard step 2): one call that returns selling points, storyboard, script and the estimate
  const [analyzing, setAnalyzing] = useState(false)
  const [anStart, setAnStart] = useState(0)
  const [anErr, setAnErr] = useState('')
  const [anNeed, setAnNeed] = useState<{ needed: number; balance: number } | null>(null)
  const [skipAn, setSkipAn] = useState(false)
  const [picked, setPicked] = useState<string[] | null>(null)   // selling points the user kept (null = all)
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
    if (!proj || proj.messages.length) return
    api.voices().then(vs => { setVoices(vs); setVoice(v => v ?? vs[0]?.voice_id ?? NO_VOICE) }).catch(() => setVoice(NO_VOICE))
    api.me().then(setMe).catch(() => {})
  }, [proj?.id, proj?.messages.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const onCloned = (v: Voice) => {
    setCloning(false)
    setVoices(vs => [v, ...vs.filter(x => !x.custom)]); setVoice(v.voice_id)
    api.me().then(setMe).catch(() => {})
  }
  const preview = (v: Voice) => {
    if (!v.preview_url) return
    if (playing === v.voice_id) { audioRef.current?.pause(); setPlaying(null); return }
    audioRef.current?.pause()
    const a = new Audio(v.preview_url); audioRef.current = a; setPlaying(v.voice_id)
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
  const linkOk = /drive\.google\.com\/drive\/folders\//.test(link)
  const analysis = proj?.analysis ?? null
  const hasFootage = linkOk || okUploads > 0 || !!analysis
  const canStart = hasFootage && text.trim().length > 0 && !uploading && voice !== null
  const obDone = [hasFootage, !!analysis || skipAn, text.trim().length > 0 && voice !== null]
  const start = async () => {
    if (!canStart || running) return
    const st = STYLES.find(x => x.id === style) ?? STYLES[0]
    const v = voices.find(x => x.voice_id === voice)
    const parts = [
      analysis ? `素材已上傳並解析過（${analysis.n_clips} 個）。` : linkOk ? `素材在 ${link.trim()} 。` : `我上傳了 ${okUploads} 支素材。`,
      text.trim(),
      st.brief,
      voice === NO_VOICE ? '不要配音：只要配樂和字幕，賣點用字幕呈現。'
        : v ? `旁白用 ${v.name}（voice_id ${v.voice_id}），直接做到輸出影片和封面，不用再問我選聲音或確認稿子。` : '',
    ]
    api.clientLog('start_project', { style: st.id, voice, link: linkOk, uploads: okUploads, analysis: !!analysis })
    await submit(parts.filter(Boolean).join('\n'), !!analysis)
  }
  const runAnalyze = async () => {
    if (analyzing || running) return
    setAnalyzing(true); setAnErr(''); setAnNeed(null); setAnStart(Date.now())
    api.clientLog('analyze_start', { link: linkOk && !okUploads, uploads: okUploads })
    try {
      const a = await api.analyze(projectId, { brief: text.trim(), drive_url: linkOk && !okUploads ? link.trim() : '' })
      atBottom.current = false   // land on the selling points, not the bottom of the card
      setProj(p => p && { ...p, analysis: a }); setPicked(null); setSkipAn(false)
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
  // Step 2 → 3: the kept selling points become the brief (the user can still edit it).
  const useAnalysis = () => {
    if (analysis && !text.trim()) {
      const miss = analysis.missing.filter(m => /價格|店名|名稱/.test(m)).map(m => `${m.replace(/^補充?/, '')}：`)
      setText([`賣點：${pickedPoints.join('、')}`, ...miss].join('\n'))
    }
    goStep(2)
  }
  const copyScript = () => { if (analysis) navigator.clipboard?.writeText(analysis.script.map(l => l.text).join('\n')).catch(() => {}) }
  const send = async () => {
    const t = text.trim(); if (!t || running) return
    await submit(t)
  }
  const submit = async (t: string, withAnalysis = false) => {
    setErr(''); setText(''); setNeedCredits(null); setNeedStorage(null); atBottom.current = true; turnStart.current = Date.now()
    setProj(p => p && { ...p, messages: [...p.messages, { id: 'tmp', role: 'user', parts: [{ type: 'text', text: t }], created_at: '' }] })
    try { await api.send(projectId, t, withAnalysis ? { with_analysis: true } : {}); setLive(emptyLive()); listen() } catch (e) { setErr((e as Error).message) }
  }

  const patchUp = (id: string, u: Partial<Up>) => setUploads(us => us.map(x => (x.id === id ? { ...x, ...u } : x)))
  const runUpload = async (up: Up) => {
    patchUp(up.id, { status: 'up', loaded: 0, error: undefined, rate: undefined })
    prog.current[up.id] = { t: Date.now(), l: 0, rate: 0 }
    const t0 = Date.now()
    try {
      await api.uploadOne(projectId, up.file, loaded => {
        const pr = prog.current[up.id]; const now = Date.now(); const dt = (now - pr.t) / 1000
        if (dt >= 0.5) { const inst = (loaded - pr.l) / dt; pr.rate = pr.rate ? pr.rate * 0.7 + inst * 0.3 : inst; pr.t = now; pr.l = loaded }
        patchUp(up.id, { loaded, rate: pr.rate || undefined })
      })
      patchUp(up.id, { status: 'ok', loaded: up.size })
      api.clientLog('upload_ok', { name: up.name, size: up.size, seconds: (Date.now() - t0) / 1000 })
      return true
    } catch (e) {
      const msg = (e as Error).message
      patchUp(up.id, { status: 'err', error: msg })
      api.clientLog('upload_err', { name: up.name, size: up.size, seconds: (Date.now() - t0) / 1000, error: msg })
      return false
    }
  }
  const onFiles = async (files: FileList | File[] | null) => {
    setPicking(false); setPickFail(false)
    const list = Array.from(files ?? [])
    api.clientLog('files_selected', { n: list.length, files: list.map(f => ({ name: f.name, size: f.size, type: f.type })) })
    if (!list.length) return
    setErr('')
    if (list.length > MAX_FILES) { setErr(`一次最多上傳 ${MAX_FILES} 個，這次只會傳前 ${MAX_FILES} 個，其餘請再選一次。`); list.splice(MAX_FILES) }
    const ups: Up[] = list.map(f => ({ id: Math.random().toString(36).slice(2, 10), file: f, name: f.name || 'clip.mp4', size: f.size, loaded: 0,
      status: f.size > MAX_FILE_BYTES ? 'err' : 'wait', error: f.size > MAX_FILE_BYTES ? `超過 1 GB 上限（${fmtMB(f.size)}），請先壓縮，或放到 Google Drive 貼連結` : undefined }))
    setUploads(us => [...us, ...ups])
    let ok = 0
    for (const up of ups) {
      if (up.status === 'err') { api.clientLog('upload_skipped_too_large', { name: up.name, size: up.size }); continue }
      if (await runUpload(up)) ok++
    }
    if (ok && proj && proj.messages.length > 0) setText(t => t || `我上傳了 ${ok} 支素材，請先分析。`)
  }
  const retryUpload = (id: string) => setUploads(us => { const u = us.find(x => x.id === id); if (u) queueMicrotask(() => { runUpload(u) }); return us })
  const removeUpload = (id: string) => setUploads(us => us.filter(u => u.id !== id))
  const pick = () => { setPicking(true); setPickFail(false); api.clientLog('picker_open') }
  // iOS never tells the page that the picker was dismissed. If no change event arrives, show the workarounds.
  useEffect(() => {
    if (!picking) return
    const t = setTimeout(() => { setPicking(false); setPickFail(true); api.clientLog('picker_no_file_60s') }, 60000)
    return () => clearTimeout(t)
  }, [picking])

  if (!proj) return <div className="center muted">載入中…</div>
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
      </header>
      {tab === 'files' && <Deliverables key={`${projectId}:${proj.assets.length}:${proj.exports ?? 0}`} projectId={projectId} onStorage={onStorage} onChanged={() => { reload(); onProjectsChanged?.() }} />}
      {tab === 'chat' && <>
      <div className="thread" ref={threadRef} onScroll={onScroll}>
        {IN_APP && (
          <div className="card need">
            你現在是在 LINE / FB 等 App 的內建瀏覽器，這類瀏覽器通常不能選影片上傳。
            請點右上角「⋯」選「用 Safari / Chrome 開啟」，或改貼 Google Drive 連結。
          </div>
        )}
        {stage === 'start' && (
          <div className="ob-wiz">
            <div className="ob-prog">
              {OB_STEPS.map((t, i) => (
                <a key={t} className={`ob-pn ${i === obStep ? 'on' : ''} ${obDone[i] ? 'done' : ''}`} onClick={() => i <= obStep || obDone[i - 1] ? goStep(i) : null}>
                  <i>{obDone[i] && i !== obStep ? '✓' : i + 1}</i><span>{t}</span>
                </a>
              ))}
              <span className="ob-count muted small">第 {obStep + 1} 步，共 3 步 · 註冊送的 110 點夠做第一支</span>
            </div>

            <div className="ob-main">
              <section className="card ob-card" key={obStep}>
                {obStep === 0 && (
                  <>
                    <h3>先把素材給剪輯師</h3>
                    <p className="muted">手機拍的影片、照片都可以，一次建議 6 個以內（最多 30 個）。選好就會自動上傳。</p>
                    <div className={`spot ${!(linkOk || okUploads > 0) ? 'on' : ''}`}>
                      {!(linkOk || okUploads > 0) && !uploading && <span className="coach">點這裡選影片</span>}
                      <DropZone onFiles={onFiles} onPick={pick} disabled={uploading} count={okUploads} />
                    </div>
                    {uploads.length > 0 && <UploadQueue ups={uploads} onRetry={retryUpload} onRemove={removeUpload} onClose={() => setUploads([])} hint={IOS ? '請保持在這個畫面' : undefined} />}
                    <details className="ob-alt" open={!!link}>
                      <summary className="small">素材在 Google Drive？貼資料夾連結</summary>
                      <input className="link" placeholder="https://drive.google.com/drive/folders/…（設為「知道連結的人都能檢視」）" value={link}
                        onChange={e => setLink(e.target.value)} inputMode="url" autoComplete="off" />
                    </details>
                    <div className="ob-nav">
                      <span className="muted small">{analysis ? `已有 ${analysis.n_clips} 個素材（已解析）` : linkOk ? 'Drive 連結已就緒' : okUploads > 0 ? `已上傳 ${okUploads} 個素材` : uploading ? '上傳中…' : '還沒有素材'}</span>
                      <button className={`btn primary ${hasFootage && !uploading ? 'glow' : ''}`} disabled={!hasFootage || uploading} onClick={() => goStep(1)}>下一步：解析素材 →</button>
                    </div>
                  </>
                )}
                {obStep === 1 && !analysis && (
                  <>
                    <h3>{analyzing ? '剪輯師正在看素材' : '先讓剪輯師看一遍素材'}</h3>
                    <p className="muted">不確定要主打什麼？按一下，剪輯師會看完每個畫面，列出<b>賣點、分鏡、旁白逐字稿</b>，還有做這支大約<b>要花幾點</b>。之後正式開剪，素材分析這一步不再重複扣點。</p>
                    {analyzing ? (
                      <div className="an-run">
                        <div className="an-run-head"><span className="spinner" /><b>解析中</b><span className="muted">· 已 {fmtDur(now - anStart)} · 通常 1–2 分鐘{linkOk && !okUploads ? '，Drive 素材要先下載會更久' : ''}</span></div>
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
                            {['有哪些賣點', '分鏡怎麼排', '旁白逐字稿', '預估要花幾點'].map(x => <span key={x}>✓ {x}</span>)}
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
                      {!analyzing && <a className="small muted" onClick={() => { setSkipAn(true); goStep(2) }}>我自己知道賣點，跳過 →</a>}
                    </div>
                  </>
                )}
                {obStep === 1 && analysis && (
                  <>
                    <h3>剪輯師看完了：{analysis.summary || `${analysis.n_clips} 個素材`}</h3>
                    <p className="muted">點掉不想主打的賣點，其餘會帶進下一步。分鏡和旁白稿是草案，正式剪的時候剪輯師會再微調。</p>
                    <div className="an-sec">
                      <div className="an-h"><b>賣點</b><span className="muted small">留 {pickedPoints.length} 個</span></div>
                      <div className="an-chips">
                        {analysis.selling_points.map((s, i) => (
                          <a key={s} className={`an-chip ${pickedPoints.includes(s) ? 'on' : ''} ${i === 0 ? 'top' : ''}`} onClick={() => togglePoint(s)}>{i === 0 && <em>最強</em>}{s}</a>))}
                      </div>
                    </div>
                    <div className="an-sec">
                      <div className="an-h"><b>分鏡與旁白稿</b><span className="muted small">{analysis.storyboard.length} 個鏡頭 · 約 {Math.round(analysis.total_seconds)} 秒</span><a className="small" onClick={copyScript}>複製逐字稿</a></div>
                      <ol className="an-sb">
                        {analysis.storyboard.map(s => {
                          const line = analysis.script.find(l => l.n === s.n)
                          return (
                            <li key={s.n} className={`an-shot ${s.role}`}>
                              <span className="an-fr"><img src={api.frameUrl(projectId, s.clip, s.t)} alt="" loading="lazy" /><i>#{String(s.clip).padStart(2, '0')} · {s.dur}s</i></span>
                              <span className="an-shot-main">
                                <span className="an-shot-top"><b>{s.n}</b><em className={`an-role ${s.role}`}>{ROLE_LABEL[s.role]}</em><span>{s.shot}</span></span>
                                {line && <span className="an-line">「{line.text}」</span>}
                              </span>
                            </li>)
                        })}
                      </ol>
                      {analysis.transcript_notes && <div className="muted small">現場音：{analysis.transcript_notes}</div>}
                    </div>
                    {analysis.missing.length > 0 && (
                      <div className="an-sec an-miss">
                        <b>還缺</b>{analysis.missing.map(m => <span key={m} className="pill">{m}</span>)}<span className="muted small">下一步可以補在賣點裡，或之後再補拍。</span>
                      </div>
                    )}
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
                    <h3>最後：賣點、風格、聲音</h3>
                    <p className="muted">{analysis ? '賣點已經幫你填好，想改就改；加上價格、店名、語氣更好。' : '地點、特色、價格、語氣，想到什麼寫什麼。不會寫就按「給我範例」。'}</p>
                    <div className={`spot ${!text.trim() ? 'on' : ''}`}>
                      {!text.trim() && <span className="coach">在這裡打字</span>}
                      <textarea rows={4} value={text} onChange={e => setText(e.target.value)} autoFocus={!text}
                        placeholder={'例：宜蘭海邊的包棟民宿，25 米戲水池、龜山島海景、KTV、電動麻將、寵物友善。價格「平日每人 NT$1,500」。語氣輕鬆活潑。'} />
                      {mic.available && <button type="button" className={`attach mic ob-mic ${mic.on ? 'on' : ''}`} title="用說的" aria-label="語音輸入" onClick={mic.toggle}><MicIcon /></button>}
                    </div>
                    {mic.on && <div className="muted small">聽寫中… 說完再按一次麥克風。</div>}
                    <div className="chips inline">
                      {!analysis && <a className="chipbtn on" onClick={() => setText(EXAMPLE_BRIEF)}>給我範例</a>}
                      {['地點：', '價格：平日每人 NT$', '店名：', '語氣：輕鬆活潑'].map(c => (
                        <a key={c} className="chipbtn" onClick={() => setText(t => (t ? t.replace(/\s*$/, '\n') : '') + c)}>{c}</a>))}
                    </div>
                    <div className="muted small ob-sub">風格</div>
                    <div className="styles">
                      {STYLES.map(st => (
                        <div key={st.id} className={`stylec ${style === st.id ? 'sel' : ''}`} onClick={() => setStyle(st.id)}>
                          <div className="stylec-name">{st.name}{st.tag && <span className="pill">{st.tag}</span>}</div>
                          <div className="muted small">{st.desc}</div>
                        </div>
                      ))}
                    </div>
                    <div className="muted small ob-sub">旁白聲音</div>
                    <div className="voice-row">
                      {voices.map(v => (
                        <div key={v.voice_id} className={`voice ${voice === v.voice_id ? 'sel' : ''} ${v.custom ? 'mine' : ''}`} onClick={() => setVoice(v.voice_id)}>
                          <div className="voice-name">{v.custom && <span className="mine-tag">我的聲音</span>}{v.name}<span className="muted small"> {v.gender === 'female' ? '女' : v.gender === 'male' ? '男' : ''}</span></div>
                          {v.description && <div className="muted small">{v.description}</div>}
                          {v.preview_url && <a className="small" onClick={e => { e.stopPropagation(); preview(v) }}>{playing === v.voice_id ? '■ 停止' : '▶ 試聽'}</a>}
                          {v.custom && me?.voice_trial && <div className="muted small">試用剩 {Math.max(0, Math.round(me.voice_trial.limit - me.voice_trial.used))} 秒，儲值後不限</div>}
                          {v.custom && <a className="small" onClick={e => { e.stopPropagation(); setCloning(true) }}>重新錄</a>}
                        </div>
                      ))}
                      {me && !voices.some(v => v.custom) && (
                        <div className="voice add" onClick={() => setCloning(true)}>
                          <div className="voice-name">＋ 用自己的聲音生成配音語音{me.voice_trial && <span className="lock-tag">試用 {me.voice_trial.limit} 秒</span>}</div>
                          <div className="muted small">{me.voice_trial ? `錄 30 秒就能試，先生成 ${me.voice_trial.limit} 秒旁白；儲值後不限` : '錄 30 秒，旁白就是你的聲音'}</div>
                        </div>)}
                      <div className={`voice ${voice === NO_VOICE ? 'sel' : ''}`} onClick={() => setVoice(NO_VOICE)}>
                        <div className="voice-name">不要配音</div>
                        <div className="muted small">只要配樂＋字幕</div>
                      </div>
                      {voice === null && <span className="muted small">載入聲音中…</span>}
                    </div>
                    <div className="ob-nav">
                      <a className="small" onClick={() => goStep(1)}>← 上一步</a>
                      <div className={`spot inline ${canStart ? 'on' : ''}`}>
                        {canStart && <span className="coach">按下去就開始</span>}
                        <button className={`btn primary start ${canStart ? 'glow' : ''}`} disabled={!canStart} onClick={start}>
                          {!hasFootage ? '先回第 1 步給素材' : !text.trim() ? '寫一點賣點就能開始' : voice === null ? '載入聲音中…' : '開始剪輯'}
                        </button>
                      </div>
                    </div>
                    <div className="muted small" style={{ textAlign: 'center' }}>
                      送出後剪輯師會一路做到輸出影片與封面，約 15 分鐘，中途不會停下來問。
                    </div>
                  </>
                )}
              </section>
              <ObPreview step={obStep} style={style} voiceName={voice === NO_VOICE ? null : voices.find(v => v.voice_id === voice)?.name ?? null} uploads={uploads.filter(u => u.status === 'ok').length} linkOk={linkOk} text={text} analysis={analysis} analyzing={analyzing} />
            </div>
          </div>
        )}
        {proj.messages.map((m, i) => <Bubble key={m.id} m={m} assets={assetsFor(m, i)} onOpenFiles={() => setTab('files')} />)}
        {running && (
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
        {(proj.client_comments?.length ?? 0) > 0 && stage !== 'working' && (
          <div className="card client-comments">
            <b>客戶留言</b>
            {proj.client_comments!.slice(-3).map(c => (
              <div key={c.id} className="cc-row">
                <div><span className="cc-name">{c.name || '客戶'}</span><span className="muted small"> {new Date(c.created_at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                  <div>{c.text}</div></div>
                <a className="small" onClick={() => setText(t => (t ? t + '\n' : '') + `客戶說：${c.text}。請照這個改。`)}>照這個改</a>
              </div>
            ))}
          </div>
        )}
        {needCredits && (
          <div className="card need">
            <div><b>點數不足</b>：這一步需要 {needCredits.needed} 點，目前 {needCredits.balance} 點，差 {Math.max(0, needCredits.needed - needCredits.balance)} 點。
              <div className="muted small">最小 50 點 = NT$350。儲值入帳後回來輸入「繼續」，剪輯師會接著做。</div></div>
            <button className="btn primary small" onClick={() => onTopUp(Math.max(0, needCredits.needed - needCredits.balance))}>去儲值</button>
          </div>
        )}
        {picking && !uploads.length && (
          <div className="card uploads muted small">
            等待選取檔案…{IOS && '（iPhone 選大影片後會先壓縮處理，可能要等 1–2 分鐘才會開始上傳，請不要離開這個畫面）'}
          </div>
        )}
        {pickFail && !uploads.length && (
          <div className="card need">
            <b>沒有收到檔案。</b>{IOS ? '這是 iPhone 把影片交給瀏覽器這一步失敗，不是上傳失敗。請依序試：' : '請再試一次，或改貼 Google Drive 連結。'}
            {IOS && (
              <ol className="small">
                {CRIOS && <li>改用 <b>Safari</b> 開這個網址（Chrome / Firefox 在 iPhone 上選影片常常失敗）。</li>}
                <li>一次少選幾支（最多 6 支，每支 1 GB 內）。</li>
                <li>先到「照片」App 把那支影片從頭播放一次（讓 iCloud 把原檔下載回手機），再回來選。</li>
                <li>在「照片」App 分享 → 儲存到「檔案」，選檔時改選「瀏覽」從「檔案」App 選。</li>
                <li>最穩：把影片丟到 Google Drive，貼資料夾連結給我。</li>
              </ol>
            )}
            <a className="small" onClick={() => setPickFail(false)}>關閉</a>
          </div>
        )}
        {needStorage && (
          <div className="card need">
            <div><b>成品空間已滿</b>：已用 {fmtBytes(needStorage.used_bytes)} / {Math.round(needStorage.quota_bytes / 2 ** 30)} GB，新的影片與封面先暫停輸出。
              <div className="muted small">刪掉不要的舊版本，或升級空間，再輸入「繼續」，剪輯師會接著輸出。已有的成品照常可看可下載。</div></div>
            <button className="btn primary small" onClick={onStorage}>升級空間</button>
            <button className="btn small" onClick={() => setTab('files')}>刪舊版本</button>
          </div>
        )}
        {uploads.length > 0 && stage !== 'start' && (
          <div className="card uq-card">
            <UploadQueue ups={uploads} onRetry={retryUpload} onRemove={removeUpload} onClose={() => setUploads([])} hint={IOS ? '請保持在這個畫面' : undefined} />
          </div>
        )}
        {err && <div className="error">{err}</div>}
        <div ref={bottom} />
      </div>
      {cloning && <VoiceCloneDialog current={voices.find(v => v.custom)} onClose={() => setCloning(false)} onDone={onCloned} />}
      {unseen && <a className="jump" onClick={jump}>↓ 有新內容</a>}
      {stage !== 'start' && CHIPS[stage].length > 0 && !uploading && (
        <div className="chips">
          {CHIPS[stage].map(c => <a key={c} className="chipbtn" onClick={() => setText(t => (t ? t + ' ' : '') + c)}>{c}</a>)}
        </div>
      )}
      {stage !== 'start' && <footer className="composer">
        <label className={`attach ${uploading ? 'busy' : ''}`} title="上傳影片（一次最多 6 支，每支 1 GB 內）" aria-label="上傳影片">
          <ClipIcon />
          <input type="file" multiple accept="video/*,.mp4,.mov,.m4v" hidden disabled={uploading} onClick={pick}
            onChange={e => { onFiles(e.target.files); e.target.value = '' }} /></label>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
          placeholder={uploading ? '上傳中，完成後再送出…' : PLACEHOLDER[stage]}
          onKeyDown={e => {
            // Enter sends only on desktop, never while the IME (注音／拼音) is still composing, and never on phones
            // (there Enter is a newline; send with the button). Shift+Enter is always a newline.
            const composing = e.nativeEvent.isComposing || e.keyCode === 229
            if (e.key === 'Enter' && !e.shiftKey && !composing && !IS_TOUCH) { e.preventDefault(); send() }
          }} />
        {mic.available && <button type="button" className={`attach mic ${mic.on ? 'on' : ''}`} title={mic.on ? '停止語音輸入' : '語音輸入'} aria-label="語音輸入" onClick={mic.toggle}><MicIcon /></button>}
        <button className="btn primary" onClick={send} disabled={running || uploading || !text.trim()}>送出</button>
        {!IS_TOUCH && <span className="composer-hint muted small">Enter 送出 · Shift+Enter 換行{mic.on ? ' · 聽寫中…' : ''}</span>}
      </footer>}
      </>}
    </div>
  )
}

function Bubble({ m, assets, onOpenFiles }: { m: Msg; assets: Asset[]; onOpenFiles?: () => void }) {
  const speaking = useSpeaking(m.id)
  const spoken = m.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n')
  // Consecutive tool parts collapse into one quiet "did N steps" line; the editor's words stay prominent.
  const groups: ({ kind: 'text'; text: string } | { kind: 'tools'; names: string[] })[] = []
  for (const p of m.parts) {
    const last = groups[groups.length - 1]
    if (p.type === 'text') groups.push({ kind: 'text', text: p.text })
    else if (last && last.kind === 'tools') last.names.push(p.name)
    else groups.push({ kind: 'tools', names: [p.name] })
  }
  return (
    <div className={`bubble ${m.role}`}>
      {groups.map((g, i) => g.kind === 'text'
        ? <Md key={i} text={g.text} />
        : (
          <details key={i} className="steps-done">
            <summary><span className="chev" />做了 {g.names.length} 步<span className="muted">· {[...new Set(g.names.map(n => TOOL_LABEL[n] ?? n))].slice(0, 4).join(' → ')}{g.names.length > 4 ? ' …' : ''}</span></summary>
            <ol className="steps">{g.names.map((n, k) => <li key={k} className="sx ok"><ToolIcon name={n} /><span className="sx-label">{TOOL_LABEL[n] ?? n}</span><span className="sx-meta">完成</span></li>)}</ol>
          </details>
        ))}
      {assets.map(a => <AssetCard key={a.id} a={a} onOpenFiles={onOpenFiles} />)}
      {m.role === 'assistant' && CAN_TTS && spoken.trim() && (
        <a className={`speak ${speaking ? 'on' : ''}`} onClick={() => speakToggle(m.id, spoken)} title={speaking ? '停止朗讀' : '朗讀這則'}><SpeakIcon on={speaking} />{speaking ? '停止' : '朗讀'}</a>)}
    </div>
  )
}

/* Markdown with a little semantics: paragraphs that open with ⚠ / ✅ / 請確認 become callouts, so a
   warning, a confirmation request and a plain sentence don't all look the same. */
function Md({ text }: { text: string }) {
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
        <span className="pill final">v{a.version}</span>
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
function ObPreview({ step, style, voiceName, uploads, linkOk, text, analysis, analyzing }:
  { step: number; style: string; voiceName: string | null; uploads: number; linkOk: boolean; text: string; analysis: Analysis | null; analyzing: boolean }) {
  const st = STYLES.find(x => x.id === style) ?? STYLES[0]
  const textPlace = (text.match(/^(.{2,12}?)(的|，|、|。)/) || [])[1]
  const sumPlace = (analysis?.summary.match(/^(.{2,12}?)(的|，|、|。|$)/) || [])[1]
  const place = (analysis ? sumPlace : textPlace) || textPlace || '宜蘭海邊包棟'
  const hook = analysis?.script[0]?.text
  return (
    <aside className="ob-prev">
      <div className="ob-prev-head"><span className="eyebrow">{step === 2 ? '15 分鐘後你會拿到' : step === 1 ? (analysis ? '開頭 3 秒會是這樣' : analyzing ? '解析完你會看到' : '解析完你會看到') : '上傳好會是這樣'}</span></div>
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
        <div className={`ps-video ob-style ${style}`}>
          <div className="ps-super">{analysis.selling_points.slice(1, 3).join(' · ') || '賣點'}</div>
          <div className="ps-headline">{place}<br /><em>{analysis.selling_points[0] || ''}</em></div>
          {hook && <div className="ps-narr"><i className="ps-mic" /><span className="ps-wave"><b /><b /><b /><b /><b /><b /></span><small>{hook}</small></div>}
          <div className="ps-sub">{analysis.script[1]?.text || ''}</div>
          <div className="ps-play" />
          <div className="ob-style-note">Hook 用最強賣點 · {analysis.storyboard.length} 個鏡頭約 {Math.round(analysis.total_seconds)} 秒</div>
        </div>
      )}
      {step === 0 && (
        <div className="ob-prev-up">
          {[['DJI_0001.MP4', 'a', '影片'], ['IMG_5540.JPG', 'b', '照片'], ['DJI_0007.MP4', 'c', '影片']].map(([n, c, k], i) => (
            <div key={n} className={`ps-uqrow ok ${i < Math.max(uploads, linkOk ? 3 : 0) ? 'real' : ''}`} style={{ animationDelay: `${i * .2}s` }}>
              <span className={`ps-th ${c}`}><i className={k === '照片' ? 'photo' : ''}>{k}</i></span>
              <span className="ps-uqmain"><span className="ps-uqname">{n}</span><small>完成</small><span className="ps-uqbar"><i style={{ width: '100%' }} /></span></span><em>✓</em>
            </div>))}
          <div className="muted small">剪輯師會自己看完每一個，挑最好的畫面。{uploads > 0 && <b> 你已經上傳 {uploads} 個。</b>}</div>
        </div>
      )}
      {step === 2 && (
        <div className="ob-prev-done">
          <div className="ps-vhead"><b>v1</b><span className="ps-pill">成品</span><small>影片＋封面 · {st.name}</small></div>
          <div className="ps-result">
            <div className={`ps-video ob-style ${style}`}>
              <div className="ps-super">{st.id === 'promo' ? '限時優惠 · 只到月底' : st.id === 'premium' ? place : analysis?.selling_points.slice(1, 3).join(' · ') || 'KTV · 電動麻將 · 寵物友善'}</div>
              <div className="ps-headline">{st.id === 'promo' ? <>平日每人<br /><em>NT$1,500</em></> : st.id === 'premium' ? <>海的旁邊<br /><em>一棟只給你們</em></> : <>{place}<br /><em>{analysis?.selling_points[0] || '25米戲水池'}</em></>}</div>
              {voiceName && <div className="ps-narr"><i className="ps-mic" /><span className="ps-wave"><b /><b /><b /><b /><b /><b /></span><small>{voiceName} 旁白</small></div>}
              <div className="ps-sub">{st.id === 'promo' ? '現在訂省 NT$500' : st.id === 'premium' ? '慢下來，聽海' : hook || '推開窗就是龜山島海景'}</div>
              <div className="ps-play" />
              <div className="ob-style-note">{st.id === 'promo' ? '價格開頭、節奏強' : st.id === 'premium' ? '慢節奏、長鏡頭、少字' : '前 3 秒放最強賣點、快剪'}{voiceName ? '' : ' · 只有配樂與字幕'}</div>
            </div>
            <div className="ps-covers">
              <div className="ps-cover a"><span>封面 A</span><b>{place}</b><em>NT$1,500</em></div>
              <div className="ps-cover b"><span>封面 B</span><b>{analysis?.selling_points[0] || '25 米戲水池'}</b><em>平日每人 1,500</em></div>
            </div>
          </div>
          <div className="muted small">做好會自動歸檔到「成品」頁，可以一鍵分享給客戶。</div>
        </div>
      )}
    </aside>
  )
}
