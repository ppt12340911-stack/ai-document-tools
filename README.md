# AI 文件工具平台

提供環境工程與一般文件工作的輔助工具：AI 校稿、Word/PDF 處理、手寫稿辨識、OCR、GIS 等濃度分析、污染風花圖、相片篩選及污染來源追蹤。

## 建議的上線方式

本專案包含 Python FastAPI 後端，因此「完整可操作網站」不能只靠 GitHub Pages。建議將本資料夾作為 GitHub 儲存庫，使用 Render 或其他支援 Python/Docker 的服務執行後端；專案已附上 `Dockerfile` 與 `render.yaml`，可直接由 GitHub 儲存庫建立 Web Service。

完整網站的入口就是後端服務網址，前端與 API 會由同一個網址提供，無須額外設定跨網域連線。

## GitHub Pages（選用）

專案附有 `.github/workflows/deploy-pages.yml`，可將 `frontend/` 發布成 GitHub Pages 靜態前端。這個版本只能提供畫面與操作入口；若要讓工具真正分析檔案，必須：

1. 先將後端部署到 Render 等服務，取得 HTTPS 網址。
2. 編輯 `frontend/site-config.js` 的 `configuredBase`，填入後端網址。
3. 將後端環境變數 `FRONTEND_ORIGIN` 設為 GitHub Pages 的來源網址。

不要將 API Key、密碼或其他機密資料寫入 `site-config.js`。

## 本次線上化調整

- 已移除 Word/PDF、OCR、逐字稿及校稿頁面的歷史紀錄區與歷史 API。
- 不再保存 SQLite 歷史資料庫；風花圖專案只保留於目前服務程序記憶體中。
- GitHub 版本不包含上傳檔、測試資料、log、快取或既有資料庫。
- Docker 雲端環境使用 LibreOffice 處理 Word 轉 PDF，避免依賴 Windows Microsoft Word。
- EasyOCR 改為選配；雲端相依套件預設使用 RapidOCR，Windows 本機版仍可安裝 EasyOCR。
- `啟動系統.py` 僅供 Windows 本機使用，不是雲端啟動入口。

## 本機使用

```powershell
python -m venv .venv
.\\.venv\\Scripts\\Activate.ps1
pip install -r backend\\requirements.txt
python 啟動系統.py
```

本機服務通常會開在 `http://127.0.0.1:1700`。若需要使用 Word 專業校訂或原生格式轉換，請在 Windows 安裝 Microsoft Word。

## GitHub 不應保存的資料

以下資料已由 `.gitignore` 排除：

- `backend/uploads/`
- `*.db`、`*.sqlite`、`*.log`
- `__pycache__/`
- `.env`、金鑰、憑證及私鑰
- 測試照片、內部文件與其他個資資料

## 資料與安全提醒

- 使用者輸入的 Gemini API Key 只應透過 HTTPS 傳送，請勿寫入程式碼或提交至 GitHub。
- 上傳檔案只作為目前工作使用；正式多人服務仍應另行規劃容量限制、權限、刪除週期及個資保存政策。
- GitHub Pages 的工作流程只負責靜態檔案發布，不會執行 Python、Microsoft Word 或本機指令。
