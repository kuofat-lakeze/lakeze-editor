import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { api, type Asset, type Msg, type ProjectDetail } from './api'

type Live = { text: string; thinking: string; tools: { name: string; status: 'run' | 'ok' | 'err'; seconds?: number; summary?: string }[] }
const emptyLive = (): Live => ({ text: '', thinking: '', tools: [] })

const TOOL_LABEL: Record<string, string> = {
  list_drive_folder: '讀取 Drive 資料夾', download_footage: '下載素材', probe_footage: '分析素材',
  sample_frames: '放大檢視畫面', build_cut: '剪輯畫面', search_voices: '搜尋聲音', generate_voice: '生成旁白並核對',
  generate_music: '生成配樂', generate_sfx: '生成音效', preview_video: '做預覽', compose_audio: '混音',
  render_captions: '燒字幕', export_video: '輸出成品', make_cover: '做封面',
}

export function Chat({ projectId, onUsage, onTopUp }: { projectId: string; onUsage: () => void; onTopUp: () => void }) {
  const [proj, setProj] = useState<ProjectDetail | null>(null)
  const [live, setLive] = useState<Live>(emptyLive())
  const [running, setRunning] = useState(false)
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [needCredits, setNeedCredits] = useState<{ needed: number; balance: number } | null>(null)
  const [upload, setUpload] = useState<number | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const liveAssets = useRef<Asset[]>([])

  const reload = () => api.project(projectId).then(p => { setProj(p); setRunning(p.running); if (p.running) listen() })
  useEffect(() => { reload() }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }) }, [proj, live])

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
    const t = text.trim(); if (!t || running) return
    setErr(''); setText(''); setNeedCredits(null)
    setProj(p => p && { ...p, messages: [...p.messages, { id: 'tmp', role: 'user', parts: [{ type: 'text', text: t }], created_at: '' }] })
    try { await api.send(projectId, t); setLive(emptyLive()); listen() } catch (e) { setErr((e as Error).message) }
  }

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setUpload(0)
    try { await api.upload(projectId, files, setUpload); setText(t => t || `我上傳了 ${files.length} 支素材，請先分析。`) }
    catch (e) { setErr((e as Error).message) } finally { setUpload(null) }
  }

  if (!proj) return <div className="center muted">載入中…</div>
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
        <h2>{proj.name}</h2>
        <span className="muted small">
          {proj.credits.in_free
            ? (proj.credits.free_revisions_left === null ? '免費專案：第一版 + 封面免費' : `免費修改還剩 ${proj.credits.free_revisions_left} 輪`)
            : '照價目扣點'}
        </span>
        {running && <button className="btn small" onClick={() => api.cancel(projectId)}>停止</button>}
      </header>
      <div className="thread">
        {proj.messages.length === 0 && !running && (
          <div className="hint card">
            <b>怎麼開始</b>
            <ol>
              <li>貼 Google Drive 資料夾連結（要設為「知道連結的人都能檢視」），或點 📎 上傳影片。</li>
              <li>寫下賣點：地點、特色、價格、要什麼語氣。</li>
              <li>剪輯師會分析素材、寫旁白稿、給你試聽聲音和配樂選，最後輸出影片與封面。</li>
            </ol>
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
        {err && <div className="error">{err}</div>}
        <div ref={bottom} />
      </div>
      <footer>
        <label className="btn icon" title="上傳影片">📎<input type="file" multiple accept="video/*" hidden onChange={e => onFiles(e.target.files)} /></label>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
          placeholder={upload !== null ? `上傳中 ${upload}%` : '貼 Drive 連結＋賣點，或直接說要改什麼… (Enter 送出，Shift+Enter 換行)'}
          disabled={upload !== null}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
        <button className="btn primary" onClick={send} disabled={running || !text.trim()}>送出</button>
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
