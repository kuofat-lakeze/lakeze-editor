import { MiaoLogo } from './Logo'

/* /privacy and /terms: the two pages every sign-in provider (Google, Facebook, LINE) and payment
   provider asks for. Plain language, Taiwan law. Company facts live in LEGAL so they are easy to fix. */
export const LEGAL = {
  company: '人客多 Lakeze',          // 公司登記名稱（請確認）
  product: '旅剪 Tripcut',
  site: 'editor.lakeze.com',
  email: 'service@lakeze.com',        // 客服／個資聯絡信箱（請確認）
  court: '臺灣臺北地方法院',          // 合意管轄法院（依公司所在地調整）
  updated: '2026 年 10 月 18 日',
}

const Section = ({ t, children }: { t: string; children: React.ReactNode }) => <section className="lg-sec"><h2>{t}</h2>{children}</section>

export function LegalPage({ kind }: { kind: 'privacy' | 'terms' }) {
  const L = LEGAL
  return (
    <div className="legal">
      <header className="lg-head">
        <a href="/" className="lg-logo"><MiaoLogo size={30} /></a>
        <nav className="lg-nav">
          <a href="/privacy" className={kind === 'privacy' ? 'on' : ''}>隱私權政策</a>
          <a href="/terms" className={kind === 'terms' ? 'on' : ''}>服務條款</a>
        </nav>
      </header>
      <main className="lg-main">
        {kind === 'privacy' ? <Privacy /> : <Terms />}
        <footer className="lg-foot muted small">© {L.company} · 最後更新：{L.updated} · 有任何問題請來信 <a href={`mailto:${L.email}`}>{L.email}</a></footer>
      </main>
    </div>
  )
}

