import { useEffect, useRef, useState } from 'react'
import { MiaoMark } from './Logo'

/* Scroll-driven "how it works": a sticky phone on one side, three steps on the other. As each step
   scrolls into view it lights up and the phone screen switches to that moment of the product. */
const STEPS = [
  { k: 'upload', n: '01', t: '丟素材', d: '貼 Google Drive 連結，或從手機相簿直接上傳。素材多也沒關係，AI 會自己看完每一支。', tag: '約 1 分鐘' },
  { k: 'style', n: '02', t: '選風格、說賣點', d: '旅遊短影音、質感形象或促銷活動，挑一個聲音，寫兩句賣點。不用寫腳本。', tag: '約 2 分鐘' },
  { k: 'done', n: '03', t: '收影片', d: '15 分鐘後拿到有旁白、配樂、雙層字幕的直式影片與封面。一鍵產生連結給客戶看。', tag: '約 15 分鐘' },
]

export function HowItWorks() {
  const [active, setActive] = useState(0)
  const refs = useRef<(HTMLLIElement | null)[]>([])
  useEffect(() => {
    const io = new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i))
    }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 })
    refs.current.forEach(el => el && io.observe(el))
    return () => io.disconnect()
  }, [])
  return (
    <section className="hiw" id="how">
      <div className="hiw-head reveal">
        <span className="eyebrow">怎麼用</span>
        <h2>三步，影片就好了。</h2>
        <p className="muted">不用學剪接軟體，像傳訊息給一位剪輯師一樣。</p>
      </div>
      <div className="hiw-grid">
        <div className="hiw-sticky">
          <Phone step={active} />
        </div>
        <ol className="hiw-steps">
          {STEPS.map((s, i) => (
            <li key={s.k} ref={el => { refs.current[i] = el }} data-i={i} className={`hiw-step ${active === i ? 'on' : ''}`}>
              <div className="hiw-no">{s.n}</div>
              <div>
                <h3>{s.t}<span className="hiw-tag">{s.tag}</span></h3>
                <p>{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="hiw-dots" aria-hidden="true">{STEPS.map((_, i) => <i key={i} className={active === i ? 'on' : ''} />)}</div>
    </section>
  )
}

function Phone({ step }: { step: number }) {
  return (
    <div className="phone" data-step={step}>
      <div className="phone-notch" />
      <div className="phone-screen">
        <div className="ps-bar"><MiaoMark size={18} radius={.28} /><span>秒剪</span><i /></div>
        {/* screen 1: upload */}
        <div className={`ps ps-upload ${step === 0 ? 'on' : ''}`}>
          <div className="ps-title">1 · 給素材</div>
          <div className="ps-input">https://drive.google.com/…</div>
          <div className="ps-or">或</div>
          <div className="ps-drop">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M12 15V4m0 0-4 4m4-4 4 4" /></svg>
            <span>從手機上傳影片</span>
          </div>
          <div className="ps-files">
            {['DJI_0001.MP4', 'IMG_5540.mov', 'DJI_0007.MP4'].map((f, i) => (
              <div key={f} className="ps-file" style={{ animationDelay: `${i * .35}s` }}><span>{f}</span><b /></div>))}
          </div>
        </div>
        {/* screen 2: style + voice + brief */}
        <div className={`ps ps-style ${step === 1 ? 'on' : ''}`}>
          <div className="ps-title">2 · 選風格與聲音</div>
          <div className="ps-chips">
            <span className="sel">旅遊短影音</span><span>質感形象</span><span>促銷活動</span>
          </div>
          <div className="ps-voices"><span className="sel">Vivian 女</span><span>Kuo Yu 男</span><span>不要配音</span></div>
          <div className="ps-brief">宜蘭海邊包棟民宿，25 米戲水池、龜山島海景、KTV、寵物友善。平日每人 NT$1,500。<i className="caret" /></div>
          <div className="ps-go">開始剪輯</div>
        </div>
        {/* screen 3: result */}
        <div className={`ps ps-done ${step === 2 ? 'on' : ''}`}>
          <div className="ps-title">3 · 成品 v1</div>
          <div className="ps-video">
            <div className="ps-super">KTV · 電動麻將 · 寵物友善</div>
            <div className="ps-headline">宜蘭海邊包棟<br /><em>25米戲水池</em></div>
            <div className="ps-price"><small>平日每人</small>NT$1,500</div>
            <div className="ps-play" />
          </div>
          <div className="ps-actions"><span>下載 1080p</span><span className="pri">分享給客戶</span></div>
        </div>
      </div>
    </div>
  )
}
