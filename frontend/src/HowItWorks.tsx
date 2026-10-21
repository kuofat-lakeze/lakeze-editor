import { useEffect, useRef, useState } from 'react'
import { Mark } from './Logo'

/* Scroll-driven "how it works": a sticky phone on one side, three steps on the other. As each step
   scrolls into view it lights up and the phone screen switches to that moment of the product.
   On phones the step copy moves under the sticky mockup as a short caption (the list becomes
   invisible scroll spacers). Every step change there is made obvious: the phone remounts with a
   bump, the screen slides in, the background tint and the big step pills change, and a scroll hint
   says there is more. */
const STEPS = [
  { k: 'upload', n: '01', t: '丟素材', m: '相簿選影片、照片，自動上傳。', d: '影片、照片混著給都行：手機相簿直接上傳，或貼 Google Drive 連結。每個檔案都看得到進度，大檔案也不怕斷線。', tag: '約 1 分鐘' },
  { k: 'chat', n: '02', t: '說賣點', m: '挑風格和聲音，賣點用說的就好。', d: '挑一個風格和聲音，像傳訊息一樣把賣點講給剪輯師。他一步一步回報進度，你不用盯著。', tag: '約 2 分鐘' },
  { k: 'done', n: '03', t: '收影片', m: '15 分鐘：旁白、字幕、封面全都好。', d: '15 分鐘後拿到有旁白口播、配樂、雙層字幕的直式影片，封面一起做好，全部歸檔在成品頁，一鍵分享給朋友。', tag: '約 15 分鐘' },
]

function useIsMobile() {
  const [m, setM] = useState(() => typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches)
  useEffect(() => {
    const mq = matchMedia('(max-width: 760px)'); const f = () => setM(mq.matches)
    mq.addEventListener('change', f); return () => mq.removeEventListener('change', f)
  }, [])
  return m
}

const smooth = (t: number) => t * t * (3 - 2 * t)
/* scroll fraction inside one step → slide amount: hold the screen, glide across the middle, hold again */
const ease = (p: number) => { const i = Math.floor(p), f = p - i; const t = Math.min(1, Math.max(0, (f - 0.3) / 0.4)); return Math.min(2, i + smooth(t)) }