function Privacy() {
  const L = LEGAL
  return (
    <>
      <h1>隱私權政策</h1>
      <p className="lg-lead">{L.product}（以下稱「本服務」）由 {L.company}（以下稱「我們」）提供。這份政策說明我們會蒐集哪些資料、為什麼蒐集、怎麼使用與保護，以及你有哪些權利。我們依中華民國《個人資料保護法》處理你的個人資料。</p>

      <Section t="1. 我們蒐集哪些資料">
        <ul>
          <li><b>帳號資料</b>：Email、顯示名稱；用 Google、Facebook 或 LINE 登入時，我們只取得該平台提供的 Email、名稱與帳號識別碼，不會取得你的密碼、好友名單或貼文。</li>
          <li><b>你上傳的素材</b>：影片、照片、雲端分享連結裡的檔案，以及你輸入的文字（主題、賣點、價格、店名等）。</li>
          <li><b>聲音</b>：如果你選擇「用自己的聲音」，我們會保存你錄的樣本與產生的聲音模型；如果你在校對台自己唸某一句，會保存那段錄音。</li>
          <li><b>成品</b>：剪好的影片、封面、旁白音檔與字幕設定。</li>
          <li><b>交易資料</b>：點數餘額、購買與扣點紀錄、訂閱狀態、發票資訊。信用卡號由統一金流 PAYUNi 處理，我們不會看到也不會儲存。</li>
          <li><b>使用紀錄</b>：登入時間、操作事件、裝置與瀏覽器類型、錯誤記錄，用來排除問題與改善服務。</li>
          <li><b>分享頁回饋</b>：你把成品分享給朋友時，朋友留的留言與名稱。</li>
        </ul>
      </Section>

      <Section t="2. 我們用這些資料做什麼">
        <ul>
          <li>剪出你要的影片：分析素材、寫旁白、生成配音與配樂、上字幕、輸出成品與封面。</li>
          <li>提供帳號、點數與訂閱功能，寄送交易相關通知。</li>
          <li>改善服務品質、排除故障、防止濫用。</li>
          <li>法律要求時配合主管機關。</li>
        </ul>
        <p>我們<b>不會</b>把你的素材、聲音或成品拿去訓練任何模型，也不會賣給第三方或用於跟你無關的廣告。</p>
      </Section>

      <Section t="3. 幫我們處理資料的服務商">
        <p>為了完成剪輯，部分資料會傳給下列服務商處理；他們只能依我們的指示使用，不得另作他用：</p>
        <ul>
          <li><b>Anthropic（Claude）</b>：分析素材畫面、撰寫旁白與剪輯決策（美國）。</li>
          <li><b>ElevenLabs</b>：旁白配音、聲音複製、配樂與音效、語音辨識（美國）。</li>
          <li><b>Railway</b>：主機與檔案儲存（新加坡）。</li>
          <li><b>統一金流 PAYUNi</b>（統一數網股份有限公司）：信用卡、ATM、行動支付等付款處理與電子發票（台灣）。</li>
          <li><b>Google、Meta（Facebook）、LINE</b>：你選用的第三方登入。</li>
        </ul>
        <p>其中 AI 與主機服務在台灣以外，因此素材與成品會跨境傳輸；付款資料則留在台灣。我們選擇的服務商都有相應的資料保護承諾。</p>
      </Section>

      <Section t="4. 資料保存多久">
        <ul>
          <li><b>原始素材</b>（你上傳的影片、照片）：剪輯完成後保留 7 天即自動刪除。</li>
          <li><b>成品</b>：免費方案保留 7 天後自動移除；有付費空間或訂閱期間一直保留，方案結束後再保留 7 天。</li>
          <li><b>聲音樣本與模型</b>：保留到你重新錄製或刪除帳號為止。</li>
          <li><b>帳號與交易紀錄</b>：帳號存續期間保留；交易紀錄依稅務法規保留 5 年。</li>
        </ul>
      </Section>

      <Section t="5. Cookie">
        <p>我們只用必要的 Cookie：維持你的登入狀態、記住你選的模式與提示是否顯示。沒有第三方追蹤或廣告 Cookie。</p>
      </Section>

      <Section t="6. 你的權利">
        <p>你可以隨時：查詢或下載你的資料、更正資料、刪除成品或整個帳號、停止使用自己的聲音。成品頁可以直接刪除影片；其他請求請來信 <a href={`mailto:${L.email}`}>{L.email}</a>，我們會在 15 個工作天內處理。</p>
        <p id="delete"><b>刪除帳號與資料：</b>來信註明你的登入 Email 並要求刪除帳號，我們會刪除你的素材、成品、聲音模型與帳號資料（依法必須保留的交易紀錄除外），並回信確認。用 Facebook 登入的用戶也可以從 Facebook 的「應用程式和網站」設定移除本服務，我們收到通知後會進行同樣的刪除。</p>
      </Section>

      <Section t="7. 聲音與肖像">
        <p>「用自己的聲音」功能只能用在你本人的聲音，或你已取得本人書面同意的聲音。你上傳的素材裡若有其他人，請確認你有權使用他們的影像。</p>
      </Section>

      <Section t="8. 兒童">
        <p>本服務對象為成年人與事業經營者。我們不會刻意蒐集未滿 13 歲兒童的資料；如果你發現有這種情況，請通知我們刪除。</p>
      </Section>

      <Section t="9. 安全">
        <p>資料傳輸全程加密（HTTPS），檔案存放在有存取控管的主機，只有為了提供服務必要的人員能接觸。沒有任何系統是絕對安全的；若發生資料外洩，我們會依法通知你。</p>
      </Section>

      <Section t="10. 政策更新">
        <p>政策若有重大變更，我們會在網站公告並更新上方的日期。繼續使用即表示你接受更新後的內容。</p>
      </Section>
    </>
  )
}

