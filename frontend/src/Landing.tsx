import logo from './assets/logo.png'

export const PRODUCT = { name: '秒剪', brand: '人客多 Lakeze', tagline: '旅遊短影音自動剪片軟體' }
const MARKET = { days: 3, low: 2000, high: 3000 }      // what a studio charges today
const OURS = { minutes: 15, twd: 390 }                 // first version incl. cover = 39 points

const Icon = ({ d, d2 }: { d: string; d2?: string }) => (
  <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />{d2 && <path d={d2} />}
  </svg>
)
const STEPS = [
  { t: '丟素材', d: '貼 Google Drive 連結，或從手機直接上傳影片。', icon: <Icon d="M10 34V14a4 4 0 0 1 4-4h7l3 4h10a4 4 0 0 1 4 4v16a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4Z" d2="M24 30v-9m0 0-4 4m4-4 4 4" /> },
  { t: '選風格', d: '旅遊短影音、質感形象或促銷活動，選個聲音，寫兩句賣點。', icon: <Icon d="M12 16h24M12 24h24M12 32h24" d2="M18 12v8M30 20v8M22 28v8" /> },
  { t: '收影片', d: '15 分鐘後拿到有旁白、配樂、字幕的直式影片與封面，一鍵分享給客戶。', icon: <Icon d="M10 14h28v22H10z" d2="M10 20h28M16 14l4 6M24 14l4 6M32 14l4 6M21 26l7 4-7 4z" /> },
]

export function Landing({ onStart, onLogin }: { onStart: () => void; onLogin: () => void }) {
  const saveLow = MARKET.low - OURS.twd, saveHigh = MARKET.high - OURS.twd
  const savePct = Math.round((1 - OURS.twd / ((MARKET.low + MARKET.high) / 2)) * 100)
  const timePct = Math.round((1 - OURS.minutes / (MARKET.days * 24 * 60)) * 1000) / 10
  return (
    <div className="landing">
      <header className="ld-nav">
        <img className="logo" src={logo} alt={PRODUCT.brand} />
        <span className="spacer" />
        <a className="btn ghost" onClick={onLogin}>登入</a>
        <a className="btn primary" onClick={onStart}>免費試做第一支</a>
      </header>

      <section className="ld-hero">
        <div className="ld-kicker">{PRODUCT.brand} · {PRODUCT.tagline}</div>
        <h1><span className="ld-name">{PRODUCT.name}</span></h1>
        <p className="ld-sub">給素材、說賣點，15 分鐘自動剪出有旁白、配樂、雙層字幕的旅遊短影音和封面。</p>
        <div className="ld-cta">
          <a className="btn primary lg" onClick={onStart}>免費試做第一支</a>
          <span className="muted small">第一支影片、封面與 4 輪修改免費，不用綁卡。</span>
        </div>
      </section>

      <section className="ld-steps">
        {STEPS.map((s, i) => (
          <div key={s.t} className="ld-step">
            <div className="ld-icon">{s.icon}<span className="ld-no">{i + 1}</span></div>
            <b>{s.t}</b>
            <p className="muted">{s.d}</p>
            {i < STEPS.length - 1 && <div className="ld-arrow" aria-hidden="true">→</div>}
          </div>
        ))}
      </section>

      <section className="ld-compare">
        <div className="ld-cmp-head"><b>一支 30–40 秒的民宿短影音</b><span className="muted small">業界行情 vs {PRODUCT.name}</span></div>
        <div className="ld-cmp-grid">
          <div className="ld-cmp old">
            <div className="ld-cmp-label">找剪輯師</div>
            <div className="ld-cmp-row"><span>交件</span><b>{MARKET.days} 個工作天</b></div>
            <div className="ld-bar"><div style={{ width: '100%' }} /></div>
            <div className="ld-cmp-row"><span>費用</span><b>NT${MARKET.low.toLocaleString()}–{MARKET.high.toLocaleString()}</b></div>
            <div className="ld-bar"><div style={{ width: '100%' }} /></div>
          </div>
          <div className="ld-cmp new">
            <div className="ld-cmp-label">{PRODUCT.name}</div>
            <div className="ld-cmp-row"><span>交件</span><b>{OURS.minutes} 分鐘</b></div>
            <div className="ld-bar"><div style={{ width: `${Math.max(2, 100 - timePct)}%` }} /></div>
            <div className="ld-cmp-row"><span>費用</span><b>NT${OURS.twd}</b></div>
            <div className="ld-bar"><div style={{ width: `${Math.round(OURS.twd / MARKET.high * 100)}%` }} /></div>
          </div>
        </div>
        <div className="ld-save">
          <div><div className="ld-save-num">{timePct}%</div><div className="muted small">時間省下來：3 天變 15 分鐘，今天拍今天發</div></div>
          <div><div className="ld-save-num">NT${saveLow.toLocaleString()}–{saveHigh.toLocaleString()}</div><div className="muted small">每支省下約 {savePct}% 的費用，一個月發 8 支就省超過一萬</div></div>
        </div>
        <div className="muted small ld-note">費用以第一版含封面 39 點（1 點 = NT$10）計；修改一輪約 NT$80。業界行情為市場常見報價區間。</div>
      </section>

      <section className="ld-foot-cta">
        <b>第一支免費，試了就知道。</b>
        <a className="btn primary lg" onClick={onStart}>免費試做第一支</a>
      </section>
      <footer className="ld-footer muted small">© {PRODUCT.brand} · {PRODUCT.tagline}</footer>
    </div>
  )
}
