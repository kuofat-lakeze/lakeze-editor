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

1. railway.com → New Project → Deploy from GitHub repo → 選 `lakeze-editor`。
2. 建兩個 service，都指向同一個 repo：
   - **backend**：Settings → Root Directory `backend`；Variables：`ANTHROPIC_API_KEY`、`ELEVENLABS_API_KEY`、`SECRET_KEY`；Volumes → 掛載 `/data`（至少 50 GB）。
   - **frontend**：Root Directory `frontend`；Variables：`API_UPSTREAM=backend.railway.internal:8000`；Settings → Networking → Generate Domain（這就是對外網址，可再綁自己的網域）。
3. backend service 名稱必須是 `backend`（private network 的主機名）。

費用：依 CPU/RAM/磁碟用量計，長度 37 秒的影片一支約跑 5–10 分鐘 CPU。

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

## 費用與限制

- Claude：每回合依 token 計費，用量記在 `usage` 表；`USER_BUDGET_USD` 可設每位用戶上限。
- ElevenLabs：TTS 以字元計、配樂與音效以秒計、STT 核對以秒計。Starter 方案同時只能 3 個請求（`ELEVENLABS_CONCURRENCY`）。
- 一台主機同時只跑一個專案的工具（ffmpeg 很吃 CPU）；多用戶量大時把 backend 拆到有多核的機器或加 worker。

## 第二階段：iOS

後端 API 已經是純 JSON + SSE + 檔案端點，iOS app 直接接同一組 `/api/*` 即可，不需改後端。
