import { useEffect, useState } from 'react'
import { api, type Order, type PayMethods } from './api'

/* 付款流程, three screens: 確認訂單 → 付款 (card redirect or bank transfer) → 結果.
   The result screen also handles the return from the card checkout (/pay/result?order=…). */
type Item = { id: string; title: string; sub: string; points: number; twd: number; listTwd?: number; kind: 'pack' | 'sub' }
const twd = (n: number) => `NT$${n.toLocaleString()}`
const STEPS = ['確認', '付款', '完成']

function Progress({ at }: { at: number }) {
  return (
    <ol className="pay-steps">
      {STEPS.map((s, i) => <li key={s} className={i < at ? 'done' : i === at ? 'on' : ''}><i>{i < at ? '✓' : i + 1}</i>{s}</li>)}
    </ol>
  )
}

export function PayFlow({ item, onClose, onPaid }: { item: Item; onClose: () => void; onPaid: () => void }) {
  const [methods, setMethods] = useState<PayMethods | null>(null)
  const [method, setMethod] = useState<'card' | 'transfer' | 'test'>('card')
  const [order, setOrder] = useState<Order | null>(null)
  const [bank, setBank] = useState<Record<string, string> | null>(null)
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState('')
  useEffect(() => {
    api.payMethods(item.id).then(m => { setMethods(m); setMethod(m.test ? 'test' : m.card ? 'card' : 'transfer') }).catch(() => setMethods({ card: false, transfer: false, test: false, note: '' }))
  }, [])
  const none = methods && !methods.card && !methods.transfer && !methods.test
  const go = async () => {
    setBusy(true); setErr('')
    try {
      const r = await api.createOrder(item.id, method)
      setOrder(r.order)
      if (r.order.status === 'paid') { onPaid(); return }
      if (r.redirect) { location.href = r.redirect; return }
      if (r.bank) setBank(r.bank)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const report = async () => {
    if (!order) return
    setBusy(true); setErr('')
    try { setOrder((await api.reportTransfer(order.id, ref)).order) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const copy = (k: string, v: string) => { navigator.clipboard?.writeText(v).catch(() => {}); setCopied(k); setTimeout(() => setCopied(''), 1500) }
  const at = !order ? 0 : order.status === 'paid' || order.status === 'reported' ? 2 : 1

  return (
    <div className="modal-bg pay-bg" onClick={onClose}>
      <div className="modal card pay" onClick={e => e.stopPropagation()}>
        <div className="modal-head"><h3>{at === 2 ? (order?.status === 'paid' ? '付款完成' : '已收到你的轉帳通知') : '購買'}</h3><a onClick={onClose}>✕</a></div>
        <Progress at={at} />

        {/* 1 · 確認 */}
        {!order && (
          <>
            <div className="pay-item">
              <div><b>{item.title}</b><span className="muted small">{item.sub}</span></div>
              <div className="pay-amt">{item.listTwd && item.listTwd > item.twd && <s className="muted small">{twd(item.listTwd)}</s>}<b>{twd(item.twd)}</b></div>
            </div>
            <div className="pay-get">
              <span>入帳</span><b>{item.points.toLocaleString()} 點</b>
              <span className="muted small">{item.kind === 'sub' ? '每月自動入帳；沒用完的點數會累積' : '點數不會過期'}</span>
            </div>
            {!methods ? <div className="muted small">載入付款方式…</div> : none ? (
              <div className="card need"><div><b>線上付款即將開通</b><div className="muted small">{methods.note || '請聯絡客服購買，入帳後點數會自動出現。'}</div></div></div>
            ) : (
              <>
                <div className="muted small pay-lbl">付款方式</div>
                <div className="pay-methods">
                  {methods.test && <a className={method === 'test' ? 'on' : ''} onClick={() => setMethod('test')}><b>測試帳號</b><small>不用付款，直接入帳</small></a>}
                  {methods.card && <a className={method === 'card' ? 'on' : ''} onClick={() => setMethod('card')}><b>💳 信用卡</b><small>即時入帳 · 支援 Apple Pay</small></a>}
                  {methods.transfer && <a className={method === 'transfer' ? 'on' : ''} onClick={() => setMethod('transfer')}><b>🏦 銀行轉帳</b><small>轉帳後填末五碼，確認後入帳</small></a>}
                </div>
                {err && <div className="error">{err}</div>}
                <button className="btn primary block lg" disabled={busy} onClick={go}>
                  {busy ? '處理中…' : method === 'card' ? `前往付款 ${twd(item.twd)} →` : method === 'transfer' ? '取得轉帳資訊 →' : '直接入帳 →'}
                </button>
                <div className="muted small pay-fine">{method === 'card' ? '會開啟安全的付款頁，付完自動回到這裡。' : method === 'transfer' ? '轉帳不收手續費以外的費用，1 個工作天內確認入帳。' : '測試帳號不會產生任何費用。'}</div>
              </>
            )}
          </>
        )}

        {/* 2 · 轉帳資訊 */}
        {order && order.status === 'pending' && bank && (
          <>
            <div className="pay-bank">
              <div className="muted small">請轉帳到以下帳戶</div>
              {[['銀行', `${bank.bank ?? ''}${bank.code ? `（${bank.code}）` : ''}`], ['帳號', bank.account ?? ''], ['戶名', bank.name ?? ''], ['金額', twd(order.amount_twd)]].map(([k, v]) => (
                <div key={k} className="pb-row"><span>{k}</span><b>{v}</b>{k !== '銀行' && k !== '戶名' && <a className="small" onClick={() => copy(k, k === '金額' ? String(order.amount_twd) : v)}>{copied === k ? '已複製' : '複製'}</a>}</div>))}
              <div className="muted small">訂單編號 {order.id}</div>
            </div>
            <label className="field"><span>轉好了？填你的帳號末五碼</span>
              <input inputMode="numeric" maxLength={10} placeholder="例如 12345" value={ref} onChange={e => setRef(e.target.value)} /></label>
            {err && <div className="error">{err}</div>}
            <button className="btn primary block lg" disabled={busy || !ref.trim()} onClick={report}>{busy ? '送出中…' : '我已轉帳'}</button>
            <a className="small pay-later" onClick={onClose}>晚點再轉（訂單會保留，在「明細」可以找到）</a>
          </>
        )}

        {/* 3 · 結果 */}
        {order && order.status === 'reported' && (
          <div className="pay-done wait">
            <div className="pd-ic">⏳</div>
            <b>收到了！我們確認款項後就會入帳</b>
            <span className="muted small">通常 1 個工作天內。入帳後側欄的點數會自動更新，不用再回來這裡。</span>
            <div className="pd-sum"><span>{order.label}</span><b>{twd(order.amount_twd)}</b><span className="muted small">末五碼 {order.transfer_ref}</span></div>
            <button className="btn primary block" onClick={onClose}>好，回去剪片</button>
          </div>
        )}
      </div>
    </div>
  )
}

/* Landing page after the card checkout (and the deep link for any order). Polls until the webhook lands. */
export function PayResult({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const [order, setOrder] = useState<Order | null>(null)
  const [bal, setBal] = useState<number | null>(null)
  const [err, setErr] = useState('')
  const [tries, setTries] = useState(0)
  useEffect(() => {
    let dead = false
    const tick = () => api.order(orderId).then(r => { if (dead) return; setOrder(r.order); setBal(r.balance); setTries(t => t + 1) }).catch(e => !dead && setErr((e as Error).message))
    tick()
    const t = setInterval(() => { if (!order || order.status === 'pending') tick() }, 2500)
    return () => { dead = true; clearInterval(t) }
  }, [orderId]) // eslint-disable-line react-hooks/exhaustive-deps
  const status = order?.status
  const slow = status === 'pending' && tries > 24   // ~1 minute
  return (
    <div className="pay-page">
      <div className="card pay">
        <Progress at={status === 'paid' ? 3 : status === 'failed' || status === 'cancelled' ? 1 : 2} />
        {err && <div className="pay-done fail"><div className="pd-ic">⚠️</div><b>找不到這筆訂單</b><span className="muted small">{err}</span><button className="btn block" onClick={onDone}>回到旅剪</button></div>}
        {!err && !order && <div className="pay-done"><span className="spinner" /><b>確認付款中…</b></div>}
        {status === 'pending' && (
          <div className="pay-done wait">
            <div className="pd-ic"><span className="spinner big" /></div>
            <b>{slow ? '付款還在確認中' : '確認付款中…'}</b>
            <span className="muted small">{slow ? '刷卡公司回覆比較慢，你可以先回去剪片，入帳後點數會自動更新。' : '通常幾秒鐘就好，請不要關掉這個頁面。'}</span>
            {slow && <button className="btn primary block" onClick={onDone}>先回去剪片</button>}
          </div>
        )}
        {status === 'reported' && (
          <div className="pay-done wait"><div className="pd-ic">⏳</div><b>等待確認轉帳</b><span className="muted small">確認後就會入帳，通常 1 個工作天內。</span><button className="btn primary block" onClick={onDone}>回去剪片</button></div>
        )}
        {status === 'paid' && order && (
          <div className="pay-done ok">
            <div className="pd-ic">🎉</div>
            <b>付款完成，{order.kind === 'sub' ? `${order.label}已開通` : `${order.points} 點已入帳`}</b>
            <div className="pd-sum"><span>{order.label}</span><b>{twd(order.amount_twd)}</b>{bal !== null && <span className="muted small">目前餘額 {bal.toLocaleString()} 點</span>}</div>
            <button className="btn primary block lg" onClick={onDone}>開始剪片 →</button>
          </div>
        )}
        {(status === 'failed' || status === 'cancelled') && order && (
          <div className="pay-done fail">
            <div className="pd-ic">🙈</div>
            <b>{status === 'cancelled' ? '付款已取消' : '付款沒有成功'}</b>
            <span className="muted small">沒有扣款，也不會入帳。可以再試一次或換一種付款方式。</span>
            <button className="btn primary block" onClick={onDone}>回到購買頁</button>
          </div>
        )}
      </div>
    </div>
  )
}
