import { useEffect } from 'react'

/* 字幕樣式 / 字型 / 標題樣式: the presets the backend knows (subs.CAPTION_STYLES, fonts.FONT_PRESETS,
   subs.SUPER_STYLES), each drawn as a small preview so the choice is made by eye. Picked before the
   first cut in 導演模式 and switchable afterwards in the 時間軸 without the editor. */
export const CAPTION_STYLES = [
  { id: 'gold', name: '金字醒目', desc: '預設，旅遊片最常見' },
  { id: 'white', name: '白字黑邊', desc: '乾淨好讀，什麼畫面都配' },
  { id: 'box', name: '黃底黑字', desc: '像綜藝節目，最吸睛' },
  { id: 'soft', name: '清爽細字', desc: '小而細，適合質感片' },
] as const
export type CaptionStyle = typeof CAPTION_STYLES[number]['id']

export const FONTS = [
  { id: 'black', name: '粗黑體', desc: '預設，最清楚', css: "'Noto Sans TC', sans-serif", weight: 900 },
  { id: 'round', name: '圓體', desc: '可愛、親切', css: "'M PLUS Rounded 1c', 'Noto Sans TC', sans-serif", weight: 800 },
  { id: 'kai', name: '楷體', desc: '文青、慢旅行', css: "'LXGW WenKai TC', serif", weight: 700 },
  { id: 'serif', name: '明體', desc: '質感、飯店感', css: "'Noto Serif TC', serif", weight: 900 },
  { id: 'hand', name: '手寫感', desc: '像朋友推薦', css: "'Iansui', cursive", weight: 400 },
] as const
export type FontId = typeof FONTS[number]['id']

export const SUPER_STYLES = [
  { id: 'chip', name: '藍底圓角', desc: '預設' },
  { id: 'bar', name: '品牌色橫條', desc: '醒目' },
  { id: 'outline', name: '白字描邊', desc: '乾淨' },
  { id: 'label', name: '白底黑字', desc: '雜誌感' },
  { id: 'none', name: '不要標題', desc: '只留旁白字幕' },
] as const
export type SuperStyle = typeof SUPER_STYLES[number]['id']

/** The browser-side faces for the previews, loaded once when a picker first shows. */
export function useFontPreviews() {
  useEffect(() => {
    if (document.getElementById('lk-fonts')) return
    const l = document.createElement('link'); l.id = 'lk-fonts'; l.rel = 'stylesheet'
    l.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@900&family=Noto+Serif+TC:wght@900&family=LXGW+WenKai+TC:wght@700&family=M+PLUS+Rounded+1c:wght@800&family=Iansui&display=swap'
    document.head.appendChild(l)
  }, [])
}

const fontCss = (font?: string) => { const f = FONTS.find(x => x.id === font); return f ? { fontFamily: f.css, fontWeight: f.weight } : {} }

export const CapSample = ({ id, short = false, font }: { id: string; short?: boolean; font?: string }) => (
  <span className={`cap-s cap-${id}`} style={fontCss(font)}><span>{short ? <><b>客廳</b>是你的</> : <>整棟包下來 <b>客廳</b> 是你的</>}</span></span>
)
export const SuperSample = ({ id, font }: { id: string; font?: string }) => (
  <span className={`cap-s sup-${id}`} style={fontCss(font)}><span>{id === 'none' ? '—' : '雲岫會館 · 包棟'}</span></span>
)

function Grid<T extends { id: string; name: string; desc?: string }>({ items, value, onChange, render, cols = 4, label }:
  { items: readonly T[]; value: string; onChange: (id: T['id']) => void; render: (it: T) => React.ReactNode; cols?: number; label: string }) {
  return (
    <div className={`cap-pick c${cols}`} role="radiogroup" aria-label={label}>
      {items.map(c => (
        <button type="button" key={c.id} role="radio" aria-checked={value === c.id} className={`cap-o ${value === c.id ? 'on' : ''}`} onClick={() => onChange(c.id)}>
          {render(c)}<b>{c.name}</b>{c.desc && <small>{c.desc}</small>}
        </button>))}
    </div>
  )
}
export const CapPicker = ({ value, onChange, font }: { value: string; onChange: (id: CaptionStyle) => void; font?: string }) =>
  <Grid items={CAPTION_STYLES} value={value} onChange={onChange} label="字幕樣式" render={c => <CapSample id={c.id} short font={font} />} />
export function FontPicker({ value, onChange, style }: { value: string; onChange: (id: FontId) => void; style?: string }) {
  useFontPreviews()
  return <Grid items={FONTS} value={value} onChange={onChange} label="字型" cols={5} render={f => <CapSample id={style ?? 'white'} short font={f.id} />} />
}
export const SuperPicker = ({ value, onChange, font }: { value: string; onChange: (id: SuperStyle) => void; font?: string }) =>
  <Grid items={SUPER_STYLES} value={value} onChange={onChange} label="標題樣式" cols={5} render={s => <SuperSample id={s.id} font={font} />} />

/** 「跟剪輯師說」: under every picker, so people know the presets are a start, not the limit. */
export const StyleHint = ({ what }: { what: string }) => (
  <div className="style-hint">想要的{what}不在裡面？直接在對話跟剪輯師說，或貼一張你喜歡的範例圖，剪輯師會照著做。</div>
)
