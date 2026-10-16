import { useEffect, useRef, useState } from 'react'
import { MiaoMark } from './Logo'

/* Scroll-driven "how it works": a sticky phone on one side, three steps on the other. As each step
   scrolls into view it lights up and the phone screen switches to that moment of the product. The
   screens mirror the real app: the upload queue, the chat with the editor working, the deliverable. */
const STEPS = [
  { k: 'upload', n: '01', t: '丟素材', d: '手機相簿直接上傳，或貼 Google Drive 連結。每支影片都看得到進度，大檔案也不怕斷線。', tag: '約 1 分鐘' },
  { k: 'chat', n: '02', t: '選風格、說賣點', d: '挑一個風格和聲音，像傳訊息一樣把賣點講給剪輯師。他一步一步回報進度，你不用盯著。', tag: '約 2 分鐘' },
  { k: 'done', n: '03', t: '收影片', d: '15 分鐘後拿到有旁白、配樂、雙層字幕的直式影片與封面，歸檔在成品頁，一鍵產生連結給客戶看。', tag: '約 15 分鐘' },
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

const FILES = [
  { n: 'DJI_0001.MP4', c: 'a', p: 100, s: '412 MB' },
  { n: 'IMG_5540.MOV', c: 'b', p: 100, s: '286 MB' },
  { n: 'DJI_0007.MP4', c: 'c', p: 62, s: '1.1 GB' },
]
const R = 15, C = 2 * Math.PI * R

function Phone({ step }: { step: number }) {
  return (
    <div className="phone" data-step={step}>
      <div className="phone-notch" />
      <div className="phone-screen">
        <div className="ps-bar"><MiaoMark size={18} radius={.28} /><span>旅剪</span><i /></div>

        {/* screen 1: upload queue, exactly like the app */}
        <div className={`ps ps-upload ${step === 0 ? 'on' : ''}`}>
          <div className="ps-title">1 · 給素材</div>
          <div className="ps-dz">
            <span className="ps-dz-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M7 5v14M17 5v14M3 10h4M3 14h4M17 10h4M17 14h4" /></svg></span>
            <span><b>點一下選影片，或拖進來</b><small>最多 6 支 · 每支 1 GB</small></span>
          </div>
          <div className="ps-uq">
            <div className="ps-uqhead">
              <span className="ps-ring"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r={R} /><circle cx="18" cy="18" r={R} style={{ strokeDasharray: C, strokeDashoffset: C * .27 }} /></svg><i>73</i></span>
              <span><b>上傳中 2/3</b><small>1.3 GB / 1.8 GB · 4.2 MB/s · 約剩 2 分</small></span>
            </div>
            {FILES.map((f, i) => (
              <div key={f.n} className={`ps-uqrow ${f.p === 100 ? 'ok' : 'up'}`} style={{ animationDelay: `${.25 + i * .3}s` }}>
                <span className={`ps-th ${f.c}`} />
                <span className="ps-uqmain"><span className="ps-uqname">{f.n}</span><small>{f.p === 100 ? `完成 · ${f.s}` : `62% · ${f.s}`}</small><span className="ps-uqbar"><i style={{ width: `${f.p}%` }} /></span></span>
                <em>{f.p === 100 ? '✓' : ''}</em>
              </div>
            ))}
          </div>
        </div>

        {/* screen 2: the conversation while the editor works */}
        <div className={`ps ps-chat ${step === 1 ? 'on' : ''}`}>
          <div className="ps-pick"><span className="sel">旅遊短影音</span><span>質感形象</span><span>促銷活動</span><span className="sel v">Vivian 女聲</span></div>
          <div className="ps-msg user">宜蘭海邊包棟民宿，25 米戲水池、龜山島海景、KTV、寵物友善。平日每人 NT$1,500。</div>
          <div className="ps-msg ai">
            <div className="ps-work"><i className="ps-spin" /><b>剪輯師工作中</b><span>· 剪輯畫面 · 已 3 分 12 秒</span></div>
            <ul className="ps-tools">
              <li className="ok">分析素材<span>41s</span></li>
              <li className="ok">生成旁白並核對<span>58s</span></li>
              <li className="ok">生成配樂<span>12s</span></li>
              <li className="run">剪輯畫面<span>…</span></li>
              <li>字幕 · 輸出 · 封面</li>
            </ul>
            <div className="ps-say">龜山島空拍看不清楚，我改用泳池開場，價格放結尾。<i className="caret" /></div>
          </div>
          <div className="ps-compose"><i /><span>要改哪裡？例如：價格字幕放大…</span><b>送出</b></div>
        </div>

        {/* screen 3: the deliverable in the 成品 tab */}
        <div className={`ps ps-done ${step === 2 ? 'on' : ''}`}>
          <div className="ps-title">3 · 成品</div>
          <div className="ps-vhead"><b>v1</b><span className="ps-pill">最終版</span><small>36 秒 · 22 MB</small></div>
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
