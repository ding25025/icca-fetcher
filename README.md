# 生命徵象抓取工具（vitals.js）

**多站台 + 環狀表定位**，是 `index.js` 與 `ring.js` 的組合應用，也是實務上主要要用的那支。

環境裡有兩種資料庫：

| | 資料庫 | 用途 |
|---|---|---|
| `primary` | `ICCA_DB01` | 臨床設定。可查出「生命徵象」對應哪些 `cdsParameterId` |
| `cds` | `CDSUnvalidatedDataDB` | 儀器資料。26 張環狀表輪流寫 |

## 設定只有一份

`vitals.js` **直接讀 `databases.config.json`**，沒有第二個設定檔——IP 與帳密不必抄兩份。
站台是從 `databases[]` 自動認出來的：

- 資料庫名稱符合 `^CDSUnvalidatedData` → **CDS**，要撈資料的站台
- 其餘 → **primary**，只有 `--discover` 會用到

執行時會把認出來的結果印出來：

```
從 databases.config.json 認出 7 個 CDS：cds1, cds2, cds3, cds4, cds5, cds6, cds7　primary：db1
```

其它設定（`windowMinutes`、`ring`、`parameterIdsFile`…）都有內建預設值。要調整就在
`databases.config.json` 加一個 `vitals` 區塊，只寫要改的項目——`index.js` 不看這個 key，
不受影響：

```json
{
  "databases": [ ... ],
  "vitals": {
    "windowMinutes": 15,
    "parameterIdsFile": "sql/parameter-ids.txt",
    "ring": { "count": 26, "headColumn": "storeTime" }
  }
}
```

判斷規則不合用時，可改 `vitals.cdsDatabasePattern`，或直接自己寫 `sites[]`（有寫就不做推測）。

## 為什麼不直接查那個 view

`Vitalsign.sql` 查的 `dbo.UnvalidatedDevicePeriodicData` 是 26 張環狀表的 **UNION view**。
就算只要近 5 分鐘的資料，它也得掃過全部 26 張表。

`vitals.js` 改成先用 `MAX(storeTime)` 找出目前的寫入頭，**只查那一張**——26 次聚合查詢
（每張表一個 `MAX`，走索引）換掉一次 26 張表的全域掃描。跨小時交界時會自動多帶前一張，
所以 11:02 撈近 5 分鐘不會漏掉 10:57~11:00 那幾筆。

## 執行

```bash
node vitals.js --pretty          # 七台 CDS 平行，近 5 分鐘
node vitals.js -w 15             # 改抓近 15 分鐘
node vitals.js --site cds1,cds2  # 只跑指定站台
node vitals.js --local           # 時間附上台灣時區欄位
node vitals.js --discover        # parameterId 改由 primary 動態查
```

```
從 databases.config.json 認出 7 個 CDS：cds1, ..., cds7　primary：db1
開始平行查詢 7 個站台...
  [cds1] parameterId：48 個（來源：sql/parameter-ids.txt）
  [cds1] head=UnvalidatedDevicePeriodicData_19（2026-07-22 03:24:00 UTC），近 5 分鐘需查 1 張表：..._19
  [cds2] head=UnvalidatedDevicePeriodicData_07（2026-07-22 03:24:00 UTC），近 5 分鐘需查 2 張表：..._07, ..._06
  ✓ cds1：284 筆（UnvalidatedDevicePeriodicData_19）
  ✓ cds2：196 筆（UnvalidatedDevicePeriodicData_07）
  ...
----------------------------------------
合併總筆數：1820
```

密碼跟著 `databases.config.json` 走。想改用環境變數就把該欄位寫成 `"env:ICCA_PASSWORD"`，
`index.js` 與 `vitals.js` 都支援。

## 輸出

單一 JSON 陣列（與 `index.js` 一致）。`terseLabel` / `propName` 從 parameterId 清單帶進來，
跟儀器自己的 `label` 並存：

