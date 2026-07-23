/*
 * 目前在床的病人（primary / CISPrimaryDB）。
 *
 * 供 vitals.js 把 CDS 撈到的儀器資料接上病歷號用：
 *   CDS 端  UdsBed.bedId / DeviceInstance.bedId
 *   primary 端 PtLocationStay.bedId
 * 兩邊是同一組值，bedId 就是接起來的鑰匙（bedId 本身不會出現在輸出裡）。
 *
 * 回傳欄位必須包含 bedId；lifetimeNumber / encounterNumber / ptEncounterId
 * 會被併進輸出的每一筆資料。
 *
 * 要連哪個資料庫：可以在這裡寫一行 USE <資料庫>，vitals.js 會讀它來決定連線目標
 * （那一行不會被送到 SQL Server，mssql 送的是單一批次；GO 同理，是 SSMS 的分批
 * 指令、不是 T-SQL，都會被自動拿掉）。沒寫的話會依序試 primary 設定裡的 database、
 * 再試 CISPrimaryDB。也可以在 vitals 區塊寫 "patientDatabase": "..." 直接指定。
 * 連錯資料庫的症狀就是「找不到 dbo.PtLocationStay」→ 病歷號整排 null。
 */

SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 3000;
SET NOCOUNT ON;

SELECT
     ls.bedId              -- ★ 接 CDS 的鑰匙
    ,p.lifetimeNumber      -- 病歷號
    ,pe.encounterNumber    -- 住院帳號
    ,pe.ptEncounterId
FROM      dbo.PtLocationStay ls WITH (NOLOCK)
JOIN      dbo.PtEncounter    pe WITH (NOLOCK) ON pe.ptEncounterId = ls.ptEncounterId
JOIN      dbo.PtEpisode      ep WITH (NOLOCK) ON ep.ptEpisodeId   = pe.ptEpisodeId
JOIN      dbo.Patient        p  WITH (NOLOCK) ON p.patientId      = ep.patientId
WHERE ls.endDate IS NULL          -- 線上
  AND ls.bedId  IS NOT NULL       -- 有床才接得到 CDS
ORDER BY ls.bedId