export function HowItWorks() {
  const [active, setActive] = useState(0)
  const mobile = useIsMobile()
  const refs = useRef<(HTMLLIElement | null)[]>([])
  const listRef = useRef<HTMLOListElement>(null)
  const stickyRef = useRef<HTMLDivElement>(null)
  // Phones: the screens and captions sit side by side and slide with the scroll position itself
  // (no jumps, no timers), so scrolling feels like swiping through three cards. Desktop: the step
  // nearest the middle of the viewport lights up.
  useEffect(() => {
    const scroller = (listRef.current?.closest('.landing') as HTMLElement | null) ?? window
    let raf = 0, last = -1
    const update = () => {
      raf = 0
      const list = listRef.current, sticky = stickyRef.current
      if (!list || !sticky) return
      const vh = window.innerHeight
      let e: number
      if (mobile) {
        const r = list.getBoundingClientRect()
        const H = r.height / STEPS.length
        const p = Math.min(2, Math.max(0, (vh * 0.3 - r.top) / H))
        e = ease(p)
      } else {
        const mids = refs.current.map(el => { const b = el!.getBoundingClientRect(); return Math.abs(b.top + b.height / 2 - vh / 2) })
        e = mids.indexOf(Math.min(...mids))
      }
      sticky.style.setProperty('--pe', e.toFixed(4))
      const a = Math.round(e)
      if (a !== last) { last = a; setActive(a) }
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update) }
    update()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => { scroller.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); cancelAnimationFrame(raf) }
  }, [mobile])
  const go = (i: number) => {
    const list = listRef.current; const scroller = list?.closest('.landing') as HTMLElement | null
    if (!list || !scroller) return
    if (!mobile) { refs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return }
    const H = list.getBoundingClientRect().height / STEPS.length
    const target = scroller.scrollTop + list.getBoundingClientRect().top - window.innerHeight * 0.3 + i * H + H * 0.05
    scroller.scrollTo({ top: target, behavior: 'smooth' })
  }
  const cur = STEPS[active]
  return (
    <section className="hiw" id="how">
      <div className="hiw-head reveal">
        <span className="eyebrow">怎麼用</span>
        <h2>三步，影片就好了。</h2>
        <p className="muted">不用學剪接軟體，像傳訊息給一位剪輯師一樣。</p>
      </div>
      <div className="hiw-grid">
        <div className="hiw-sticky" data-step={active} ref={stickyRef}>
          <div className="hiw-pills" aria-hidden="true">
            {STEPS.map((s, i) => <a key={s.k} className={active === i ? 'on' : active > i ? 'done' : ''} onClick={() => go(i)}><i>{active > i ? '✓' : i + 1}</i>{s.t}</a>)}
            <span className="hiw-prog"><i /></span>
          </div>
          <Phone step={active} />
          <div className="hiw-captions">
            <div className="hiw-cap-track">
              {STEPS.map((s, i) => (
                <div key={s.k} className={`hiw-caption ${i === active ? 'on' : ''}`}>
                  <h3>{s.t}<span className="hiw-tag">{s.tag}</span></h3>
                  <p>{mobile ? s.m : s.d}</p>
                </div>))}
            </div>
            {active < 2 ? <div className="hiw-hint" onClick={() => go(active + 1)}>往下滑，看第 {active + 2} 步 <i>↓</i></div> : <div className="hiw-hint done">就這樣，影片好了 ✓</div>}
          </div>
          {!mobile && <span className="sr-only">{cur.t}</span>}
        </div>
        <ol className="hiw-steps" ref={listRef}>
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
    </section>
  )
}

const FILES = [
  { n: 'DJI_0001.MP4', c: 'a', kind: '影片', p: 100, s: '412 MB' },
  { n: 'IMG_5540.JPG', c: 'b', kind: '照片', p: 100, s: '4.2 MB' },
  { n: 'IMG_5541.JPG', c: 'd', kind: '照片', p: 100, s: '3.9 MB' },
  { n: 'DJI_0007.MP4', c: 'c', kind: '影片', p: 62, s: '1.1 GB' },
]
const R = 15, C = 2 * Math.PI * R