```json
[
  {
    "_site": "cds1",
    "terseLabel": "ABP",
    "propName": "systolic",
    "_sourceTable": "UnvalidatedDevicePeriodicData_03",
    "bed": "ICU-01",
    "deviceInstanceId": 11,
    "parameterId": 150037,
    "label": "ABPs",
    "numericValue": 118,
    "textValue": null,
    "units": "mmHg",
    "measurementTime": "2026-07-22T03:24:00.000Z",
    "storeTime": "2026-07-22T03:24:05.000Z",
    "patientIdentifier": "A12345",
    "measurementTimeLocal": "2026-07-22 11:24:00",
    "storeTimeLocal": "2026-07-22 11:24:05"
  }
]
```

| 欄位 | 來源 |
|---|---|
| `terseLabel` / `propName` | parameterId 清單。`ABP` + `systolic` 才分得出是收縮壓 |
| `label` | 儀器自己回報的名稱（`ABPs`），跟 `terseLabel` 不一定一樣 |
| `_site` / `_sourceTable` | 哪一台 CDS、哪一張環狀表 |
| `measurementTime` / `storeTime` | DB 原值，**UTC** |
| `...Local` | 只有加 `--local` 才有，換算成 +8 |

加 `--with-summary` 會改成 `{ summary, rows }`，`summary` 記錄每站用了哪張表、DB 當下時間、
筆數或錯誤。單站失敗不影響其它站，失敗原因會在 summary 與主控台裡。

## parameterId 從哪來

預設用 `vitals.config.json` 裡的 `parameterIds`（取自 `Vitalsign.sql`）：

```
體溫 150344   HR 147842    SpO2 150456   ICP 153611
CVP 150087    PAP 150045   ABPs 150037   ABPd 150038   ABPm 150039
NBP 150021 / 150022 / 150023
```

### 自己撈好再餵進來（預設）

你在 SSMS 跑完 [sql/parameters.sql](sql/parameters.sql) 之後，把結果存成檔案直接指定即可，
不必讓工具連 primary。目前預設就是這條路：[sql/parameter-ids.txt](sql/parameter-ids.txt)，
48 個 id、8 個項目。

```
ABP | diastolic | 150034
HR  | heartRate | 147842
體溫(˚C) | temperature | 150344
```

```bash
node vitals.js --pretty                             # 用設定檔的 parameterIdsFile
node vitals.js --params other-list.txt --pretty     # 換一份清單
node vitals.js --param 147842,150456,150344         # 少量時直接打在命令列
```

匯出格式**不用整理**，下列都吃得下：

| 來源 | 內容長相 |
|---|---|
| 管線分隔、無標頭 | `ABP \| diastolic \| 150034`（會自動判斷哪一欄是 id） |
| SSMS 結果另存 JSON | `[{"terseLabel":"HR","cdsParameterId":147842}, ...]` |
| SSMS 連同標頭複製 | `terseLabel⇥propName⇥cdsParameterId` 後面接資料列 |
| CSV | `cdsParameterId,terseLabel`（欄位順序、大小寫都無所謂） |
| 結果到文字 | 含 `----+----` 分隔線與 `(48 rows affected)` 也沒關係 |
| 純數字 | `147842,150456` 或一行一個 |

沒有標頭時會從內容推欄位：幾乎全是整數的那欄當 id（同分取最右邊），其餘非數字欄由左到右
當作 `terseLabel` 與 `propName`。自動去重、略過空值與非整數，BOM 也會處理掉。

### 轉成 JSON

```bash
node vitals.js --convert sql/parameter-ids.txt                 # → sql/parameter-ids.json
node vitals.js --convert my-list.txt -o params.json            # 指定輸出檔名
```

不連資料庫，轉完就結束。輸出是結構化的陣列，可以直接當 `--params` 再讀回來：

```json
[
  { "cdsParameterId": -268367660, "terseLabel": "ABP", "propName": "diastolic" },
  { "cdsParameterId": 150344, "terseLabel": "體溫(˚C)", "propName": "temperature" }
]
```

