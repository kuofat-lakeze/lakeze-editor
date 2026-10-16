import { useEffect, useState } from 'react'
import { api, type Asset, type DeliverablesData, type ShareLink, type StorageState } from './api'
import { StorageMeter, fmtBytes } from './Storage'
import { ask } from './Dialog'
import { FbIcon, LineIcon, promoText, shareToFacebook, shareToLine } from './share'

const fmtDate = (iso: string) => new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
/* 給朋友的一句話: six ready-made lines. Shown in grey as the default; sent as-is unless the user edits. */
const NOTE_PRESETS = [
  '噹噹～新片出爐 🎬 熱騰騰的，趁熱幫我看一下！',
  '我只花 15 分鐘就剪好這支 😎 你給幾顆星？⭐️',
  '前 3 秒有沒有把你勾住？老實說沒關係 🙈',
  '看完會不會想立刻訂房？想的話我就成功了 🏖️',
  '封面 A 還是 B？二選一，不准說都好 😤',
  '偷偷跟你說，這支是 AI 剪的 🤫 你看得出來嗎？',
  '配樂下好下滿 🎧 記得開聲音看，不然我會難過',
  '你是第一個看到的，壓力給你了 😆 請誠實評分',
  '這支我看了 30 遍，換你看 1 遍就好 🙏',
  '看完要是沒有想出去玩，算我輸 ✈️',
  '如果只能改一個地方，你會改哪裡？👀',
  '新作上架 🛎️ 留言區開放吐槽，但請溫柔一點 🥹',
]
const sizeOf = (v: { videos: Asset[]; covers: Asset[] }) =>
  [...v.videos, ...v.covers].reduce((a, x) => a + ((x.meta?.size_mb as number | undefined) ?? 0) * 2 ** 20, 0)

/* Free plan: each version shows how long it has left before the 7-day retention removes it. */
function ExpiryPill({ at, onKeep }: { at: string; onKeep?: () => void }) {
  const ms = Date.parse(at) - Date.now()
  const days = Math.ceil(ms / 86400000)
  const txt = ms <= 0 ? '即將移除' : days <= 1 ? `${Math.max(1, Math.ceil(ms / 3600000))} 小時後移除` : `${days} 天後移除`
  return <button type="button" className={`pill exp ${days <= 2 ? 'soon' : ''}`} onClick={onKeep} title="免費空間的成品保留 7 天；加購空間就一直保存">⏳ {txt}</button>
}

