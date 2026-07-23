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
 * 注意這裡沒有 USE / GO——連線的資料庫由 databases.config.json 決定，
 * 而 mssql 送的是單一批次，GO 只是 SSMS 的分批指令，不是 T-SQL。
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