撈回來的每筆資料會多兩個欄位：

```json
{ "parameterId": 150034, "_paramLabel": "ABP", "_paramProp": "diastolic", ... }
```

`_paramProp` 很重要——`ABP` 底下有 systolic / diastolic / mean 三種，只看 `_paramLabel`
分不出來。

> 同一個 id 掛在多個細項下時（例如 `-268367660` 同時是 ABP diastolic 與 systolic），
> 取檔案裡先出現的那個。

### 或讓工具自己查

加 `--discover` 會連 `primary` 跑 [sql/parameters.sql](sql/parameters.sql)。它沿著
`Intervention → Attribute → CdsParameterMap` 找出對應，並用 `EXISTS` 限定只取出現在
「生命徵象及治療紀錄」/「兒醫生命徵象及治療紀錄」表單上的項目。永遠跟著 ICCA 的設定走，
代價是多連一次 primary。

### 來源優先序

```
--param  >  --params / parameterIdsFile  >  站台 parameterIds  >  設定檔 parameterIds
--discover 會蓋掉以上全部
```

實際採用了哪個來源會印在執行訊息裡，不用猜：

```
  [cds1] parameterId：48 個（來源：my-params.json）
```

> **`體溫(˚C)` 裡的度數符號是 `˚` (U+02DA RING ABOVE)，不是 `°` (U+00B0 DEGREE SIGN)。**
> 兩者長得幾乎一樣，但 SQL 比對不會相等——打錯的話體溫會安靜地查不到，其它項目照常回傳，
> 很難發現。要改請直接從 SSMS 複製，不要手打。

## 時區：DB 存的是 UTC

`Vitalsign.sql` 用 `GETUTCDATE()` 比對 `measurementTime`，代表 **ICCA 存的時間是 UTC**。
台灣看到的「差 8 小時」就是這麼來的。

`vitals.js` 的時間窗直接用 **DB 端的 `GETUTCDATE()`** 計算，完全不碰用戶端時鐘，所以不管執行
機器在哪個時區都不會算錯。輸出的時間欄位維持 DB 原值（UTC）；加 `--local` 會另外補上
`measurementTimeLocal` / `storeTimeLocal`（預設 +8，可用 `displayTimezoneOffsetHours` 調整）。

---

# ICCA 多資料庫抓取工具

同時（平行）連線多個 **SQL Server** 資料庫，各自執行你自訂的 SQL，
把所有結果合併成 **單一 JSON 陣列**（每筆標記來源資料庫），最後寫出成一個 JSON 檔。

## 安裝

```bash
npm install
cp databases.config.example.json databases.config.json   # 再填入實際連線資訊
```

> **`databases.config.json` 已列入 `.gitignore`，不會被提交。** 它含明文密碼與內網位址，
> 請不要移出忽略清單。密碼建議寫成 `"env:ICCA_PASSWORD"`，程式會改讀環境變數：
>
> ```bash
> ICCA_PASSWORD='...' node vitals.js --pretty
> ```

