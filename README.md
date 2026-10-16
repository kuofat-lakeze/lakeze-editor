# Lakeze Editor

給素材連結（或上傳影片）＋賣點 prompt，AI 剪輯師用對話的方式做出有旁白、配樂、雙層字幕的直式短影音與封面。

## 架構

```
frontend/   React (Vite) 聊天介面：專案、對話串流、影片／音訊／圖片卡片、上傳
backend/    FastAPI
  app/agent/      Claude 對話迴圈（tool use、串流、持久化、用量記錄）與系統提示（剪輯方法論）
  app/pipeline/   可重用的剪輯工具：Drive 下載、素材分析縮圖、剪輯、雙層 ASS 字幕、
                  ElevenLabs TTS（自動語音辨識核對）／配樂／音效、ducking 混音、輸出、封面
  app/main.py     auth、projects、upload、SSE chat、assets
deploy/     伺服器一鍵安裝與更新腳本；.github/workflows 推 main 自動部署
```

Agent 看得到素材縮圖與分鏡圖（工具回傳圖片），決定剪輯、寫旁白、讓用戶選聲音與配樂，然後輸出。每一句旁白生成後都會用 STT 轉回文字核對，唸錯會自動重錄。

## 本機開發

```bash
cd backend && pip install -r requirements.txt
export DATA_DIR=./data ANTHROPIC_API_KEY=... ELEVENLABS_API_KEY=... SECRET_KEY=dev
uvicorn app.main:app --reload            # http://127.0.0.1:8000
cd ../frontend && npm install && npm run dev   # http://localhost:5173（/api 代理到 8000）
```
需要系統有 `ffmpeg`。測試：`cd backend && pytest`。

## 上線 A：Railway（連 GitHub 就上線，最省事）

Railway 沒有 Claude 連接器，但它自己有 GitHub 整合：連上 repo 後每次推 main 自動建置部署，並提供 HTTPS 網址。

**方案：Pro（$20/月，含 $20 用量額度）。** Hobby 的磁碟上限 5 GB，裝不下一個專案的素材；Pro 磁碟 50 GB 起、可加到 1 TB、按實際用量計。

1. railway.com → 升級 workspace 到 Pro → New Project → Deploy from GitHub repo → 選 `lakeze-editor`。
2. 第一個 service 改名 **`backend`**（名稱就是內網主機名）：
   - Settings → Source → Root Directory：`backend`
   - Variables：`ANTHROPIC_API_KEY`、`ELEVENLABS_API_KEY`、`SECRET_KEY`（`openssl rand -hex 32`）、`ADMIN_EMAILS`（你的 email）、**`PORT=8000`**；若 Anthropic key 是組織層級的使用者金鑰（`sk-ant-usr-…`），再加 `ANTHROPIC_WORKSPACE_ID`（Console → Workspaces 的 `wrkspc_…` id），否則 API 會回「not scoped to a workspace」
   - Settings → Volumes → Add Volume → Mount path `/data`
   - Settings → Networking → 不要產生公開網域（只走內網）
3. 再 New → GitHub Repo 加第二個 service，改名 **`frontend`**：
   - Root Directory：`frontend`
   - Variables：`API_UPSTREAM=backend.railway.internal:8000`
   - Settings → Networking → Generate Domain → 這就是網址；要綁自己的網域就在同一頁 Custom Domain 加 CNAME（正式網址 `editor.lakeze.com` → CNAME 指到 Railway 給的 `*.up.railway.app` 主機名，DNS 先不要開 Cloudflare 代理，等憑證簽好再開）。
4. 兩個 service 都 Deploy。打開網址 → 註冊（用 `ADMIN_EMAILS` 裡的 email）→ 側欄會有管理後台。
5. 之後推 main 自動重新部署。成本看 Railway 的 Usage 頁；app 內的成本看管理後台。

上傳限制：每支影片 1 GB 內（`MAX_UPLOAD_MB`），一次最多選 6 支；大量素材請走 Drive 連結。磁碟控制：`RAW_RETENTION_DAYS`（預設 7）天沒動的專案會自動刪掉原始素材與中間檔，只留成品、封面與對話；用量大時再把成品搬到 Storage Buckets。

