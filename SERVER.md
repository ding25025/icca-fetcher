# server.js — 常駐服務

把 `ring.js`、`vitals.js`、`neuro.js` 包成一支長駐服務。好處是 Node 常駐、mssql 連線池保持溫熱（不用每次重連 DB），不必每次觸發都冷啟動一個 node 行程。

`server.js` 只是薄薄一層外殼，實際查詢全部 `require` 既有的三支工具，沒有重寫任何環狀 / 時區 / 過濾 / 病人對應的邏輯。資料來源沿用 `databases.config.json`，要寫進去的中介資料庫在 `sink.config.json`（兩個檔分開，見 [README](README.md#直接寫進中介資料庫sinkjs)）。

**目前的流程是直接寫進中介資料庫**：服務自己定時撈、自己寫，沒有中間格式、沒有人來拉。原本回 JSON 的那些端點都還在，診斷與臨時查詢照樣能用。

> 中介資料庫的表結構、欄位定義、時區約定與**下游怎麼增量讀取**，完整規格在
> [docs/interim-db-schema.html](docs/interim-db-schema.html)——那份是給讀資料的一方看的。

`sink.config.json`：

```json
{
  "enabled": true,
  "connection": { "server": "10.0.0.50", "database": "ICU_DW", "user": "sa", "password": "env:SINK_PASSWORD" },
  "schedule": { "vitalsMinutes": 5, "neuroMinutes": 5, "windowSlackMinutes": 1 }
}
```

服務啟動時會把這些印出來，不必猜：

```
ICCA 服務已啟動：http://127.0.0.1:8770
  寫入資料庫：10.0.0.50:1433/ICU_DW　表：[dbo].[CDSUnvalidatedData]、[dbo].[CISData]
  內建排程：vitals 每 5 分鐘、neuro 每 5 分鐘
2026-08-06T03:24:05.120Z [排程 vitals] [dbo].[CDSUnvalidatedData]：1780 筆寫入，重複略過 40（共 1820 筆，1.2s）
```

## 端點（皆為 GET，回 JSON）

### 寫入端點

| 路徑 | 說明 |
|------|------|
| `/icca/push/vitals` | 撈一輪生命徵象並寫進中介資料庫，回寫入統計 |
| `/icca/push/neuro` | 同上（神經評估） |

設了 `sink.schedule` 就不必接這兩個——服務自己會跑。留著是給兩種情況用的：**外部排程器**（Windows 工作排程器 `curl`、Rhapsody Timer）想自己掌握觸發時機，以及**手動補一輪**（例如某一輪失敗了，用 `?window=30` 把漏掉的時間窗撈回來）。

```
GET /icca/push/vitals            # 時間窗用排程間隔 + windowSlackMinutes
GET /icca/push/vitals?window=30  # 補撈近 30 分鐘
GET /icca/push/neuro?window=180
```

回應長這樣（`inserted` 是新寫進去的、`updated` 是被更新的，其餘就是時間窗重疊撈到的重複資料）：

```json
{ "kind": "vitals", "beds": 38, "fetched": 1820, "table": "[dbo].[CDSUnvalidatedData]",
  "total": 1820, "written": 1780, "inserted": 1780, "updated": 0,
  "skipped": 0, "truncated": 0, "ms": 1204 }
```

`sink` 沒啟用時打這兩個會回 400。

### 資料端點（回 JSON，不寫資料庫）

| 路徑 | 說明 | 等同命令列 |
|------|------|-----------|
| `/icca/vitals` | 生命徵象，一床一筆：`{ bed, lifetimeNumber, records: [...] }` | `node vitals.js --no-db` |
| `/icca/neuro` | 神經評估，一位病人一筆：`{ lifetimeNumber, bed, records: [...] }` | `node neuro.js --no-db` |

`/icca/vitals` 的查詢參數（就是 vitals.js 的選項）：

| 參數 | 預設 | 說明 |
|------|------|------|
| `window`（或 `w`） | 設定檔的 `windowMinutes`（5） | 撈最近幾分鐘 |
| `site` | 全部 | 只跑指定站台，逗號分隔 |
| `param` | 設定檔的清單 | 直接指定 parameterId，逗號分隔 |
| `discover=1` | 否 | 先連 primary 查出 parameterId 清單 |
| `utc=1` | 否 | 時間保留 UTC（預設已 +8） |
| `noPatients=1` | 否 | 不查病歷號 |
| `keepUnmatched=1` | 否 | 連沒對到病人的床也輸出 |
| `allRows=1` | 否 | 不降頻，每筆都撈 |
| `noAperiodic=1` | 否 | 不撈 NBP 這類間歇量測 |
| `patientsDb` | 讀 SQL 裡的 `USE` | 病人資料在哪個資料庫（排錯用） |
| `withSummary=1` | 否 | 包成 `{ summary, rows }`，帶各站狀態 |

`/icca/neuro`：`window`（不給就用 `neuro.js` 的預設 6 分鐘）、`utc`、`withSummary`、`primaryDb`。

### 診斷端點（給人用，Rhapsody 用不到）

| 路徑 | 說明 | 對應 ring.js 模式 |
|------|------|------------------|
| `/health` | 探活，不碰資料庫；`lastWrite` 帶各資料**最後一次成功寫入**的時間與建議補撈的窗 | — |
| `/icca/head` | 目前寫入頭是哪一張表 | head |
| `/icca/order` | 26 張表由新到舊順序與各表狀態 | order |
| `/icca/latest` | 從 head 跨表撈最新 N 筆的原始列 | latest |
| `/icca/at` | 某時間點落在哪張表（加 `&fetch=1` 順便撈） | at |

這幾個的查詢參數：`site`、`n`(=latestN)、`direction`、`param`、`patient`、`device`、`from`、`to`、`tzOffset`、`at`、`by`、`fetch`、`pretty`。

範例：

```
GET /icca/vitals
GET /icca/vitals?window=15&site=cds1,cds2
GET /icca/vitals?withSummary=1&pretty=1
GET /icca/neuro?window=60
GET /icca/head?pretty=1
GET /icca/at?at=2026-07-22%2003:00&fetch=1&param=4102
```

## 失敗怎麼表達

- **全部**站台 / charting 分片都失敗 → **502**，body 是 `{ "error": "全部 7 個來源都失敗（cds1：…）" }`。這一段刻意不回空陣列：`[]` 配 200 會讓下游把故障當成「這次沒有資料」，等有人發現已經斷很久了。同樣的道理，**這一輪不會寫進中介資料庫**——0 筆寫進去跟「這段時間真的沒資料」長得一模一樣。
- **部分**失敗 → 照樣 **200**，剩下的資料照送（跟命令列的行為一致），服務 log 會寫一行警告；要逐站狀態就加 `&withSummary=1`。
- 寫入本身失敗（中介資料庫連不上、權限不足、表被鎖住）→ **500**，整批 rollback，不會留半批資料。排程模式下會在 log 寫一行 `[排程 vitals] ✗ …`，服務照常活著、下一輪再試。
- 設定錯誤、SQL 檔不見、primary 全滅 → 4xx / 5xx 加 `{ "error": "..." }`。

同一個端點被重複觸發時，第二個請求會**排隊**等第一個跑完，不會兩輪同時打 DB。內建排程則是**直接跳過**：上一輪還沒結束就不排隊，log 寫一行警告——排隊只會越積越多，而且下一輪的時間窗本來就蓋得到漏掉的那一段。

## 補資料

服務端每一輪都是撈「最近 N 分鐘」，某一輪掛掉不會自己補回來。因為寫入時已經在表裡的資料不會再寫一次（生命徵象比對唯一鍵、神經評估比對內容雜湊），**補的方法就是把窗開大再打一次**，重複的部分會被吃掉。

### 先看「上次成功是幾點」

每一輪成功寫入後，時間會記在 `.sink-state.json`（工作目錄下，路徑可用 `ICCA_STATE` 換；見 `state.js`）。這是為了回答補資料時唯一重要的問題：**該從幾點開始撈**。發現問題時先打 `/health`：

```bat
curl "http://127.0.0.1:8770/health?pretty=1"
```

```json
"lastWrite": {
  "vitals": {
    "lastSuccessAt": "2026-08-18 09:12:03",
    "ageMinutes": 143,
    "suggestWindowMinutes": 144,
    "maxBackfillHours": 24,
    "gapBeyondBackfill": false,
    "lastError": null
  }
}
```

- `lastSuccessAt` 是**那一輪開始撈的時間**，不是寫完的時間——從這個點往後補才不會漏掉「撈完到寫完」之間進來的資料。
- `suggestWindowMinutes` 直接就是要下的 `window`（已含餘裕）。
- 失敗不會讓 `lastSuccessAt` 前進，缺口才看得出來；最後一次的錯誤訊息記在 `lastError`。
- 服務啟動時也會把這兩行印進 log，重啟後不必特地去查就知道停了多久。
- **部分**站台失敗的那一輪仍算成功（資料有進去，水位線照樣前進）。那一站自己的缺口不在這裡看——看服務 log 的警告，或 `&withSummary=1` 的逐站狀態。

檔案是純紀錄，**排程行為完全不受影響**——開多大的窗還是人決定。刪掉它只會失去這個起點，不影響撈取。

### 再把窗開大打一次

```bat
curl "http://127.0.0.1:8770/icca/push/vitals?window=144"
curl "http://127.0.0.1:8770/icca/push/neuro?window=1440"
```

**最多補 24 小時。** 生命徵象的來源是環狀表，26 張、一張約一小時，再往前就被覆蓋了（`/icca/order` 可以看目前實際涵蓋到哪）；神經評估在 charting 資料庫裡雖然沒有被覆蓋的問題，也照同一個上限走，一次開太大的窗會壓到正式機。缺口超過 24 小時時 `gapBeyondBackfill` 會是 `true`，`suggestWindowMinutes` 封在 1440——超出的那一段補不回來，只能記錄下來。

上限要調就設環境變數 `ICCA_MAX_BACKFILL_HOURS`。

## 環境變數

| 變數 | 預設 | 說明 |
|------|------|------|
| `ICCA_CONFIG` | `databases.config.json` | 資料來源的設定檔路徑 |
| `SINK_CONFIG` | `sink.config.json` | 中介資料庫的設定檔路徑 |
| `ICCA_HOST` | `127.0.0.1` | 監聽位址；只綁本機，別對外網開 |
| `ICCA_PORT` | `8770` | 監聽埠 |
| `ICCA_TOKEN` | 無 | 有設定時，呼叫需帶 `X-API-Key` 標頭或 `?token=` |
| `ICCA_STATE` | `.sink-state.json` | 執行狀態檔路徑（最後一次成功寫入的時間） |
| `ICCA_MAX_BACKFILL_HOURS` | `24` | 補資料的上限，只影響 `/health` 給的建議值 |
| `DB_PASSWORD` | — | 來源資料庫密碼（設定檔用 `"env:DB_PASSWORD"` 參照） |
| `SINK_PASSWORD` | — | 中介資料庫密碼（同上，變數名就是你在 `sink.config.json` 的 `connection.password` 寫的那個） |

也可以在設定檔加一個 `"server": { "token": "..." }` 區塊代替 `ICCA_TOKEN`。

## 上線前測試清單

在**院內主機**上照順序跑（開發機解不到那些主機名，第 1 步以後都會連不上）。
每一步都寫了「該看到什麼」，不對就停在那一步，不要往下走。

### 0. 前置

專案資料夾要帶齊 `databases.config.json` 與 `sink.config.json`——**這兩個都不在版控裡**，
要另外拷過去。主機沒有網路裝套件的話，`node_modules` 也一起拷。

```bat
node -v                            :: 要有 Node（開發機驗過 v22）
```

### 1. 不連線的檢查（10 秒，先擋掉設定錯誤）

```bat
node vitals.js --dry-run
node neuro.js --dry-run
node sink.js --ddl
```

**該看到**：站台清單與 parameterId 數量、`寫入資料庫：10.0.0.50:1433/ICU_DW`、
`設定：…\sink.config.json`。寫入目標印成別台或印出 `(未設定)` 就是設定檔沒讀到。

### 2. 中介資料庫連得到、表建得起來

```bat
node sink.js --check       :: 第一次跑會說兩張表「不存在」，正常
node sink.js --init
node sink.js --check       :: 現在應該是 0 筆
```

**不對時**：`ENOTFOUND` ＝ 主機名解不到（改用 IP 或 FQDN）；`Login failed` ＝ 帳密或權限；
建表失敗多半是那個帳號沒有 `CREATE TABLE` 權限——請 DBA 拿 [sql/sink-schema.sql](sql/sink-schema.sql)
先建好，再把 `sink.config.json` 的 `ensureTables` 設 `false`。

> ⚠ **表已經用舊版 `sink-schema.sql` 建過的話**（欄位是 `measurementTime`、`isDelete`），
> `--init` **不會**去改它，之後寫入會報 invalid column name。先確認：
>
> ```sql
> SELECT c.name, t.name AS type FROM sys.columns c
> JOIN sys.types t ON t.user_type_id = c.user_type_id
> WHERE c.object_id = OBJECT_ID('dbo.CDSUnvalidatedData');
> ```
>
> 要看到 `chartTime`、`textValue`，**不該**看到 `measurementTime`、`isDelete`、`changedAt`。是舊的就二選一：
>
> - **沒有要留的資料** → `DROP TABLE dbo.CDSUnvalidatedData;` 再 `node sink.js --init`，最乾淨
> - **要留著現有資料** → 跑 [sql/sink-migrate.sql](sql/sink-migrate.sql)（就地改結構、資料不動，可重複執行）
>
> ```bat
> sqlcmd -S <中介庫主機> -d <資料庫> -U <帳號> -P <密碼> -I -i sql\sink-migrate.sql
> ```
>
> `-I`（QUOTED_IDENTIFIER ON）不能省，`CISData` 有 PERSISTED 計算欄位，少了它會失敗。
> 腳本最後會把兩張表的欄位與索引印出來對照。

### 3. 先看資料，不寫（驗來源端）

```bat
node vitals.js --no-db -p -o test-vitals.json
```

**該看到**：每站一行 `head=UnvalidatedDevicePeriodicData_xx`、`近 6 分鐘需查 N 張表`、
`病人對應：xx 床接上病歷號`，最後 `合併總筆數：約 1800 筆`。

打開 `test-vitals.json` 抽一床看：`records[]` 裡要有 `terseLabel` / `propName` /
`chartTime` / `storeTime`，血壓會是 `systolic`、`diastolic`、`mean` 三筆，
`chartTime` 要是**台灣時間**（跟牆上時鐘差不多，不是差 8 小時）。

**這一步專門要盯的**：`Invalid column name 'textValue'`。非週期表（NBP 那張）若沒有這一欄就會在這裡爆——
真的爆了就先加 `--no-aperiodic` 確認其餘正常，並回報，把那一欄從非週期查詢拿掉。

病歷號整排 `null` → `node vitals.js --check-patients`，它會指出是連錯資料庫、沒有在床病人、
還是兩邊床號寫法不一樣。

### 4. 真的寫一輪

```bat
node vitals.js
```

**該看到**：`已寫入 [dbo].[CDSUnvalidatedData]：1780 筆寫入（共 1800 筆，1.2s）`。
`⚠ 缺鑰匙欄位或病歷號略過 N` 少量正常（那一輪剛好對不到病人）；N 很大代表病人對應有問題，回到第 3 步。

### 5. 再跑一次——**這步是整份清單裡最關鍵的**

```bat
node vitals.js
```

時間窗有重疊，所以第二次**應該幾乎全是重複**：`written` 掉到只剩這一分鐘的新資料、
`重複略過` 是個大數字。兩次寫進一樣多筆＝鑰匙沒對上，去查 `PK_CDSUnvalidatedData` 在不在。

順便確認狀態檔出來了：工作目錄下該多一個 `.sink-state.json`，`vitals.startedAt`
就是剛剛那一輪開始撈的時間。之後發現問題要補資料，起點看它（見上面的[補資料](#補資料)）。

### 6. 直接查表驗結構與下游查詢

```sql
SELECT TOP 20 * FROM dbo.CDSUnvalidatedData ORDER BY storeTime DESC;

-- 唯一鍵真的唯一？應該回 0 列
SELECT lifetimeNumber, terseLabel, propName, chartTime, COUNT(*) AS n
FROM   dbo.CDSUnvalidatedData
GROUP  BY lifetimeNumber, terseLabel, propName, chartTime HAVING COUNT(*) > 1;

-- 時間基準：三個都該接近「現在的台灣時間」，彼此差幾秒到幾分鐘，不是差 8 小時
SELECT MAX(chartTime) AS 臨床, MAX(storeTime) AS 來源寫入,
       MAX(insertedAt) AS 進中介庫, SYSDATETIME() AS 現在
FROM   dbo.CDSUnvalidatedData;

-- 下游會用的增量查詢（規格 §4）
SELECT lifetimeNumber, terseLabel, propName, numericValue, textValue, chartTime, storeTime
FROM   dbo.CDSUnvalidatedData WITH (NOLOCK)
WHERE  storeTime > DATEADD(MINUTE, -10, SYSDATETIME())
ORDER  BY storeTime, lifetimeNumber, terseLabel, propName, chartTime;

-- 拋轉有沒有斷（規格 §5）：超過 15 就是異常
SELECT DATEDIFF(MINUTE, MAX(insertedAt), SYSDATETIME()) FROM dbo.CDSUnvalidatedData;
```

### 7. neuro

```bat
node neuro.js --no-db -p        :: 先只看資料
node neuro.js                   :: 寫一輪
node neuro.js                   :: 再一輪，written 應該掉到接近 0
```

**該看到**：`interventionId N 個，在床病人 N 人，分布在 N 個 charting 資料庫`，各分片一行 ✓。

`CISData` 是**多版本**的表（規格 §3），驗收方式跟生命徵象不一樣——同一組識別鍵**可以**有多列：

```sql
-- 有多個版本的紀錄（正常，代表護理師改過或那筆被作廢）
SELECT lifetimeNumber, interventionId, chartTime, COUNT(*) AS 版本數
FROM   dbo.CISData
GROUP  BY lifetimeNumber, interventionId, chartTime HAVING COUNT(*) > 1;

-- 但完全一樣的內容不該出現兩次，這個要回 0 列
SELECT rowHash, COUNT(*) AS n FROM dbo.CISData GROUP BY rowHash HAVING COUNT(*) > 1;
```

上面那組有多列、下面那組是 0，就代表版本歷史與去重都對。

### 8. 常駐服務

```bat
node server.js
```

**該看到**（前景跑，先不要註冊服務）：

```
ICCA 服務已啟動：http://127.0.0.1:8770
  設定檔：…\databases.config.json（資料來源）
        …\sink.config.json（中介資料庫）
  存取控制：未設 token（僅綁 127.0.0.1）
  寫入資料庫：10.0.0.50:1433/ICU_DW　表：[dbo].[CDSUnvalidatedData]、[dbo].[CISData]
  內建排程：vitals 每 5 分鐘、neuro 每 5 分鐘
```

另開一個視窗：

```bat
curl http://127.0.0.1:8770/health
curl "http://127.0.0.1:8770/icca/push/vitals?pretty=1"
node sink.js --check
```

然後**放著跑 15 分鐘**，看它每 5 分鐘自己出一行排程紀錄、`--check` 的筆數在長。

### 9. 註冊成服務、重開機驗證

下一節的 `nssm`。裝完 `nssm start`，然後**重開機一次**確認會自動起來、log 有繼續寫。

### 隨時可以退回

`sink.config.json` 把 `enabled` 改成 `false`（或單次加 `--no-db`）就完全不碰中介資料庫；
服務用 `nssm stop ICCA-Server` 停掉。已經寫進去的列不會被動到，重跑也不會重複。

（建議在 `package.json` 的 scripts 加一行 `"serve": "node server.js"`，之後 `npm run serve` 就好。）

## 註冊成 Windows 服務（nssm，推薦）

用 [nssm](https://nssm.cc/) 讓服務開機自動啟動、當掉自動重拉。以系統管理員開 CMD：

```bat
:: 安裝（把路徑換成你的實際位置）
nssm install ICCA-Server "C:\Program Files\nodejs\node.exe" "C:\Users\320279624\Documents\icca-fetcher\server.js"
nssm set ICCA-Server AppDirectory "C:\Users\320279624\Documents\icca-fetcher"

:: 用環境變數帶密碼與埠（不要把密碼寫進程式）
nssm set ICCA-Server AppEnvironmentExtra DB_PASSWORD=你的密碼 SINK_PASSWORD=目標庫密碼 ICCA_PORT=8770 ICCA_TOKEN=你自訂的金鑰

:: 開機自動啟動 + log
nssm set ICCA-Server Start SERVICE_AUTO_START
nssm set ICCA-Server AppStdout "C:\Users\320279624\Documents\icca-fetcher\logs\server.out.log"
nssm set ICCA-Server AppStderr "C:\Users\320279624\Documents\icca-fetcher\logs\server.err.log"

nssm start ICCA-Server
```

常用維護：`nssm restart ICCA-Server`、`nssm stop ICCA-Server`、`nssm edit ICCA-Server`（改設定後記得 restart；改 `databases.config.json`、`sink.config.json` 也要 restart 才會重讀）。

> 沒裝 nssm 也可以用 `pm2` + `pm2-startup`，或工作排程器設「開機時執行」。nssm 最單純。

## 觸發：三種選一種

生命徵象與神經評估**都是每 5 分鐘一輪、有新資料才寫**，但仍是**各自獨立**的兩條（來源與管線完全不同，一邊斷了不該拖著另一邊），不要塞在一起。

| 做法 | 怎麼設 | 什麼時候選它 |
|------|--------|-------------|
| **服務內建排程**（推薦） | `sink.schedule` 寫上兩個間隔，其它什麼都不必接 | 預設就選這個。少一個元件、少一層可能斷的地方 |
| **外部排程器打 push** | Windows 工作排程器每 5 分鐘 `curl http://127.0.0.1:8770/icca/push/vitals` | 你想在既有的排程系統裡一起看到它、一起管 |
| **命令列直接跑** | 工作排程器跑 `node vitals.js` | 不想多顧一個常駐服務。代價是每次冷啟動、重連 DB |

內建排程的時間窗會自動用「間隔 + `windowSlackMinutes`」（預設多 1 分鐘）。**窗開得比間隔大是刻意的**：漏掉的資料下一輪不會自己補回來，重複的則會在寫入時被擋掉——兩種風險不對等，所以往重疊的那邊倒。

外部排程器要自己帶窗，理由一樣，寧可多一點：

```bat
curl "http://127.0.0.1:8770/icca/push/vitals?window=6"
curl "http://127.0.0.1:8770/icca/push/neuro?window=6"
```

有設 token 的話加 `-H "X-API-Key: 你的金鑰"`，並且把 curl 的 timeout 設得比查詢時間長（例如 60 秒）。

### 心跳建議

拉一條低頻的監控打 `/health`，回應不是 `{"status":"ok"}` 就告警——這樣服務掛了你會先知道，而不是等資料沒進來才發現。

再往前一步，直接盯資料本身更準（服務活著但一直寫失敗，`/health` 是看不出來的）：

```sql
SELECT DATEDIFF(MINUTE, MAX(insertedAt), SYSDATETIME()) AS 幾分鐘沒進資料
FROM dbo.CDSUnvalidatedData;
```

超過排程間隔的兩三倍就該看 log。`node sink.js --check` 也印得出同樣的資訊。

## 為什麼不用工作排程器直接跑 node 就好

也可以，只是每次觸發都要冷啟動 node、重連 SQL Server、重建 26 張表的連線池——5 分鐘一輪的話這些成本佔比不小。常駐服務把連線池留著，時間到就直接查；而且失敗看 log 就好，不必去翻每一次執行的 stdout。頻率很低（例如一小時一次）又不想多顧一個服務的話，`node vitals.js` 排在工作排程器裡是完全合理的選擇。
