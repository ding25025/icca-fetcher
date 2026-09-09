/*
 * 目前在床的病人（primary / CISPrimaryDB）。
 *
 * 供 vitals.js 把 CDS 撈到的儀器資料接上病歷號用，鑰匙是「床號」：
 *   CDS 端     UdsBed.label
 *   primary 端 Bed.displayLabel
 * vitals.js 比對前會去頭尾空白、把連續空白縮成一個、轉大寫，所以兩邊大小寫或
 * 空白不一致沒關係；但前綴、補零這種寫法差異要在這支 SQL 裡自己對齊。
 *
 * 回傳欄位必須包含 bed（床號）；只有 lifetimeNumber 和 encounterNumber 會原名併進
 * 輸出的每一筆資料（這支目前沒選 encounterNumber，輸出那一欄就是 null）。其它欄位
 * （unit / startDate / endDate / ptEncounterId）撈了不會進輸出，只是給人對帳、篩選用。
 *
 * 注意床號不像 bedId 保證唯一：不同單位若有同名的床，同一個床號會對到多位病人，
 * vitals.js 會警告並只接其中一位。真的撞號就要在這裡再限定 clinicalUnit。
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
    b.displayLabel     AS bed        -- 接 CDS 的鑰匙  
    ,p.lifetimeNumber          -- 病歷號
    ,cu.displayLabel as unit
    ,ls.startDate
    ,ls.endDate
    ,pe.ptEncounterId
    
    
FROM      dbo.PtLocationStay ls WITH (NOLOCK)
JOIN      dbo.PtEncounter    pe WITH (NOLOCK) ON pe.ptEncounterId  = ls.ptEncounterId
JOIN      dbo.PtEpisode      ep WITH (NOLOCK) ON ep.ptEpisodeId    = pe.ptEpisodeId
JOIN      dbo.Patient        p  WITH (NOLOCK) ON p.patientId       = ep.patientId
JOIN dbo.ClinicalUnit   cu WITH (NOLOCK) ON cu.clinicalUnitId = ls.clinicalUnitId and cu.isAnesthetizingLocation!=1 and cu.onSystem =1 and cu.displayLabel  not like N'%排程%' and cu.displayLabel  not like N'%POR%' and cu.displayLabel  not like N'%交班%'
Left JOIN      dbo.Bed            b  WITH (NOLOCK) ON b.bedId           = ls.bedId   -- LEFT：沒床的 bed 是 NULL，vitals.js 會丟掉
WHERE ls.endDate IS NULL and Len(lifetimeNumber)=7 
and cu.displayLabel IN ('01A1'
,'03A2'
,'03B1'
,'03B2'
,'03C'
,'03D1'
,'04A1'
,'04A2'
,'04B1'
,'04B2'
,'04C1'
,'04C2'
,'04D1'
,'04FI'
,'06E1'
,'07HS'
,'5CVI')
ORDER BY  b.displayLabel;