**全自動版**：有 Railway workspace token 時，上面 1–4 步可以一行跑完（只需要 `curl`、`jq`、`openssl`，直接打 Railway GraphQL，不需要 CLI 登入）：
```bash
RAILWAY_TOKEN=... ANTHROPIC_API_KEY=... ELEVENLABS_API_KEY=... ADMIN_EMAILS=you@example.com ./deploy/railway_setup.sh
```
腳本會建專案、兩個 service（從 GitHub repo、各自的 Root Directory、健康檢查）、變數、`/data` 磁碟、公開網址並觸發部署，最後印出網址；可重複執行（已存在的部分會略過）。注意：Railway 已棄用 `railway.json`，部署設定都由腳本直接設定；Dockerfile 不能有 `VOLUME` 指令；frontend 的 nginx 用 `RESOLVER=[fd12::10]` 在執行期解析 `backend.railway.internal`。

## 上線 B：自己的 Linux 主機 + 網域（成本固定、磁碟便宜）

需求：Ubuntu 22.04+，2 vCPU / 4 GB RAM 以上，磁碟 ≥ 80 GB（素材一個專案 2–5 GB），開 80/443。網域的 A 記錄指到主機 IP。

```bash
# 1. 主機上（root）
curl -fsSL https://raw.githubusercontent.com/kuofat-lakeze/lakeze-editor/main/deploy/server-setup.sh | bash
# 2. 填金鑰與網域
nano /opt/lakeze-editor/.env      # ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, DOMAIN
# 3. 啟動（Caddy 會自動申請 HTTPS 憑證）
cd /opt/lakeze-editor && ./deploy/up.sh
```
之後更新：`./deploy/up.sh`。映像來自 AWS 公開鏡像（`public.ecr.aws/docker/library/*`），不受 Docker Hub 匿名拉取限制。或在 GitHub repo 設定 secrets `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_KEY` 與 variable `DEPLOY_ENABLED=true`，推到 main 就自動部署。

資料（SQLite、專案素材與成品）在 Docker volume `data`；備份用 `docker run --rm -v lakeze-editor_data:/data -v $PWD:/b alpine tar czf /b/data.tgz /data`。要換 Postgres 設 `DATABASE_URL=postgresql+asyncpg://...`。

## 點數與收費

1 點 = NT$10。每個工具呼叫按 `backend/app/pricing.py` 的價目扣點（素材分析 6、腳本+剪輯 9、旁白 6、試聽 1/聲音、配樂 3、混音 3、字幕 2、輸出 3、封面 4）。第一版完整影片約 39 點，修改一輪約 8 點。

- **免費體驗**：每個帳號的第一個專案，第一版 + 封面 + 4 輪修改免費；第 5 輪起照價目扣點，餘額不足時剪輯師會請用戶儲值，儲值後說「繼續」就接著做。「一輪修改」= 第一版輸出後、真的有動到工具（會扣點的動作）的一個回合；只是問答、確認的回合不算。
- **儲值包**：NT$500→50、1,000→110、3,000→360、10,000→1,300 點。線上付款接 Lemon Squeezy（`CHECKOUT_URLS`、`LS_VARIANTS`、`LEMONSQUEEZY_WEBHOOK_SECRET`）；沒設定時用戶看到 `TOPUP_NOTE`，管理員在後台手動加點。
- 價目可用 `PRICING_JSON` 覆寫，不用改程式。
- 新專案的起始畫面會先讓用戶選旁白聲音（或「不要配音」）；預設清單用 `VOICE_PRESETS_JSON` 設定（`[{"voice_id","name","gender","description"}]`），其後自動補上 Voice Library 裡的台灣腔聲音，各附試聽。

## 管理後台

`ADMIN_EMAILS` 裡的帳號登入後，側欄會出現「管理後台」：
- 總覽：用戶數、影片輸出數、營收、售出／已用／免費送出的點數、Claude 與 ElevenLabs 成本、毛利率
- 用戶列表：餘額、已付金額、API 成本、影片數；點開看專案、點數紀錄、對話內容
- 操作：手動加點（可記錄實收金額）、停用／啟用、設管理員、再送一次免費專案、備註

## 費用與限制

- Claude：每回合依 token 計費，用量記在 `usage` 表；`USER_BUDGET_USD` 可設每位用戶上限。
- ElevenLabs：TTS 以字元計、配樂與音效以秒計、STT 核對以秒計。Starter 方案同時只能 3 個請求（`ELEVENLABS_CONCURRENCY`）。
- 一台主機同時只跑一個專案的工具（ffmpeg 很吃 CPU）；多用戶量大時把 backend 拆到有多核的機器或加 worker。

## 第二階段：iOS

後端 API 已經是純 JSON + SSE + 檔案端點，iOS app 直接接同一組 `/api/*` 即可，不需改後端。
