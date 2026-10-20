/* 字幕樣式: the four VO caption presets (= backend subs.CAPTION_STYLES). Picked before the first cut in 導演模式
   and switchable afterwards in 微調 without the editor. */
export const CAPTION_STYLES = [
  { id: 'gold', name: '金字醒目', desc: '預設，旅遊片最常見' },
  { id: 'white', name: '白字黑邊', desc: '乾淨好讀，什麼畫面都配' },
  { id: 'box', name: '黃底黑字', desc: '像綜藝節目，最吸睛' },
  { id: 'soft', name: '清爽細字', desc: '小而細，適合質感片' },
] as const
export type CaptionStyle = typeof CAPTION_STYLES[number]['id']

export const CapSample = ({ id, short = false }: { id: string; short?: boolean }) => (
  <span className={`cap-s cap-${id}`}><span>{short ? <><b>客廳</b>是你的</> : <>整棟包下來 <b>客廳</b> 是你的</>}</span></span>
)

export function CapPicker({ value, onChange }: { value: string; onChange: (id: CaptionStyle) => void }) {
  return (
    <div className="cap-pick" role="radiogroup" aria-label="字幕樣式">
      {CAPTION_STYLES.map(c => (
        <button type="button" key={c.id} role="radio" aria-checked={value === c.id} className={`cap-o ${value === c.id ? 'on' : ''}`} onClick={() => onChange(c.id)}>
          <CapSample id={c.id} />
          <b>{c.name}</b><small>{c.desc}</small>
        </button>
      ))}
    </div>
  )
}
