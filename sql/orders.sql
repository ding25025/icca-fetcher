-- 藥物醫囑（鎮靜／止痛／肌肉鬆弛／升壓）在病歷裡的紀錄。
--
-- neuro.js 的第 4 段會在**每一個 charting 分片**跑這一份，跟病歷紀錄同一條連線、
-- 同一個時間窗。跟 neuro-interventions.sql 不同，這裡不走 interventionId 清單，
-- 而是拿 StdOrderRequest.terseForm 做藥名比對，輸出的 terseLabel 就是那個藥名。
--
-- neuro.js 會自動補上批次前綴（READ UNCOMMITTED、DEADLOCK_PRIORITY LOW、
-- LOCK_TIMEOUT 取設定的 neuro.lockTimeoutMs、NOCOUNT），所以這裡不用自己寫 SET。
--
-- 帶進來的參數：
--   @win                 時間窗分鐘數。storeTime >= 近 @win 分鐘，時間一律用 DB 端
--                        的 GETUTCDATE()，不看跑這支程式的機器。
--   ptEncounterId 清單   下面 WHERE 裡那個包在 block comment 的 __ENCOUNTER_IDS__
--                        標記，會被換成 @oe0, @oe1, … 這串參數。**標記一定要留著**，
--                        prepare() 讀檔時就檢查，少了會當場擋下來，不會等到連上
--                        分片才一次炸掉所有組。
--
-- 回傳欄位要跟病歷紀錄那段對齊（neuro.js 照這些欄位組 records[]）：
--   ptEncounterId / interventionId / terseLabel / terseForm / verboseForm
--   / chartTime / storeTime / isDeleted

SELECT DISTINCT
     pi.ptEncounterId
    ,pi.interventionId
    ,s.terseForm AS terseLabel
    ,pi.terseForm
    ,pi.verboseForm
    ,pi.chartTime
    ,pi.storeTime
    ,pi.isDeleted
FROM dbo.StdOrderRequest AS s WITH (NOLOCK)
JOIN dbo.PtDescriptor AS pd WITH (NOLOCK) ON pd.stdOrderRequestId = s.stdOrderRequestId
JOIN dbo.PtIntervention AS pi WITH (NOLOCK) ON pi.ptDescriptorId = pd.ptDescriptorId
WHERE pi.storeTime >= DATEADD(MINUTE, -@win, GETUTCDATE())
  AND pi.ptEncounterId IN (/*__ENCOUNTER_IDS__*/)
  AND (
       s.terseForm LIKE '%Fentanyl%' OR s.terseForm LIKE '%Precedex%'
    OR s.terseForm LIKE '%Midazolam%' OR s.terseForm LIKE '%Fresofol%'
    OR s.terseForm LIKE '%Nimbex%' OR s.terseForm LIKE '%Dopamin%'
    OR s.terseForm LIKE '%Levophed%' OR s.terseForm LIKE '%Epinephrine%'
    OR s.terseForm LIKE '%Dobutamine%' OR s.terseForm LIKE '%Pitressin%'
    OR s.terseForm LIKE '%Perdipine%'
  )
ORDER BY pi.ptEncounterId, pi.storeTime DESC;
