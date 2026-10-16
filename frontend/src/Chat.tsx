import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { api, type Asset, type Msg, type ProjectDetail, type Voice } from './api'

type Live = { text: string; thinking: string; tools: { name: string; status: 'run' | 'ok' | 'err'; seconds?: number; summary?: string }[] }
const emptyLive = (): Live => ({ text: '', thinking: '', tools: [] })
type Up = { name: string; size: number; loaded: number; status: 'wait' | 'up' | 'ok' | 'err'; error?: string }
const IN_APP = /Line\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(navigator.userAgent)
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
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
const fmtMB = (b: number) => `${(b / 2 ** 20).toFixed(b > 100 * 2 ** 20 ? 0 : 1)} MB`

const TOOL_LABEL: Record<string, string> = {
  list_drive_folder: '讀取 Drive 資料夾', download_footage: '下載素材', probe_footage: '分析素材',
  sample_frames: '放大檢視畫面', build_cut: '剪輯畫面', search_voices: '搜尋聲音', generate_voice: '生成旁白並核對',
  generate_music: '生成配樂', generate_sfx: '生成音效', preview_video: '做預覽', compose_audio: '混音',
  render_captions: '燒字幕', export_video: '輸出成品', make_cover: '做封面',
}

export function Chat({ projectId, name, onUsage, onTopUp }: { projectId: string; name?: string; onUsage: () => void; onTopUp: () => void }) {
  const [proj, setProj] = useState<ProjectDetail | null>(null)
  const [live, setLive] = useState<Live>(emptyLive())
  const [running, setRunning] = useState(false)
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [needCredits, setNeedCredits] = useState<{ needed: number; balance: number } | null>(null)
  const [uploads, setUploads] = useState<Up[]>([])
  const [picking, setPicking] = useState(false)
  const [pickFail, setPickFail] = useState(false)
  const [voices, setVoices] = useState<Voice[]>([])
  const [voice, setVoice] = useState<string | null>(null)   // voice_id, NO_VOICE, or null = not loaded yet
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

  const reload = () => api.project(projectId).then(p => { setProj(p); setRunning(p.running); if (p.running) listen() })
  useEffect(() => { reload() }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!proj) return
    if (firstLoad.current) { firstLoad.current = false; bottom.current?.scrollIntoView(); return }
    if (atBottom.current) bottom.current?.scrollIntoView({ behavior: 'smooth' }); else setUnseen(true)
  }, [proj, live])
  useEffect(() => {
    if (!proj || proj.messages.length) return
    api.voices().then(vs => { setVoices(vs); setVoice(v => v ?? vs[0]?.voice_id ?? NO_VOICE) }).catch(() => setVoice(NO_VOICE))
  }, [proj?.id, proj?.messages.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const preview = (v: Voice) => {
    if (!v.preview_url) return
    if (playing === v.voice_id) { audioRef.current?.pause(); setPlaying(null); return }
    audioRef.current?.pause()
    const a = new Audio(v.preview_url); audioRef.current = a; setPlaying(v.voice_id)
    a.onended = () => setPlaying(null); a.play().catch(() => setPlaying(null))
  }
  const onScroll = () => {
    const el = threadRef.current; if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (atBottom.current) setUnseen(false)
  }
  const jump = () => { atBottom.current = true; setUnseen(false); bottom.current?.scrollIntoView({ behavior: 'smooth' }) }

  function listen() {
    setRunning(true)
    const es = new EventSource(`/api/projects/${projectId}/stream`)
    es.onmessage = e => {
      const ev = JSON.parse(e.data)
      switch (ev.type) {
        case 'text': setLive(l => ({ ...l, text: l.text + ev.text })); break
        case 'thinking': setLive(l => ({ ...l, thinking: (l.thinking + ev.text).slice(-600) })); break
        case 'tool_run': setLive(l => ({ ...l, tools: [...l.tools, { name: ev.name, status: 'run' }] })); break
        case 'tool_end': setLive(l => {
          const tools = [...l.tools]; const i = tools.map(t => t.name).lastIndexOf(ev.name)
          if (i >= 0) tools[i] = { ...tools[i], status: ev.ok ? 'ok' : 'err', seconds: ev.seconds, summary: ev.summary }
          return { ...l, tools }
        }); break
        case 'asset': liveAssets.current.push(ev.asset); setLive(l => ({ ...l })); break
        case 'credits': onUsage(); break
        case 'need_credits': setNeedCredits({ needed: ev.needed, balance: ev.balance }); break
        case 'error': setErr(ev.message); break
        case 'idle': es.close(); setRunning(false); break
        case 'done': es.close(); setRunning(false); setLive(emptyLive()); liveAssets.current = []; reload(); onUsage(); break
      }
    }
    es.onerror = () => { es.close(); setRunning(false); reload() }
  }

  const send = async () => {
    let t = text.trim(); if (!t || running) return
    if (proj && proj.messages.length === 0 && voice) {  // first message carries the voice choice made in the UI
      const v = voices.find(x => x.voice_id === voice)
      t += voice === NO_VOICE ? '\n\n（不要配音：只要配樂和字幕，賣點用字幕呈現。）'
        : v ? `\n\n（旁白用 ${v.name}，voice_id ${v.voice_id}，直接做到輸出，不用再問我選聲音。）` : ''
    }
    setErr(''); setText(''); setNeedCredits(null); atBottom.current = true
    setProj(p => p && { ...p, messages: [...p.messages, { id: 'tmp', role: 'user', parts: [{ type: 'text', text: t }], created_at: '' }] })
    try { await api.send(projectId, t); setLive(emptyLive()); listen() } catch (e) { setErr((e as Error).message) }
  }

  const onFiles = async (files: FileList | null) => {
    setPicking(false); setPickFail(false)
    const list = Array.from(files ?? [])
    api.clientLog('files_selected', { n: list.length, files: list.map(f => ({ name: f.name, size: f.size, type: f.type })) })
    if (!list.length) return
    setErr('')
    setUploads(list.map(f => ({ name: f.name || 'clip', size: f.size, loaded: 0, status: 'wait' })))
    let ok = 0
    for (let i = 0; i < list.length; i++) {
      const f = list[i]
      const patch = (u: Partial<Up>) => setUploads(us => us.map((x, k) => (k === i ? { ...x, ...u } : x)))
      patch({ status: 'up' })
      const t0 = Date.now()
      try {
        await api.uploadOne(projectId, f, (loaded, total) => patch({ loaded, size: total || f.size }))
        patch({ status: 'ok', loaded: f.size }); ok++
        api.clientLog('upload_ok', { name: f.name, size: f.size, seconds: (Date.now() - t0) / 1000 })
      } catch (e) {
        const msg = (e as Error).message
        patch({ status: 'err', error: msg })
        api.clientLog('upload_err', { name: f.name, size: f.size, seconds: (Date.now() - t0) / 1000, error: msg })
      }
    }
    if (ok) setText(t => t || `我上傳了 ${ok} 支素材，請先分析。`)
  }
  const pick = () => { setPicking(true); setPickFail(false); api.clientLog('picker_open') }
  // iOS never tells the page that the picker was dismissed. If no change event arrives, show the workarounds.
  useEffect(() => {
    if (!picking) return
    const t = setTimeout(() => { setPicking(false); setPickFail(true); api.clientLog('picker_no_file_60s') }, 60000)
    return () => clearTimeout(t)
  }, [picking])

  if (!proj) return <div className="center muted">載入中…</div>
  const stage: Stage = running ? 'working' : proj.messages.length === 0 ? 'start' : proj.credits.exports > 0 ? 'revise' : 'progress'
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
        <span className={`chip ${proj.credits.in_free ? '' : 'pay'}`}>
          {proj.credits.in_free
            ? (proj.credits.free_revisions_left === null ? '免費：第一版 + 封面' : `免費修改剩 ${proj.credits.free_revisions_left} 輪`)
            : '照價目扣點'}
        </span>
        {running && <button className="btn small" onClick={() => api.cancel(projectId)}>停止</button>}
      </header>
      <div className="thread" ref={threadRef} onScroll={onScroll}>
        {IN_APP && (
          <div className="card need">
            你現在是在 LINE / FB 等 App 的內建瀏覽器，這類瀏覽器通常不能選影片上傳。
            請點右上角「⋯」選「用 Safari / Chrome 開啟」，或改貼 Google Drive 連結。
          </div>
        )}
        {stage === 'start' && (
          <div className="hint card">
            <b>三步開始</b>
            <ol>
              <li>選旁白聲音（可以不要配音）。</li>
              <li>貼 Google Drive 資料夾連結（設為「知道連結的人都能檢視」）或點 📎 上傳影片。</li>
              <li>寫賣點：地點、特色、價格、語氣。送出後剪輯師會一路做到輸出影片與封面。</li>
            </ol>
            <div className="voices">
              <div className="small muted">旁白聲音</div>
              <div className="voice-row">
                {voices.map(v => (
                  <div key={v.voice_id} className={`voice ${voice === v.voice_id ? 'sel' : ''}`} onClick={() => setVoice(v.voice_id)}>
                    <div className="voice-name">{v.name}<span className="muted small"> {v.gender === 'female' ? '女' : v.gender === 'male' ? '男' : ''}</span></div>
                    {v.description && <div className="muted small">{v.description}</div>}
                    {v.preview_url && <a className="small" onClick={e => { e.stopPropagation(); preview(v) }}>{playing === v.voice_id ? '■ 停止' : '▶ 試聽'}</a>}
                  </div>
                ))}
                <div className={`voice ${voice === NO_VOICE ? 'sel' : ''}`} onClick={() => setVoice(NO_VOICE)}>
                  <div className="voice-name">不要配音</div>
                  <div className="muted small">只要配樂＋字幕，賣點用字幕呈現</div>
                </div>
                {voice === null && <span className="muted small">載入聲音中…</span>}
              </div>
            </div>
          </div>
        )}
        {proj.messages.map((m, i) => <Bubble key={m.id} m={m} assets={assetsFor(m, i)} />)}
        {running && (
          <div className="bubble assistant">
            {live.thinking && <details className="thinking"><summary>思考中…</summary>{live.thinking}</details>}
            {live.tools.map((t, i) => (
              <div key={i} className={`tool ${t.status}`}>
                <span className="dot" /> {TOOL_LABEL[t.name] ?? t.name}
                {t.status === 'run' ? '…' : t.seconds !== undefined ? ` ${t.seconds}s` : ''}
                {t.status === 'err' && <span className="muted small"> 失敗</span>}
              </div>
            ))}
            {liveAssets.current.map(a => <AssetCard key={a.id} a={a} />)}
            {live.text && <Md text={live.text} />}
            {!live.text && live.tools.every(t => t.status !== 'run') && <span className="muted">…</span>}
          </div>
        )}
        {needCredits && (
          <div className="card need">
            點數不足：這一步需要 {needCredits.needed} 點，目前 {needCredits.balance} 點。
            <button className="btn primary small" onClick={onTopUp}>儲值</button>
            <span className="muted small">儲值後輸入「繼續」即可接著做。</span>
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
                <li>一次只選一支影片。</li>
                <li>先到「照片」App 把那支影片從頭播放一次（讓 iCloud 把原檔下載回手機），再回來選。</li>
                <li>在「照片」App 分享 → 儲存到「檔案」，選檔時改選「瀏覽」從「檔案」App 選。</li>
                <li>最穩：把影片丟到 Google Drive，貼資料夾連結給我。</li>
              </ol>
            )}
            <a className="small" onClick={() => setPickFail(false)}>關閉</a>
          </div>
        )}
        {uploads.length > 0 && (
          <div className="card uploads">
            <div className="uploads-head">
              <b>{uploading ? '上傳中…' : '上傳完成'}</b>
              <span className="muted small">{uploads.filter(u => u.status === 'ok').length}/{uploads.length} 個檔案
                {uploading && IOS && '，請保持在這個畫面'}</span>
              {!uploading && <a className="small" onClick={() => setUploads([])}>關閉</a>}
            </div>
            {uploads.map((u, i) => (
              <div key={i} className={`up ${u.status}`}>
                <div className="up-row">
                  <span className="up-name">{u.name}</span>
                  <span className="muted small">
                    {u.status === 'wait' && '等待中'}
                    {u.status === 'up' && `${fmtMB(u.loaded)} / ${fmtMB(u.size)} · ${u.size ? Math.round(u.loaded / u.size * 100) : 0}%`}
                    {u.status === 'ok' && `完成 · ${fmtMB(u.size)}`}
                    {u.status === 'err' && '失敗'}
                  </span>
                </div>
                <div className="bar"><div style={{ width: `${u.size ? Math.min(100, u.loaded / u.size * 100) : 0}%` }} /></div>
                {u.error && <div className="error">{u.error}</div>}
              </div>
            ))}
          </div>
        )}
        {err && <div className="error">{err}</div>}
        <div ref={bottom} />
      </div>
      {unseen && <a className="jump" onClick={jump}>↓ 有新內容</a>}
      {CHIPS[stage].length > 0 && !uploading && (
        <div className="chips">
          {CHIPS[stage].map(c => <a key={c} className="chipbtn" onClick={() => setText(t => (t ? t + ' ' : '') + c)}>{c}</a>)}
        </div>
      )}
      <footer className="composer">
        <label className="btn icon" title="上傳影片">📎
          <input type="file" multiple={!IOS} accept="video/*,.mp4,.mov,.m4v" hidden disabled={uploading} onClick={pick}
            onChange={e => { onFiles(e.target.files); e.target.value = '' }} /></label>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
          placeholder={uploading ? '上傳中，完成後再送出…' : PLACEHOLDER[stage]}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
        <button className="btn primary" onClick={send} disabled={running || uploading || !text.trim()}>送出</button>
      </footer>
    </div>
  )
}

function Bubble({ m, assets }: { m: Msg; assets: Asset[] }) {
  return (
    <div className={`bubble ${m.role}`}>
      {m.parts.map((p, i) => p.type === 'text'
        ? <Md key={i} text={p.text} />
        : <div key={i} className="tool ok"><span className="dot" /> {TOOL_LABEL[p.name] ?? p.name}</div>)}
      {assets.map(a => <AssetCard key={a.id} a={a} />)}
    </div>
  )
}

function Md({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string)
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

export function AssetCard({ a }: { a: Asset }) {
  const mb = a.meta?.size_mb ? ` · ${a.meta.size_mb} MB` : ''
  return (
    <div className="asset">
      {a.kind === 'video' && <video src={a.url} controls preload="metadata" />}
      {a.kind === 'audio' && <audio src={a.url} controls preload="metadata" />}
      {a.kind === 'image' && <img src={a.url} alt={a.name} />}
      <div className="asset-meta"><span>{a.name}{mb}</span><a href={a.url} download>下載</a></div>
    </div>
  )
}
