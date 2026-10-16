import logo from './assets/logo.png'
import { MiaoLogo } from './Logo'
import { HowItWorks } from './HowItWorks'
import { useEffect } from 'react'

export const PRODUCT = { name: '旅剪', brand: '人客多 Lakeze', tagline: '旅遊短影音自動剪片軟體' }
const MARKET = { days: 3, low: 2000, high: 3000 }      // what a studio charges today
// One video with cover and 2 revision rounds (the usual path to a final cut); from backend/app/pricing.py.
const OURS = { minutes: 15, twd: 700 }                 // pay-as-you-go: 100 points × NT$7
const SUB = { name: '專業旅人', twd: 3150, videos: 5, perVideo: 630 }   // monthly: 5 videos, 2 revisions each, 20 GB
const SIGNUP_POINTS = 110


function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('.reveal'))
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { els.forEach(e => e.classList.add('in')); return }
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) } }), { threshold: .18 })
    els.forEach(e => io.observe(e))
    return () => io.disconnect()
  }, [])
}

export function Landing({ onStart, onLogin }: { onStart: () => void; onLogin: () => void }) {
  useReveal()
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
        <div className="ld-blob a" aria-hidden="true" /><div className="ld-blob b" aria-hidden="true" />
        <div className="ld-kicker reveal in">{PRODUCT.brand}</div>
        <h1 className="reveal in d1"><MiaoLogo size={96} tagline /></h1>
        <p className="ld-sub reveal in d2">丟影片或照片、說賣點，<b>15 分鐘</b>自動剪出有旁白口播、配樂、雙層字幕的旅遊短影音，<b>封面一起做好</b>。</p>
        <div className="ld-cta reveal in d3">
          <a className="btn primary lg" onClick={onStart}>免費試做第一支</a>
          <span className="muted small">註冊送 {SIGNUP_POINTS} 點，第一支影片含封面與 2 輪修改免費，所有功能都能用，不用綁卡。</span>
        </div>
      </section>

      <HowItWorks />

      <section className="ld-compare">
        <div className="ld-cmp-head reveal"><b>一支 30–40 秒的民宿短影音</b><span className="muted small">業界行情 vs {PRODUCT.name}</span></div>
        <div className="ld-cmp-grid">
          <div className="ld-cmp old reveal">
            <div className="ld-cmp-label">找剪輯師</div>
            <div className="ld-cmp-row"><span>交件</span><b>{MARKET.days} 個工作天</b></div>
            <div className="ld-bar"><div style={{ width: '100%' }} /></div>
            <div className="ld-cmp-row"><span>費用</span><b>NT${MARKET.low.toLocaleString()}–{MARKET.high.toLocaleString()}</b></div>
            <div className="ld-bar"><div style={{ width: '100%' }} /></div>
          </div>
          <div className="ld-cmp new reveal d1">
            <div className="ld-cmp-label">{PRODUCT.name}</div>
            <div className="ld-cmp-row"><span>交件</span><b>{OURS.minutes} 分鐘</b></div>
            <div className="ld-bar"><div style={{ width: `${Math.max(2, 100 - timePct)}%` }} /></div>
            <div className="ld-cmp-row"><span>費用（含 2 輪修改）</span><b>NT${OURS.twd}</b></div>
            <div className="ld-bar"><div style={{ width: `${Math.round(OURS.twd / MARKET.high * 100)}%` }} /></div>
          </div>
        </div>
        <div className="ld-save">
          <div className="reveal"><div className="ld-save-num">{timePct}%</div><div className="muted small">時間省下來：3 天變 15 分鐘，今天拍今天發</div></div>
          <div className="reveal d1"><div className="ld-save-num">NT${saveLow.toLocaleString()}–{saveHigh.toLocaleString()}</div><div className="muted small">每支省下約 {savePct}% 的費用；包月 {SUB.name} 每支再降到 NT${SUB.perVideo}（每月 NT${SUB.twd.toLocaleString()}，{SUB.videos} 支）</div></div>
        </div>
        <div className="muted small ld-note">單次購買以一支含封面與 2 輪修改 100 點計（1 點 = NT$7）；包月另含成品空間。業界行情為市場常見報價區間。</div>
      </section>

      <section className="ld-foot-cta reveal">
        <b>第一支免費，試了就知道。</b>
        <a className="btn primary lg" onClick={onStart}>免費試做第一支</a>
      </section>
      <footer className="ld-footer muted small">© {PRODUCT.brand} · {PRODUCT.tagline}</footer>
    </div>
  )
}