function Terms() {
  const L = LEGAL
  return (
    <>
      <h1>服務條款</h1>
      <p className="lg-lead">歡迎使用 {L.product}。註冊或使用本服務，表示你同意下列條款。請花幾分鐘讀完，特別是關於點數、退款與你上傳內容的部分。</p>

      <Section t="1. 服務內容">
        <p>本服務以 AI 剪輯師自動把你提供的影片、照片與說明，剪成有旁白、配樂、字幕與封面的短影音，並提供校對、微調與修改功能。我們會持續調整功能與呈現方式。</p>
      </Section>

      <Section t="2. 帳號">
        <ul>
          <li>一個人或一個事業一個帳號，請妥善保管登入方式；帳號下的操作視為你本人所為。</li>
          <li>新帳號贈送的點數僅供體驗，不得兌換現金或轉讓。</li>
          <li>我們可以暫停或終止違反本條款、濫用系統或長期未付款的帳號。</li>
        </ul>
      </Section>

      <Section t="3. 點數、方案與付款">
        <ul>
          <li>本服務以點數計費。每個步驟的點數在「點數與方案」頁公告；價格可能調整，調整不溯及已購買的點數。</li>
          <li><b>點數不過期、會累積</b>，不論是單次購買或包月方案附的點數。</li>
          <li><b>包月方案</b>每 30 天自動續約並入帳當期點數，可隨時取消，不綁約；取消後已有的點數保留，成品空間回到免費方案的規則。</li>
          <li>付款由統一金流 PAYUNi 處理，我們依法開立電子發票到你留的 Email 或載具。</li>
        </ul>
      </Section>

      <Section t="4. 退款">
        <ul>
          <li>點數屬於數位內容：<b>購買後 7 天內、尚未使用任何一點</b>，可以來信申請全額退款。</li>
          <li>已使用的點數不退。點數是在你按下開始、系統實際進行分析、配音、輸出等步驟時才扣除，沒做的步驟不會扣。</li>
          <li>因系統錯誤導致步驟失敗的點數會自動退回；若你發現漏退，請來信，我們會補回。</li>
          <li>AI 產出的風格或文案「不合期待」不屬於系統錯誤；請用校對與修改功能調整。</li>
        </ul>
      </Section>

      <Section t="5. 你的內容與成品">
        <ul>
          <li><b>你上傳的素材仍然是你的。</b>你授權我們為了剪輯、保存與分享（當你使用分享功能時）而處理這些檔案，範圍僅限提供本服務。</li>
          <li><b>剪出來的成品歸你所有</b>，你可以自由用於商業用途。AI 生成的配音、配樂與音效，依各服務商的授權可供你商業使用。</li>
          <li>你保證對上傳的素材擁有權利或已取得授權：包括影像中的人、音樂、商標與他人的作品。因你的素材引起的第三方主張，由你負責。</li>
          <li>「用自己的聲音」只能用於你本人的聲音，或已取得本人明確同意的聲音。冒用他人聲音、製作誤導性內容、違法或侵害他人的內容，一律禁止，帳號會被終止。</li>
        </ul>
      </Section>

      <Section t="6. AI 的限制">
        <p>旁白、字幕與剪輯由 AI 產生，可能唸錯字、理解錯誤或選到不理想的畫面。成品發布前請自行確認，尤其是價格、地名、店名與數字。我們提供校對台、試聽與「自己唸」功能協助你修正，但不保證每一支成品都一次到位。</p>
      </Section>

      <Section t="7. 檔案保存">
        <p>原始素材剪完後保留 7 天；免費方案的成品保留 7 天，付費空間或訂閱期間一直保留。到期前會提醒你，請自行下載備份。我們對到期後刪除的檔案不負保存責任。</p>
      </Section>

      <Section t="8. 服務可用性">
        <p>我們盡力維持服務穩定，但不保證不中斷。因第三方服務商（AI、配音、主機、付款）故障造成的延遲或失敗，我們會退回該步驟的點數，但不負其他賠償責任。</p>
      </Section>

      <Section t="9. 責任限制">
        <p>在法律允許的範圍內，我們對因使用本服務產生的間接損失、營業損失或資料遺失不負責任；我們對你的總賠償責任以你在爭議發生前 12 個月內支付給我們的金額為上限。</p>
      </Section>

      <Section t="10. 條款變更">
        <p>條款若有重大變更，我們會在網站公告並更新日期；繼續使用即表示同意。</p>
      </Section>

      <Section t="11. 準據法與管轄">
        <p>本條款依中華民國法律解釋；因本服務產生的爭議，雙方同意以 {L.court} 為第一審管轄法院。消費者保護法有更有利於你的規定時，從其規定。</p>
      </Section>

      <Section t="12. 聯絡我們">
        <p>{L.company} · <a href={`mailto:${L.email}`}>{L.email}</a></p>
      </Section>
    </>
  )
}
