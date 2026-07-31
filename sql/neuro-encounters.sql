/*
 * 目前在床病人的 ptEncounterId + 資料所在的 HostDb（primary / CISPrimaryDB）。
 *
 * neuro.js 用這份決定「要撈哪些病人、去哪個 charting 資料庫撈」：
 *   ptEncounterId          PtIntervention 的過濾鑰匙
 *   dbSqlInstance / dbName 該病人的病歷資料實際落在哪台 SQL / 哪個 CISChartingDBxxxx
 *   lifetimeNumber         病歷號，原名併進輸出
 *   bed                    床號，方便對照（LEFT JOIN，沒床也留）
 *
 * 一個病人一列。neuro.js 會依 (dbSqlInstance, dbName) 分組，每個 charting DB 連一次，
 * 把該組所有 ptEncounterId 一起丟給 PtIntervention 查詢。
 *
 * 只取在床病人：ls.endDate IS NULL（跟 patients.sql 一致）。
 * 要連哪個資料庫：開頭可寫 USE <資料庫>，neuro.js 會讀它決定連線目標；沒寫就依序試
 *   primary 設定的 database、再試 CISPrimaryDB。連錯的症狀是「找不到 dbo.PtLocationStay」。
 */

SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 3000;
SET NOCOUNT ON;

SELECT DISTINCT
     hd.dbSqlInstance
    ,hd.dbName
    ,pe.ptEncounterId
    ,p.lifetimeNumber          -- 病歷號
    ,b.displayLabel AS bed     -- 床號（對照用）
FROM      dbo.PtLocationStay ls WITH (NOLOCK)
JOIN      dbo.PtEncounter    pe WITH (NOLOCK) ON pe.ptEncounterId  = ls.ptEncounterId
JOIN      dbo.PtEpisode      ep WITH (NOLOCK) ON ep.ptEpisodeId    = pe.ptEpisodeId
JOIN      dbo.Patient        p  WITH (NOLOCK) ON p.patientId       = ep.patientId
JOIN      dbo.HostDb         hd WITH (NOLOCK) ON hd.hostDbId       = pe.hostDbId
LEFT JOIN dbo.Bed            b  WITH (NOLOCK) ON b.bedId           = ls.bedId
WHERE ls.endDate IS NULL
ORDER BY hd.dbSqlInstance, hd.dbName, b.displayLabel;