會安裝 [`mssql`](https://www.npmjs.com/package/mssql) 套件（底層走 tedious 驅動，純 Node.js，不需另外裝 ODBC）。

## 設定

編輯 `databases.config.json`，在 `databases` 陣列中每個資料庫填入連線資訊與**自訂 SQL**：

```json
{
  "output": "icca-data.json",
  "queryTimeoutMs": 60000,
  "databases": [
    {
      "name": "db1",
      "enabled": true,
      "connection": {
        "server": "192.168.1.10",
        "port": 1433,
        "database": "ICCA_DB1",
        "user": "sa",
        "password": "在這裡填密碼",
        "options": { "encrypt": false, "trustServerCertificate": true }
      },
      "query": "SELECT id, name, country FROM icca WHERE status = 'A'"
    }
  ]
}
```

欄位說明：

- `name`：來源代號，會寫進每筆資料的 `_source` 欄位。
- `enabled`：設 `false` 可暫時略過該資料庫（不填視為 true）。
- `connection`：`mssql` 的連線設定。內部/自簽憑證環境常用 `encrypt: false` + `trustServerCertificate: true`；Azure SQL 則需 `encrypt: true`。
- `query`：**你自訂的 SQL**。各庫欄位名稱不同時，可用 `AS` 對齊成一致欄位，例如 `SELECT event_id AS id, title AS name ...`。
- 最外層 `output`：輸出檔名；`queryTimeoutMs`：單次查詢逾時（毫秒）。

### 密碼不想寫在檔案裡？

把密碼（或帳號）寫成 `"env:變數名稱"`，程式會改讀環境變數：

```json
"password": "env:DB1_PASSWORD"
```

```bash
DB1_PASSWORD='你的密碼' node index.js
```

## 執行

```bash
node index.js                    # 使用 databases.config.json
node index.js --config my.json   # 指定其他設定檔
node index.js --out result.json  # 覆寫輸出檔名
node index.js --pretty           # 輸出縮排美化的 JSON
```

執行時會即時顯示每個資料庫的成功筆數或失敗原因，例如：

```
開始平行查詢 2 個資料庫...
  ✓ db1：128 筆
  ✓ db2：57 筆
----------------------------------------
合併總筆數：185
成功：2 / 2，耗時 0.6s
已輸出：/path/to/icca-data.json
```

## 輸出格式

單一 JSON 陣列，每筆物件多一個 `_source` 標記來源：

```json
[
  { "_source": "db1", "id": 1, "name": "ICCA Congress", "country": "TW" },
  { "_source": "db2", "id": 88, "name": "Regional Meeting", "country": "JP" }
]
```

## 設計重點

- **平行查詢**：用 `Promise.allSettled`，任一資料庫失敗不會中斷其它庫，並在結尾列出各庫狀態。
- **獨立連線池**：每個資料庫用自己的 `ConnectionPool`，查完即關閉。
- **結束碼**：全部資料庫都失敗時回傳非零結束碼，方便排程 / CI 判斷。

---

# 環狀資料表工具（ring.js）

針對 `UnvalidatedDevicePeriodicData_00 ~ _25` 這種**循環寫入**的資料表：資料輪流寫進 26 張表，寫到最後一張再繞回第一張，所以「最新的那張表」會一直輪動。

## 原理

對每張表跑 `SELECT MAX(storeTime), COUNT(*)`，**時間最新的那張就是目前的寫入頭 (head)**。從 head 往回繞（head、head−1、…，繞過 `_00` 再接 `_25`）就能排出「由新到舊」的完整順序；head+1 那張則是最舊、下一個會被覆蓋的表。

**表號大小不代表新舊。** 例如某次掃描 `_05` 是 19:00、`_25` 是 13:00，此時 head 是 `_05`，而 `_25` 排在 rank 6（19:00 往回 6 張表 = 13:00）：

| rank | 表 | 時間 | |
|---|---|---|---|
| 0 | `_05` | 19:00 | ← head，正在寫入 |
| 1–5 | `_04` … `_00` | 18:00–14:00 | |
| 6 | `_25` | 13:00 | ← 繞回最大編號 |
| … | | | |
| 25 | `_06` | 18:00（前一天） | ← 最舊，下一個被覆蓋 |

一張表約一小時，26 張表 ≈ **26 小時的保留量**。

> **表號會隨時間換意義。** 上面那張表是某個瞬間的快照。40 小時後 head 會推進 40 格
> （`(5 + 40) mod 26 = 19`，繞了一圈半），此時 `_05` 裝的已經是完全不同時段的資料，而原本
> 那批資料早就被蓋掉了（40 小時 > 26 小時保留量）。**不要記住表號，每次都重新掃 head**，
> 或直接用 `--mode at` 反查。

> **rank 25 是危險區。** 它同時是「最舊」也是「正要被覆蓋」的表，讀到的內容可能新舊混雜。要撈完整時間軸時建議只信 rank 0–24；`--mode order` 的輸出會用 `isNextToOverwrite: true` 標出這張表。

## 設定（ring.config.json）

```json
{
  "connection": { "server": "...", "database": "CDSUnvalidatedDataDB", "user": "...", "password": "env:DB_PASSWORD", "options": { "encrypt": false, "trustServerCertificate": true } },
  "ring": {
    "tablePrefix": "UnvalidatedDevicePeriodicData_",
    "start": 0, "count": 26, "pad": 2,
    "headColumn": "storeTime",
    "timeColumn": "measurementTime",
    "orderColumn": "measurementTime",
    "parameterColumn": "parameterId",
    "patientColumn": "patientIdentifier",
    "deviceColumn": "deviceInstanceId",
    "select": "[tableNum], [deviceInstanceId], [storeTime], [parameterId], [label], [numericValue], [textValue], [units], [timeSynchId], [measurementTime], [isTrendUpload], [patientIdentifier]",
    "filter": {
      "parameterId": [],
      "patientIdentifier": null,
      "deviceInstanceId": null,
      "timeFrom": null,
      "timeTo": null
    }
  },
  "mode": "latest",
  "latestN": 1000,
  "direction": "newToOld"
}
```

- `tablePrefix` + `start`/`count`/`pad`：組出表名。目前設定會產生 `..._00` ~ `..._25`。
- `headColumn`：**判斷 head 用的欄位**，設為 `storeTime`（寫入時間）。沒設就沿用 `timeColumn`。
- `timeColumn`：臨床量測時間 `measurementTime`，用於 `--from`/`--to` 過濾與 `params` 的時間範圍。
- `orderColumn`：撈資料時排序用的欄（通常同 `timeColumn`）。
- `select`：撈資料時要取的欄位，`*` 為全部。
- `filter`：撈資料時的 `WHERE` 條件，見下節。

### 為什麼 head 要用 storeTime、資料排序要用 measurementTime

環狀表的輪動是照**寫入順序**發生的，所以「這張表最後被寫入的時間」＝ `storeTime` 才是定位
head 的正確依據。`measurementTime` 是儀器**量測**的時間，兩者正常情況很接近，但
`isTrendUpload = 1` 的趨勢資料是後補上傳的——量測時間可能是幾小時前，卻寫進現在這張表。
這種資料一多，`MAX(measurementTime)` 就可能指到錯的表。

反過來，撈出來的資料要照**臨床時間軸**排序與過濾，那就該用 `measurementTime`。所以兩個欄位
分開設定。

程式在掃描時會一次撈回兩個欄位的 `MAX`，如果兩者算出來的 head 不一致會提出警告：

```
目前寫入頭 (head)：UnvalidatedDevicePeriodicData_05（依 storeTime）
  最後寫入時間：2026-07-22T19:00:00.000Z（共 48213 筆）
  ⚠ 依 measurementTime 判斷會得到 UnvalidatedDevicePeriodicData_03，與 storeTime 的結果不同；
    以 storeTime 為準（寫入順序才是環狀輪動的依據）
```

`--mode order` 的輸出裡，`maxTime` 是 `storeTime`、`maxAltTime` 是 `measurementTime`，可以直接比對。

## 用 parameterId 撈資料

`UnvalidatedDevicePeriodicData_XX` 每一筆是「某台儀器、某個時間點、某個參數」的一個值
（`parameterId` + `label` + `numericValue`/`textValue` + `units`），所以實務上幾乎都要先鎖定
`parameterId` 才撈得到有用的東西。

### 1. 先看有哪些 parameterId

```bash
DB_PASSWORD='...' node ring.js --mode params --pretty
```

對 head 那張表跑 `GROUP BY parameterId, label, units`，輸出依筆數由多到少排序：

```json
[
  { "parameterId": 4102, "label": "HR", "units": "bpm", "count": 18240,
    "minTime": "...", "maxTime": "...", "tables": ["UnvalidatedDevicePeriodicData_07"] }
]
```

加 `--all` 會掃全部 26 張表並合併統計（較慢，但看得到完整值域與時間範圍）。

### 2. 依 parameterId 撈資料

```bash
# 單一參數，最新 500 筆
node ring.js --mode latest --param 4102 -n 500 --pretty

# 多個參數混在一起，總共最新 1000 筆
node ring.js --mode latest --param 4102,4103,4104 -n 1000

# 多個參數「各自」撈滿 200 筆，輸出依 parameterId 分組
node ring.js --mode byParam --param 4102,4103 -n 200 --pretty

# 再加上病人 / 儀器 / 時間範圍
node ring.js --mode latest --param 4102 --patient A123456 --from 2026-07-01 --to 2026-07-22
```

`latest` 與 `byParam` 的差別：`latest` 是「這些參數合起來的最新 N 筆」，某個高頻參數可能把
額度吃光；`byParam` 是「每個參數各自的最新 N 筆」，輸出成 `{ "4102": [...], "4103": [...] }`。

也可以把條件固定寫在 `ring.config.json` 的 `ring.filter` 裡，命令列參數會覆寫設定檔的值。

## 用時間點反查資料表（at 模式）

「現在這個時間的資料在哪張表？」「昨天 15:00 的資料還在嗎？」用 `at` 模式：

```bash
node ring.js --mode at --pretty                     # 現在時間
node ring.js --mode at --at "2026-07-22 03:00" -p   # 指定時間
node ring.js --mode at --at 03:00 -p                # 只給 HH:MM = 今天（比現在晚則算昨天）
node ring.js --mode at --at 03:00 --fetch --param 4102 -n 500   # 定位後順便撈資料
```

```
查詢時間：2026-07-22 11:24:00（DB 時鐘，比對 storeTime）
一張表約 60.0 分鐘（相鄰表時間差中位數）
→ UnvalidatedDevicePeriodicData_23（rank 0，共 12043 筆）
  區間：2026-07-22 11:00:00 ~ 2026-07-22 11:24:00
目前可撈範圍：2026-07-21 10:00:00 ~ 2026-07-22 11:24:00（約 25.4 小時）
```

### 時區：為什麼會差 8 小時

`mssql`/tedious 預設 `useUTC: true`，會把資料表裡**沒有時區資訊**的 datetime **當成 UTC** 讀回來
——`11:00` 讀回來就是 epoch `11:00Z`。但 `new Date()` 拿到的是真正的本機時間，台灣（UTC+8）
的 11:24 epoch 是 `03:24Z`。兩者直接相比就差 8 小時，`--mode at` 會定位到 **8 張表之前**。

處理方式是把整個程式放在同一個座標系——**DB 時鐘**，也就是你在 SSMS 裡看到的那個字面值：

- 所有輸出的時間都印成 `2026-07-22 11:00:00`（DB 字面值，不做任何轉換）。
- 你輸入的時間（`--at`、`--from`、`--to`）沒帶時區時，一律**當成 DB 時鐘**解讀，不受本機時區影響。
- 只有「現在幾點」需要換算，程式會**自動偵測**位移並在執行時印出來：

```
目前寫入頭 (head)：UnvalidatedDevicePeriodicData_23（依 storeTime）
  最後寫入時間：2026-07-22 11:24:00（共 12043 筆）
  時區位移：DB 時鐘比本機快 8 小時（自動偵測，實測差 480 分）
```

原理是 head 的最後寫入時間 ≈ 現在，兩者的差就是位移。時區位移一定落在整點附近，殘差太大
（例如資料早就停止寫入）會警告你這可能不是時區問題。

不想自動偵測就寫死：設定檔的 `dbTimeOffsetHours`，或命令列 `--tz-offset 8`（`--tz-offset 0`
可完全關掉校正）。手動值與實測不符時也會提醒。

帶時區的 ISO 字串（`2026-07-22T15:00:00+08:00`、`...Z`）會尊重它自己的時區，不套用上面的規則。

**它是比對實際區間，不是用公式推算的。** 掃描時每張表的 `MIN`/`MAX` 都拿到了，直接找哪張表的
區間包含目標時間即可——不需要假設「一張表剛好一小時」。輸出裡的 `rotationMinutes` 只是把相鄰
表的時間差取中位數，讓你知道大概多久輪一張；`predicted` 則是用這個週期反推的結果，跟實際定位
不一致時會提醒你「輪動不是等時距，別用算的」。

`status` 有四種：

| status | 意思 |
|---|---|
| `ok` | 找到了，`table` / `rank` / `rangeMin` / `rangeMax` 有值 |
| `overwritten` | 太舊，已經被繞回來的新資料蓋掉了 |
| `pending` | 太新，還沒寫進資料庫 |
| `gap` | 在保留範圍內，但那個時段沒有資料（儀器沒上傳 / 系統停機） |

`--by measure` 可改用 `measurementTime` 比對（預設 `storeTime`，也就是資料實際被寫進哪張表）。
`coverage` 會告訴你目前整個環涵蓋的時間範圍與時數——**查歷史資料前先看這個**，超出範圍的時段
已經永久消失了。

## 六種模式

```bash
node ring.js --mode head      # 只找出目前寫入頭是哪一張表 + 最後一筆時間
node ring.js --mode order     # 列出 26 張表由新到舊的順序、各表 min/max 時間與筆數
node ring.js --mode at        # 某個時間點的資料在哪一張表
node ring.js --mode latest    # 從 head 開始跨表撈出「最新 N 筆」，輸出 JSON
node ring.js --mode byParam   # 每個 parameterId 各自撈滿最新 N 筆
node ring.js --mode params    # 列出有哪些 parameterId / label / units 與筆數
```

- `head`：輸出 `{ headTable, headIndex, headColumn, lastRecordTime, totalRows }`。
- `at`：輸出定位結果與 `coverage`，加 `--fetch` 會多一個 `rows` 欄位。
- `order`：輸出排序後的表清單，每筆含 `rank / table / maxTime / minTime / count / isHead`。
- `latest`：從 head 跨表往回取，湊滿 `latestN` 筆為止，每筆標記 `_sourceTable`。
- `byParam`：同上，但每個 `parameterId` 各跑一次，輸出以 `parameterId` 為 key 分組。
- `params`：`GROUP BY parameterId, label, units` 的目錄清單，預設只掃 head，`--all` 掃全部。
- `direction`：`newToOld`（預設）或 `oldToNew`，影響 order / latest / byParam 的輸出排序。

## 執行

```bash
DB_PASSWORD='你的密碼' node ring.js --mode head --pretty
```

執行時會即時顯示判斷出的 head 與最後一筆時間，例如：

```
連線中，準備掃描 26 張環狀資料表...
目前寫入頭 (head)：UnvalidatedDevicePeriodicData_07
  最後一筆時間：2026-07-21T03:12:44.000Z（共 48213 筆）
已排出 newToOld 順序（rank 0 = UnvalidatedDevicePeriodicData_07）
```

## 安全性

- 表名與欄位名（含 `parameterColumn` / `patientColumn` / `deviceColumn`）都經過白名單檢查，只允許英數與底線。
- `TOP (@n)` 與所有過濾值（`parameterId`、`patientIdentifier`、`deviceInstanceId`、時間範圍）一律走
  參數化查詢綁定，命令列傳進來的值不會拼進 SQL 字串。
- `ring.select` 是唯一會直接拼進 SQL 的欄位（為了支援 `AS`、運算式），只放你自己寫的欄位清單，不要接外部輸入。

## 判斷 head 時不套用過濾

`head` 是用**未過濾**的全表 `MAX(measurementTime)` 判斷的。如果先套 `parameterId` 再找 head，
某些表可能因為沒有該參數而顯示為空、導致環狀位置誤判；先定位 head、再套過濾往回撈才是對的順序。
