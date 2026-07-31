# server.js — 給 Rhapsody 呼叫的常駐 HTTP 服務

把 `ring.js` 的邏輯包成一支長駐服務，讓 Rhapsody 用 **HTTP Client communication point** 定時來撈。好處是 Node 常駐、mssql 連線池保持溫熱（不用每次重連 26 張表的 DB），回應直接是 JSON。

`server.js` 只是薄薄一層 HTTP 外殼，實際查詢全部 `require('./ring.js')` 重用你既有的函式，沒有重寫任何環狀 / 時區 / 過濾邏輯。設定沿用 `databases.config.json`。

## 端點（皆為 GET，回 JSON）

| 路徑 | 說明 | 對應 ring.js 模式 |
|------|------|------------------|
| `/health` | 探活，不碰資料庫 | — |
| `/icca/head` | 目前寫入頭是哪一張表 | head |
| `/icca/order` | 26 張表由新到舊順序與各表狀態 | order |
| `/icca/latest` | 從 head 跨表撈最新 N 筆（**Rhapsody 定時撈這個**） | latest |
| `/icca/at` | 某時間點落在哪張表（加 `&fetch=1` 順便撈） | at |

共用查詢參數：`site`、`n`(=latestN)、`direction`、`param`、`patient`、`device`、`from`、`to`、`tzOffset`、`at`、`by`、`fetch`、`pretty`。

範例：

```
GET /icca/latest?n=1000
GET /icca/latest?param=4102,4103&n=500
GET /icca/latest?site=cds2&n=1000
GET /icca/head?pretty=1
GET /icca/at?at=2026-07-22%2003:00&fetch=1&param=4102
```

## 環境變數

| 變數 | 預設 | 說明 |
|------|------|------|
| `ICCA_CONFIG` | `databases.config.json` | 設定檔路徑 |
| `ICCA_HOST` | `127.0.0.1` | 監聽位址；只綁本機，別對外網開 |
| `ICCA_PORT` | `8770` | 監聽埠 |
| `ICCA_TOKEN` | 無 | 有設定時，呼叫需帶 `X-API-Key` 標頭或 `?token=` |
| `DB_PASSWORD` | — | 資料庫密碼（設定檔用 `"env:DB_PASSWORD"` 參照） |

也可以在設定檔加一個 `"server": { "token": "..." }` 區塊代替 `ICCA_TOKEN`。

## 本機先試跑

在專案資料夾：

```bat
set DB_PASSWORD=你的密碼
node server.js
```

另開一個視窗驗證：

```bat
curl http://127.0.0.1:8770/health
curl "http://127.0.0.1:8770/icca/head?pretty=1"
curl "http://127.0.0.1:8770/icca/latest?n=100"
```

（建議在 `package.json` 的 scripts 加一行 `"serve": "node server.js"`，之後 `npm run serve` 就好。）

## 註冊成 Windows 服務（nssm，推薦）

用 [nssm](https://nssm.cc/) 讓服務開機自動啟動、當掉自動重拉。以系統管理員開 CMD：

```bat
:: 安裝（把路徑換成你的實際位置）
nssm install ICCA-Server "C:\Program Files\nodejs\node.exe" "C:\Users\320279624\Documents\icca-fetcher\server.js"
nssm set ICCA-Server AppDirectory "C:\Users\320279624\Documents\icca-fetcher"

:: 用環境變數帶密碼與埠（不要把密碼寫進程式）
nssm set ICCA-Server AppEnvironmentExtra DB_PASSWORD=你的密碼 ICCA_PORT=8770 ICCA_TOKEN=你自訂的金鑰

:: 開機自動啟動 + log
nssm set ICCA-Server Start SERVICE_AUTO_START
nssm set ICCA-Server AppStdout "C:\Users\320279624\Documents\icca-fetcher\logs\server.out.log"
nssm set ICCA-Server AppStderr "C:\Users\320279624\Documents\icca-fetcher\logs\server.err.log"

nssm start ICCA-Server
```

常用維護：`nssm restart ICCA-Server`、`nssm stop ICCA-Server`、`nssm edit ICCA-Server`（改設定後記得 restart；改 `databases.config.json` 也要 restart 才會重讀）。

> 沒裝 nssm 也可以用 `pm2` + `pm2-startup`，或工作排程器設「開機時執行」。nssm 最單純。

## Rhapsody 端：定時 route 怎麼接

你的觸發是「定時排程」，route 這樣接：

1. **起點：排程觸發**。用一個定時性質的 communication point（Timer / Scheduler，Rhapsody 版本不同名稱略異）當 route 的 input，設你要的間隔（例如每 5 分鐘）。它每次觸發會丟一則空訊息進 route。

2. **中段：HTTP Client communication point**。
   - Method：`GET`
   - URL：`http://127.0.0.1:8770/icca/latest?n=1000`（要過濾就加 `&param=4102,4103`）
   - 若有設 token：加一個 request header `X-API-Key: 你的金鑰`
   - **Timeout 設得比查詢時間長**（例如 60 秒），不然大表會被 Rhapsody 這邊先斷掉
   - 回應 body（JSON 陣列）會成為往下傳的訊息

3. **後段：照你的需求處理**。JSON filter / JavaScript filter 解析，再送去 mapper、資料庫、檔案或下一個系統。

錯誤處理：服務連不到 DB 或掃描失敗時回 HTTP 4xx/5xx 加 `{ "error": "..." }`，在 HTTP Client comm point 設好「非 2xx 走 error 路徑」，把失敗導到告警或重試，不要當成正常資料往下送。

### 心跳建議

另外可以拉一條低頻 route 打 `/health`，回應不是 `{"status":"ok"}` 就告警——這樣服務掛了你會先知道，而不是等資料沒進來才發現。

## 為什麼不用 Execute / Command comm point 直接跑 node

那樣每次觸發都要冷啟動 node、重連 SQL Server、重建 26 張表的連線池，對高頻或大表很吃虧；而且傳參數、讀 stdout、判斷錯誤都比 HTTP 麻煩。除非你頻率非常低又不想多顧一個服務，否則走 HTTP 服務這條比較穩。