/* Painted stand-ins for real frames: a sea-view villa with an infinity pool and 龜山島 on the horizon. */
function Scene({ kind }: { kind: 'day' | 'sunset' | 'pool' }) {
  const sky = kind === 'sunset' ? ['#FF9A62', '#FFC98B', '#FFE3B0'] : kind === 'pool' ? ['#7FC8E8', '#B9E4F2', '#E6F6FA'] : ['#4FA9D8', '#8ED0EC', '#D4EFF8']
  const sea = kind === 'sunset' ? ['#E8865A', '#9C4F4A'] : ['#2E8DB8', '#1B5C80']
  return (
    <svg className="ps-scene" viewBox="0 0 90 160" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id={`sk-${kind}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={sky[0]} /><stop offset=".6" stopColor={sky[1]} /><stop offset="1" stopColor={sky[2]} /></linearGradient>
        <linearGradient id={`se-${kind}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={sea[0]} /><stop offset="1" stopColor={sea[1]} /></linearGradient>
        <linearGradient id={`pl-${kind}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5FE0E6" /><stop offset="1" stopColor="#1FA7C2" /></linearGradient>
      </defs>
      <rect width="90" height="160" fill={`url(#sk-${kind})`} />
      {kind === 'sunset'
        ? <circle cx="62" cy="66" r="11" fill="#FFF1C9" opacity=".95" />
        : <circle cx="70" cy="22" r="7" fill="#FFF8DD" opacity=".9" />}
      <g fill="#fff" opacity=".75"><ellipse cx="22" cy="26" rx="12" ry="3.2" /><ellipse cx="30" cy="24" rx="7" ry="3" /><ellipse cx="58" cy="40" rx="9" ry="2.4" /></g>
      {/* 龜山島 */}
      <path d="M8 78 C 16 70, 22 66, 30 69 C 34 62, 38 62, 41 70 C 46 70, 52 74, 56 78 Z" fill={kind === 'sunset' ? '#7A4A55' : '#3F6E7E'} opacity=".85" />
      <rect y="77" width="90" height="40" fill={`url(#se-${kind})`} />
      <g stroke="#fff" strokeOpacity=".45" strokeWidth=".8" strokeLinecap="round"><path d="M10 86h12M40 92h16M66 84h10M20 100h14M58 104h18" /></g>
      {kind === 'sunset' && <path d="M56 78 L68 78 L64 116 L60 116 Z" fill="#FFE3A3" opacity=".35" />}
      {/* deck + infinity pool */}
      <path d="M0 112 L90 104 L90 160 L0 160 Z" fill="#E9D9C2" />
      <path d="M0 118 L90 110 L90 134 L0 142 Z" fill={`url(#pl-${kind})`} />
      <g stroke="#fff" strokeOpacity=".7" strokeWidth="1" strokeLinecap="round" fill="none"><path d="M8 128 q6 -3 12 0 t12 0" /><path d="M48 122 q6 -3 12 0 t12 0" /></g>
      {/* villa */}
      <g>
        <rect x="58" y="88" width="30" height="20" fill="#FAF6EF" />
        <path d="M55 89 L73 79 L91 89 Z" fill="#5A4A42" />
        <rect x="62" y="93" width="7" height="8" fill="#9FD3E6" /><rect x="74" y="93" width="9" height="8" fill="#9FD3E6" />
        <rect x="70" y="100" width="4" height="8" fill="#B07A52" />
      </g>
      {/* palm */}
      <g transform="translate(14 104)">
        <path d="M0 0 C 1 -12, 3 -22, 6 -30" stroke="#6B4A2E" strokeWidth="2" fill="none" />
        <g fill="#2F8F5B"><path d="M6 -30 C 0 -34, -8 -32, -12 -26 C -4 -30, 2 -29, 6 -30 Z" /><path d="M6 -30 C 12 -36, 20 -34, 24 -28 C 16 -31, 10 -30, 6 -30 Z" /><path d="M6 -30 C 4 -38, 8 -44, 14 -46 C 9 -40, 8 -35, 6 -30 Z" /><path d="M6 -30 C 0 -36, -4 -42, -2 -46 C 0 -40, 3 -35, 6 -30 Z" /></g>
      </g>
      {kind === 'pool' && <g><circle cx="34" cy="128" r="4" fill="#FF6B6B" /><path d="M30 128h8" stroke="#fff" strokeWidth="1.4" /><ellipse cx="52" cy="131" rx="5" ry="1.6" fill="#FFD23F" /></g>}
      <rect width="90" height="160" fill="url(#vig)" />
    </svg>
  )
}

function Phone({ step }: { step: number }) {
  return (
    <div className="phone" data-step={step}>
      <div className="phone-notch" />
      <div className="phone-screen">
        <div className="ps-bar"><Mark size={18} /><span>旅剪</span><i /></div>

        {/* screen 1: upload queue with videos and photos mixed, exactly like the app */}
        <div className={`ps ps-upload ${step === 0 ? 'on' : ''}`} style={{ ['--i' as string]: 0 }}>
          <div className="ps-title">1 · 給素材</div>
          <div className="ps-dz">
            <span className="ps-dz-ic an-bounce"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M7 5v14M17 5v14M3 10h4M3 14h4M17 10h4M17 14h4" /></svg></span>
            <span><b>影片、照片一起選</b><small>最多 6 個 · 每個 1 GB</small></span>
          </div>
          <div className="ps-uq">
            <div className="ps-uqhead">
              <span className="ps-ring"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r={R} /><circle cx="18" cy="18" r={R} style={{ strokeDasharray: C, strokeDashoffset: C * .22 }} /></svg><i>78</i></span>
              <span><b>上傳中 3/4</b><small>1.2 GB / 1.5 GB · 4.2 MB/s · 約剩 1 分</small></span>
            </div>
            {FILES.map((f, i) => (
              <div key={f.n} className={`ps-uqrow ${f.p === 100 ? 'ok' : 'up'}`} style={{ animationDelay: `${.25 + i * .25}s` }}>
                <span className={`ps-th ${f.c}`}><i className={f.kind === '照片' ? 'photo' : ''}>{f.kind}</i></span>
                <span className="ps-uqmain"><span className="ps-uqname">{f.n}</span><small>{f.p === 100 ? `完成 · ${f.s}` : `62% · ${f.s}`}</small><span className="ps-uqbar"><i style={{ width: `${f.p}%` }} /></span></span>
                <em>{f.p === 100 ? '✓' : ''}</em>
              </div>
            ))}
          </div>
        </div>

        {/* screen 2: the conversation while the editor works */}
        <div className={`ps ps-chat ${step === 1 ? 'on' : ''}`} style={{ ['--i' as string]: 1 }}>
          <div className="ps-pick"><span className="sel">旅遊短影音</span><span>質感形象</span><span>促銷活動</span><span className="sel v">薇薇安 女聲</span></div>
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
            <div className="ps-say"><span>龜山島空拍看不清楚，我改用泳池開場，價格放結尾。</span><i className="caret" /></div>
          </div>
          <div className="ps-compose"><i /><span>要改哪裡？例如：價格字幕放大…</span><b>送出</b></div>
        </div>

        {/* screen 3: video + covers + narration, as in the 成品 tab */}
        <div className={`ps ps-done ${step === 2 ? 'on' : ''}`} style={{ ['--i' as string]: 2 }}>
          <div className="ps-vhead"><b>v1</b><span className="ps-pill">最終版</span><small>36 秒 · 影片＋2 張封面</small></div>
          <div className="ps-result">
            <div className="ps-video rich">
              <Scene kind="day" />
              <div className="ps-super">KTV · 電動麻將 · 寵物友善</div>
              <div className="ps-headline">宜蘭海邊包棟<br /><em>25米戲水池</em></div>
              <div className="ps-narr"><i className="ps-mic" /><span className="ps-wave"><b /><b /><b /><b /><b /><b /><b /><b /></span><small>薇薇安 旁白</small></div>
              <div className="ps-sub">推開窗就是龜山島海景</div>
              <div className="ps-play" />
            </div>
            <div className="ps-covers">
              <div className="ps-cover a rich"><Scene kind="sunset" /><span>封面 A</span><i className="ps-cv-tag">龜山島海景</i><b>宜蘭海邊<br />包棟民宿</b><em><small>平日每人</small>NT$1,500</em></div>
              <div className="ps-cover b rich"><Scene kind="pool" /><span>封面 B</span><i className="ps-cv-tag hot">寵物友善</i><b>25 米<br />無邊際泳池</b><em><small>平日每人</small>1,500</em></div>
            </div>
          </div>
          <div className="ps-actions"><span>下載</span><span className="pri glow">分享給朋友</span></div>
          <div className="ps-confetti" aria-hidden="true">{Array.from({ length: 14 }).map((_, i) => <i key={i} style={{ left: `${(i * 7.3) % 100}%`, animationDelay: `${(i % 7) * .12}s`, background: ['#EC5A1E', '#F5921E', '#46B9BD', '#1B7AC3', '#FFD23F'][i % 5] }} />)}</div>
        </div>
      </div>
    </div>
  )
}