export function Deliverables({ projectId, onChanged, onStorage }: { projectId: string; onChanged?: () => void; onStorage?: () => void }) {
  const [data, setData] = useState<DeliverablesData | null>(null)
  const [st, setSt] = useState<StorageState | null>(null)
  const [sharing, setSharing] = useState<number | null | 'final'>(null)  // version being shared ('final' = follow final)
  const [copied, setCopied] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const load = () => Promise.all([api.deliverables(projectId).then(setData), api.storage().then(setSt).catch(() => {})])
  useEffect(() => { load() }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <div className="center muted">載入中…</div>
  const { project, versions, shares } = data
  const live = shares.filter(s => !s.revoked && (!s.expires_at || Date.parse(s.expires_at) > Date.now()))

  const setFinal = async (v: number | null) => { await api.setFinal(projectId, v); await load(); onChanged?.() }
  const del = async (v: number) => {
    const mb = sizeOf(versions.find(x => x.version === v)!)
    if (!await ask.confirm(`刪除 v${v}（影片與封面，約 ${fmtBytes(mb)}）？刪了就拿不回來，指向這一版的朋友連結也會失效。`, { ok: '刪除', danger: true })) return
    setBusy(v)
    try { await api.deleteVersion(projectId, v); await load(); onChanged?.() } catch (e) { ask.alert((e as Error).message) } finally { setBusy(null) }
  }
  const copy = async (s: ShareLink) => {
    const url = `${location.origin}${s.url}`
    try { await navigator.clipboard.writeText(url) } catch { /* fall back to showing the url */ }
    setCopied(s.id); setTimeout(() => setCopied(null), 1800)
  }

  return (
    <div className="deliv">
      {st && (versions.length > 0 || st.over) && (
        <div className="card deliv-storage"><StorageMeter s={st} onManage={onStorage} compact={!st.over} /></div>
      )}
      {versions.length === 0 && (
        <div className="card empty-deliv">
          <b>還沒有成品</b>
          <div className="muted small">剪輯師輸出第一版後，影片與封面會自動整理到這裡，之後每次重新輸出都是新的一版。</div>
        </div>
      )}
      {versions.map(v => {
        const isFinal = project.final_version === v.version
        return (
          <section key={v.version} className={`card ver ${isFinal ? 'final' : ''}`}>
            <div className="ver-head">
              <div className="ver-title">
                <b>v{v.version}</b>
                {isFinal && <span className="pill final">最終版</span>}
                {!isFinal && project.final_version == null && v === versions[0] && <span className="pill">最新</span>}
                <span className="muted small">{fmtDate(v.created_at)}{sizeOf(v) > 0 && ` · ${fmtBytes(sizeOf(v))}`}</span>
                {v.expires_at && <ExpiryPill at={v.expires_at} onKeep={onStorage} />}
              </div>
              <div className="ver-actions">
                {isFinal
                  ? <button className="btn small" onClick={() => setFinal(null)}>取消最終版</button>
                  : <button className="btn small" onClick={() => setFinal(v.version)}>標成最終版</button>}
                <button className="btn primary small" onClick={() => setSharing(v.version)}>分享給朋友</button>
                <button className="btn small ghost danger" disabled={isFinal || busy === v.version} title={isFinal ? '先取消最終版才能刪' : '刪除這一版，釋放空間'}
                  onClick={() => del(v.version)}>{busy === v.version ? '刪除中…' : '刪除'}</button>
              </div>
            </div>
            <div className="ver-body">
              <div className="ver-video">
                {v.main ? <video src={v.main.url} controls preload="metadata" playsInline /> : <div className="muted small">沒有影片</div>}
                {v.main && <div className="ver-meta">
                  <span>{v.main.name}{v.main.meta?.size_mb ? ` · ${v.main.meta.size_mb} MB` : ''}</span>
                  <a href={v.main.url} download>下載</a>
                </div>}
                {v.videos.length > 1 && (
                  <details className="others">
                    <summary className="small">其他格式</summary>
                    {v.videos.filter(x => x !== v.main).map(x => (
                      <div key={x.id} className="ver-meta"><span>{x.name}{x.meta?.size_mb ? ` · ${x.meta.size_mb} MB` : ''}</span><a href={x.url} download>下載</a></div>))}
                  </details>
                )}
              </div>
              <div className="ver-covers">
                {v.covers.length === 0 && <div className="muted small">這版沒有封面</div>}
                {v.covers.map((c: Asset) => (
                  <figure key={c.id} className="cover">
                    <img src={c.url} alt={c.name} loading="lazy" />
                    <figcaption><span>{c.name}</span><a href={c.url} download>下載</a></figcaption>
                  </figure>
                ))}
              </div>
            </div>
          </section>
        )
      })}

      {live.length > 0 && (
        <section className="card links">
          <b>分享連結</b>
          {live.map(s => (
            <div key={s.id} className="link-row">
              <div className="link-main">
                <div className="link-url">{location.host}{s.url}</div>
                <div className="muted small">
                  {s.version ? `v${s.version}` : '跟著最終版'} · {s.allow_download ? '可下載' : '只能看'} · {s.expires_at ? `到 ${s.expires_at.slice(0, 10)}` : '永久'} · 看過 {s.views} 次
                  {s.note ? ` · ${s.note}` : ''}
                </div>
              </div>
              <button className="btn small" onClick={() => copy(s)}>{copied === s.id ? '已複製' : '複製'}</button>
              <a className="btn small" href={s.url} target="_blank" rel="noreferrer">開啟</a>
              <button className="btn small ghost" onClick={async () => { if (await ask.confirm('停用這條連結？朋友將無法再打開。', { ok: '停用', danger: true })) { await api.revokeShare(projectId, s.id); load() } }}>停用</button>
            </div>
          ))}
        </section>
      )}

      {sharing !== null && (
        <ShareDialog projectId={projectId} version={sharing === 'final' ? null : sharing} hasFinal={project.final_version != null} projectName={project.name}
          onClose={() => setSharing(null)} onCreated={() => { setSharing(null); load() }} />
      )}
    </div>
  )
}

export function ShareDialog({ projectId, version, hasFinal, onClose, onCreated, projectName }:
  { projectId: string; version: number | null; hasFinal: boolean; onClose: () => void; onCreated: () => void; projectName: string }) {
  const [promo, setPromo] = useState('')
  const [copied, setCopied] = useState<'link' | 'promo' | null>(null)
  const [follow, setFollow] = useState(true)   // default on: one link that always shows the latest final cut
  const [tweak, setTweak] = useState(false)
  const [download, setDownload] = useState(true)
  const [days, setDays] = useState<string>('0')
  const [note, setNote] = useState('')
  const [preset, setPreset] = useState(() => Math.floor(Math.random() * NOTE_PRESETS.length))
  const [edited, setEdited] = useState(false)   // false = the grey preset is what will be sent
  const noteToSend = edited ? note.trim() : NOTE_PRESETS[preset]
  const changed = edited && note.trim() !== NOTE_PRESETS[preset]
  const [made, setMade] = useState<ShareLink | null>(null)
  const [busy, setBusy] = useState(false)
  const create = async () => {
    setBusy(true)
    try {
      const m = await api.createShare(projectId, { version: follow ? null : version, allow_download: download, expires_days: Number(days) || null, note: noteToSend })
      setMade(m); setPromo(promoText(projectName, `${location.origin}${m.url}`))
    } finally { setBusy(false) }
  }
  const url = made ? `${location.origin}${made.url}` : ''
  const flash = (k: 'link' | 'promo') => { setCopied(k); setTimeout(() => setCopied(null), 1800) }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal card share-dlg" onClick={e => e.stopPropagation()}>
        <div className="modal-head"><h3>分享給朋友</h3><a onClick={onClose}>✕</a></div>
        {!made ? (
          <>
            <p className="muted small share-lead">朋友不用登入，點開就能看。都幫你設定好了，寫一句話（或用預設的）就能分享。</p>
            <div className="note-box">
              <div className="note-h">
                <b>給朋友的一句話</b>
                {!changed ? <span className="note-tag">預設訊息 · {edited ? '直接改就好' : '點文字就能改'}</span> : <span className="note-tag mine">已改成你的話</span>}
                <span className="spacer" />
                {!changed
                  ? <a className="small" onClick={() => { const n = (preset + 1) % NOTE_PRESETS.length; setPreset(n); if (edited) setNote(NOTE_PRESETS[n]) }}>↻ 換一句 {preset + 1}/{NOTE_PRESETS.length}</a>
                  : <a className="small" onClick={() => { setEdited(false); setNote('') }}>還原預設</a>}
              </div>
              <div className={`note-field ${edited ? 'edited' : 'preset'}`}>
                <textarea rows={2} value={edited ? note : ''} placeholder={NOTE_PRESETS[preset]}
                  onFocus={() => { if (!edited) { setNote(NOTE_PRESETS[preset]); setEdited(true) } }}
                  onChange={e => { setNote(e.target.value); setEdited(true) }} />
                {!edited && <span className="note-pen" aria-hidden="true">✎</span>}
              </div>
              <div className="note-dots" aria-hidden="true">{NOTE_PRESETS.map((_, i) => <i key={i} className={!changed && i === preset ? 'on' : ''} onClick={() => { setPreset(i); if (edited) setNote(NOTE_PRESETS[i]) }} />)}</div>
            </div>
            <div className={`share-opts ${tweak ? 'open' : ''}`}>
              <button type="button" className="so-sum" onClick={() => setTweak(t => !t)} aria-expanded={tweak}>
                <span className="so-chips">
                  <em className="on">✓ {follow ? '永遠最新版' : `只給 v${version ?? '最新'}`}</em>
                  <em className={download ? 'on' : ''}>{download ? '✓ 可下載' : '只能看'}</em>
                  <em className="on">{days === '0' ? '✓ 永久有效' : `${days} 天後失效`}</em>
                </span>
                <span className="small so-tog">{tweak ? '收起' : '調整'}</span>
              </button>
              {tweak && (
                <div className="so-body">
                  <label className="so-row">
                    <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />
                    <span><b>跟著最終版</b><small>{follow
                      ? (hasFinal ? '之後你改了最終版，朋友點同一條連結就會看到新的，不用重傳。' : '還沒標最終版前會顯示最新一版；之後標了最終版，同一條連結會自動換過去。')
                      : `朋友只會看到 v${version ?? '最新'} 這一版，之後修改不會影響這條連結。`}</small></span>
                  </label>
                  <label className="so-row">
                    <input type="checkbox" checked={download} onChange={e => setDownload(e.target.checked)} />
                    <span><b>允許下載</b><small>{download ? '朋友可以存影片和封面，方便他再轉發。' : '朋友只能線上看，不能存檔。'}</small></span>
                  </label>
                  <div className="so-row">
                    <span><b>有效期</b><small>{days === '0' ? '連結一直有效，隨時可在「分享連結」停用。' : `${days} 天後自動失效。`}</small></span>
                    <div className="so-seg">{[['0', '永久'], ['7', '7 天'], ['30', '30 天']].map(([v, l]) => <a key={v} className={days === v ? 'on' : ''} onClick={() => setDays(v)}>{l}</a>)}</div>
                  </div>
                </div>
              )}
            </div>
            <button className="btn primary block lg share-go" disabled={busy} onClick={create}>{busy ? '產生中…' : '產生連結，分享出去 →'}</button>
            <div className="muted small" style={{ textAlign: 'center' }}>下一步可以直接發到 Facebook、LINE，或複製連結。</div>
          </>
        ) : (
          <>
            <div className="made">
              <div className="link-url big-url">{url}</div>
              <div className="row">
                <button className="btn primary" onClick={() => { navigator.clipboard?.writeText(url); flash('link') }}>{copied === 'link' ? '已複製' : '複製連結'}</button>
                <a className="btn" href={made.url} target="_blank" rel="noreferrer">預覽</a>
                {typeof navigator.share === 'function' && <button className="btn" onClick={() => navigator.share({ title: projectName, text: promo, url })}>傳送…</button>}
              </div>
            </div>
            <div className="post-box">
              <div className="post-h"><b>發成貼文</b><span className="muted small">貼文會帶封面預覽，文案順便推廣旅剪和註冊優惠。可以改。</span></div>
              <textarea rows={4} value={promo} onChange={e => setPromo(e.target.value)} />
              <div className="row">
                <button className="btn fb" onClick={() => { shareToFacebook(url, promo); flash('promo') }}><FbIcon /> 分享到 Facebook</button>
                <button className="btn line" onClick={() => shareToLine(promo)}><LineIcon /> 分享到 LINE</button>
                <button className="btn" onClick={() => { navigator.clipboard?.writeText(promo); flash('promo') }}>{copied === 'promo' ? '文案已複製' : '複製文案'}</button>
              </div>
              <div className="muted small">Facebook 不讓網站預填貼文內容，按下去會先把文案複製好，到 FB 視窗貼上即可。</div>
            </div>
            <button className="btn block" onClick={onCreated}>完成</button>
          </>
        )}
      </div>
    </div>
  )
}
