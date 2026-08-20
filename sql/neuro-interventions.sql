/*
 * 護理師填在表單上的紀錄對應的 interventionId + terseLabel（primary / CISPrimaryDB）。
 * 名字叫 neuro，實際範圍早就不只神經評估：鎮靜/譫妄、Scoring、呼吸參數、體溫、
 * Intake & Output、CRRT、ECMO、TPM/TCP 都在這裡。
 *
 * 供 neuro.js 使用：interventionId 當 PtIntervention 的過濾條件，terseLabel 會原名
 * 併進輸出的每一筆，下游靠它區分是哪一種紀錄。等同 vitals.js 的 --discover。
 *
 * 目前 14 個 SELECT 區塊（編號到 13，組別 11 有兩塊），共 39 個 terseLabel。
 * 每組的差別只在「terseLabel 清單 + FSSection + Document」三者，其餘 join／篩選
 * 邏輯完全相同，所以用 UNION 併起來。要再加一種，照樣複製一個 SELECT 區塊、
 * 換掉這三個條件即可：
 *
 *   組別  terseLabel                             FSSection.displayLabel  Document.displayLabel
 *   ----  -------------------------------------  ----------------------  ---------------------------
 *   1     昏迷指數/瞳孔/四肢肌力 共 6 項          神經系統病人生命徵象     神經學檢查及昏迷評估紀錄
 *   2     RASS 鎮靜程度評估表                     生命徵象                生命徵象及治療紀錄
 *   3     APACHE Ⅱ/TISS/SOFA/UA/NSTEMI           Scoring                 生命徵象及治療紀錄
 *   4     ICDSC、疼痛指數/評估工具                PAD(不列印)             加護病房護理評估紀錄
 *   5     FiO2 %、Ventilator Mode.               呼吸治療參數             呼吸及檢驗紀錄表
 *   6     FiO2 %.                                呼吸治療參數             呼吸照護紀錄
 *   7     PaO2                                   血液氣體分析             呼吸照護紀錄
 *   8     體溫(˚C)                               生命徵象                生命徵象及治療紀錄
 *   9     體重、輸入/排出量合計、尿液… 共 9 項     Intake & Output         生命徵象及治療紀錄
 *   10    TMP (mmHg)                             觀察紀錄                CRRT紀錄 (Prismaflex)
 *   11    Fluid removed-UF rate (mL/hr)          Settings                CRRT紀錄 (Prismaflex)
 *   11    Fluid removed-weight loss(mL/hr)       Setting                 CRRT紀錄 (Infomed)
 *   12    Pump Speed/Blood Flow/FiO2… 共 6 項     （不指定區段）           體外維生系統及生命徵象紀錄
 *   13    TCP rate/TCP output/Sensitivity        TPM/TCP                 生命徵象及治療紀錄
 *
 * 組別 5~13 不是神經評估，是後來陸續加的。體溫原本走 vitals.js 的 parameter-ids.txt
 * （儀器資料），改由這裡的圖表資料出，所以那份清單裡的體溫 parameterId 已移除。
 *
 * EXISTS 那段用 conceptId 把 intervention 綁回它實際出現的表單區段，避免撈到同名但
 * 屬於別張表單的 intervention。
 *
 * 組別 12 只綁到 Document，不篩 fs.displayLabel（整張表單都收）；
 *   fs → sl → sr → ar 那串 join 仍然要留著，conceptId 挂在 FSAllowedRow 上。
 *
 * ⚠ FiO2 有三個不同的 terseLabel：FiO2 %（組 5）、FiO2 %.（組 6，多一個句點）、
 *   FiO2（組 12）。下游若用名字比對，三個都要收。
 *
 * 回傳欄位必須包含 interventionId 與 terseLabel（neuro.js 讀這兩欄）。
 * 要連哪個資料庫：可在開頭寫一行 USE <資料庫>，neuro.js 會讀它決定連線目標
 *   （那行不會送進 SQL Server，GO 同理，都會被自動拿掉）。沒寫就依序試
 *   primary 設定的 database、再試 CISPrimaryDB。
 */

SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 3000;
SET NOCOUNT ON;

-- 組別 1：神經評估（昏迷指數、瞳孔、眼球活動、四肢肌力…）
SELECT DISTINCT
     i.interventionId
    ,i.terseLabel
FROM dbo.Intervention i WITH (NOLOCK)
JOIN dbo.InterventionItem WITH (NOLOCK)
       ON i.interventionId = InterventionItem.interventionId
      AND InterventionItem.isPrimary = 1
WHERE
      i.isPrimary = 1
  AND i.terseLabel IN (
        N'昏迷指數', 
        N'瞳孔大小(右/左)', 
        N'右上肢肌力', N'右下肢肌力', N'左上肢肌力', N'左下肢肌力'
      )
  AND EXISTS (
      SELECT 1
      FROM dbo.Document      d  WITH (NOLOCK)
      JOIN dbo.FSSection     fs WITH (NOLOCK) ON fs.documentId      = d.documentId
                                             AND fs.displayLabel    = N'神經系統病人生命徵象'
                                             AND fs.isPrimary       = 1
      JOIN dbo.FSAllowedSlot sl WITH (NOLOCK) ON sl.fsSectionId     = fs.fsSectionId
                                             AND sl.isPrimary       = 1
      JOIN dbo.FSSlotRow     sr WITH (NOLOCK) ON sr.fsAllowedSlotId = sl.fsAllowedSlotId
                                             AND sr.isPrimary       = 1
      JOIN dbo.FSAllowedRow  ar WITH (NOLOCK) ON ar.fsAllowedRowId  = sr.fsAllowedRowId
                                             AND ar.isPrimary       = 1
      WHERE d.displayLabel IN (N'神經學檢查及昏迷評估紀錄')
        AND ar.conceptId   = i.conceptId
  )

UNION

-- 組別 2：RASS 鎮靜程度評估（非即時）
SELECT DISTINCT
     i.interventionId
    ,i.terseLabel
    
FROM dbo.Intervention i WITH (NOLOCK)
JOIN dbo.InterventionItem WITH (NOLOCK)
       ON i.interventionId = InterventionItem.interventionId
      AND InterventionItem.isPrimary = 1
WHERE
      i.isPrimary = 1
  AND i.terseLabel IN (N'RASS 鎮靜程度評估表')
  AND EXISTS (
      SELECT 1
      FROM dbo.Document      d  WITH (NOLOCK)
      JOIN dbo.FSSection     fs WITH (NOLOCK) ON fs.documentId      = d.documentId
                                             AND fs.displayLabel    = N'生命徵象'
                                             AND fs.isPrimary       = 1
      JOIN dbo.FSAllowedSlot sl WITH (NOLOCK) ON sl.fsSectionId     = fs.fsSectionId
                                             AND sl.isPrimary       = 1
      JOIN dbo.FSSlotRow     sr WITH (NOLOCK) ON sr.fsAllowedSlotId = sl.fsAllowedSlotId
                                             AND sr.isPrimary       = 1
      JOIN dbo.FSAllowedRow  ar WITH (NOLOCK) ON ar.fsAllowedRowId  = sr.fsAllowedRowId
                                             AND ar.isPrimary       = 1
      WHERE d.displayLabel IN (N'生命徵象及治療紀錄')
        AND ar.conceptId   = i.conceptId
  )

UNION
-- 組別 3：Scoring
SELECT DISTINCT
     i.interventionId
    ,i.terseLabel
    
FROM dbo.Intervention i WITH (NOLOCK)
JOIN dbo.InterventionItem WITH (NOLOCK)
       ON i.interventionId = InterventionItem.interventionId
      AND InterventionItem.isPrimary = 1
WHERE
      i.isPrimary = 1
  AND i.terseLabel IN (N'APACHE Ⅱ',N'TISS',N'SOFA',N'UA/NSTEMI')
  AND EXISTS (
      SELECT 1
      FROM dbo.Document      d  WITH (NOLOCK)
      JOIN dbo.FSSection     fs WITH (NOLOCK) ON fs.documentId      = d.documentId
                                             AND fs.displayLabel    = N'Scoring'
                                             AND fs.isPrimary       = 1
      JOIN dbo.FSAllowedSlot sl WITH (NOLOCK) ON sl.fsSectionId     = fs.fsSectionId
                                             AND sl.isPrimary       = 1
      JOIN dbo.FSSlotRow     sr WITH (NOLOCK) ON sr.fsAllowedSlotId = sl.fsAllowedSlotId
                                             AND sr.isPrimary       = 1
      JOIN dbo.FSAllowedRow  ar WITH (NOLOCK) ON ar.fsAllowedRowId  = sr.fsAllowedRowId
                                             AND ar.isPrimary       = 1
      WHERE d.displayLabel IN (N'生命徵象及治療紀錄')
        AND ar.conceptId   = i.conceptId
  )

UNION

-- 組別 4：ICDSC 譫妄評估（非即時）
SELECT DISTINCT
     i.interventionId
    ,i.terseLabel
    
FROM dbo.Intervention i WITH (NOLOCK)
JOIN dbo.InterventionItem WITH (NOLOCK)
       ON i.interventionId = InterventionItem.interventionId
      AND InterventionItem.isPrimary = 1
WHERE
      i.isPrimary = 1
  AND i.terseLabel IN (N'ICDSC',N'疼痛指數/評估工具')
  AND EXISTS (
      SELECT 1
      FROM dbo.Document      d  WITH (NOLOCK)
      JOIN dbo.FSSection     fs WITH (NOLOCK) ON fs.documentId      = d.documentId
                                             AND fs.displayLabel    = N'PAD(不列印)'
                                             AND fs.isPrimary       = 1
      JOIN dbo.FSAllowedSlot sl WITH (NOLOCK) ON sl.fsSectionId     = fs.fsSectionId
                                             AND sl.isPrimary       = 1
      JOIN dbo.FSSlotRow     sr WITH (NOLOCK) ON sr.fsAllowedSlotId = sl.fsAllowedSlotId
                                             AND sr.isPrimary       = 1
      JOIN dbo.FSAllowedRow  ar WITH (NOLOCK) ON ar.fsAllowedRowId  = sr.fsAllowedRowId
                                             AND ar.isPrimary       = 1
      WHERE d.displayLabel IN (N'加護病房護理評估紀錄')
        AND ar.conceptId   = i.conceptId
  )

UNION
-- 組別 5：呼吸及檢驗紀錄表
Select distinct 
i.interventionId
,i.terseLabel

from Intervention i 
join InterventionItem on i.interventionId=InterventionItem.interventionId AND InterventionItem.isPrimary=1

WHERE  
   i.isPrimary = 1
  AND i.terseLabel IN (N'FiO2 %',N'Ventilator Mode.')
 AND EXISTS (
      SELECT 1
      FROM dbo.Document      d  WITH (NOLOCK)
      JOIN dbo.FSSection     fs WITH (NOLOCK) ON fs.documentId      = d.documentId
                                             AND fs.displayLabel    = N'呼吸治療參數'
                                             AND fs.isPrimary       = 1
      JOIN dbo.FSAllowedSlot sl WITH (NOLOCK) ON sl.fsSectionId     = fs.fsSectionId
                                             AND sl.isPrimary       = 1
      JOIN dbo.FSSlotRow     sr WITH (NOLOCK) ON sr.fsAllowedSlotId = sl.fsAllowedSlotId
                                             AND sr.isPrimary       = 1
      JOIN dbo.FSAllowedRow  ar WITH (NOLOCK) ON ar.fsAllowedRowId  = sr.fsAllowedRowId
                                             AND ar.isPrimary       = 1
      WHERE d.displayLabel in (N'呼吸及檢驗紀錄表')
        AND ar.conceptId   = i.conceptId
  )
  UNION
-- 組別 6：呼吸治療參數（FiO2）
SELECT DISTINCT
     i.interventionId
    ,i.terseLabel
    
FROM dbo.Intervention i WITH (NOLOCK)
JOIN dbo.InterventionItem WITH (NOLOCK)
       ON i.interventionId = InterventionItem.interventionId
      AND InterventionItem.isPrimary = 1
WHERE
      i.isPrimary = 1
  AND i.terseLabel IN (N'FiO2 %.')
  AND EXISTS (
      SELECT 1
      FROM dbo.Document      d  WITH (NOLOCK)
      JOIN dbo.FSSection     fs WITH (NOLOCK) ON fs.documentId      = d.documentId
                                             AND fs.displayLabel    = N'呼吸治療參數'
                                             AND fs.isPrimary       = 1
      JOIN dbo.FSAllowedSlot sl WITH (NOLOCK) ON sl.fsSectionId     = fs.fsSectionId
                                             AND sl.isPrimary       = 1
      JOIN dbo.FSSlotRow     sr WITH (NOLOCK) ON sr.fsAllowedSlotId = sl.fsAllowedSlotId
                                             AND sr.isPrimary       = 1
      JOIN dbo.FSAllowedRow  ar WITH (NOLOCK) ON ar.fsAllowedRowId  = sr.fsAllowedRowId
                                             AND ar.isPrimary       = 1
      WHERE d.displayLabel IN (N'呼吸照護紀錄')
        AND ar.conceptId   = i.conceptId
  )

UNION

-- 組別 7：血液氣體分析（PaO2）
SELECT DISTINCT
     i.interventionId
    ,i.terseLabel
    
FROM dbo.Intervention i WITH (NOLOCK)
JOIN dbo.InterventionItem WITH (NOLOCK)
       ON i.interventionId = InterventionItem.interventionId
      AND InterventionItem.isPrimary = 1
WHERE
      i.isPrimary = 1
  AND i.terseLabel IN (N'PaO2')
  AND EXISTS (
      SELECT 1
      FROM dbo.Document      d  WITH (NOLOCK)
      JOIN dbo.FSSection     fs WITH (NOLOCK) ON fs.documentId      = d.documentId
                                             AND fs.displayLabel    = N'血液氣體分析'
                                             AND fs.isPrimary       = 1
      JOIN dbo.FSAllowedSlot sl WITH (NOLOCK) ON sl.fsSectionId     = fs.fsSectionId
                                             AND sl.isPrimary       = 1
      JOIN dbo.FSSlotRow     sr WITH (NOLOCK) ON sr.fsAllowedSlotId = sl.fsAllowedSlotId
                                             AND sr.isPrimary       = 1
      JOIN dbo.FSAllowedRow  ar WITH (NOLOCK) ON ar.fsAllowedRowId  = sr.fsAllowedRowId
                                             AND ar.isPrimary       = 1
      WHERE d.displayLabel IN (N'呼吸照護紀錄')
        AND ar.conceptId   = i.conceptId
  )

UNION

-- 組別 8：體溫
SELECT DISTINCT
     i.interventionId
    ,i.terseLabel
    
FROM dbo.Intervention i WITH (NOLOCK)
JOIN dbo.InterventionItem WITH (NOLOCK)
       ON i.interventionId = InterventionItem.interventionId
      AND InterventionItem.isPrimary = 1
WHERE
      i.isPrimary = 1
  AND i.terseLabel IN (N'體溫(˚C)')
  AND EXISTS (
      SELECT 1
      FROM dbo.Document      d  WITH (NOLOCK)
      JOIN dbo.FSSection     fs WITH (NOLOCK) ON fs.documentId      = d.documentId
                                             AND fs.displayLabel    = N'生命徵象'
                                             AND fs.isPrimary       = 1
      JOIN dbo.FSAllowedSlot sl WITH (NOLOCK) ON sl.fsSectionId     = fs.fsSectionId
                                             AND sl.isPrimary       = 1
      JOIN dbo.FSSlotRow     sr WITH (NOLOCK) ON sr.fsAllowedSlotId = sl.fsAllowedSlotId
                                             AND sr.isPrimary       = 1
      JOIN dbo.FSAllowedRow  ar WITH (NOLOCK) ON ar.fsAllowedRowId  = sr.fsAllowedRowId
                                             AND ar.isPrimary       = 1
      WHERE d.displayLabel IN (N'生命徵象及治療紀錄')
        AND ar.conceptId   = i.conceptId
  )
UNION

-- 組別 9：Intake & Output
SELECT DISTINCT
     i.interventionId
    ,i.terseLabel
   
FROM dbo.Intervention i WITH (NOLOCK)
JOIN dbo.InterventionItem WITH (NOLOCK)
       ON i.interventionId = InterventionItem.interventionId
      AND InterventionItem.isPrimary = 1
WHERE
      i.isPrimary = 1
  AND i.terseLabel IN (N'體重-kg (每日)',N'輸入量合計 (8hr)',N'輸入量合計 (24hr)',N'排出量合計 (8hr)',N'排出量合計 (24hr)',N'尿液',N'pigtail',N'胸腔輸出',N'糞便輸出')
  AND EXISTS (
      SELECT 1
      FROM dbo.Document      d  WITH (NOLOCK)
      JOIN dbo.FSSection     fs WITH (NOLOCK) ON fs.documentId      = d.documentId
                                             AND fs.displayLabel    = N'Intake & Output'
                                             AND fs.isPrimary       = 1
      JOIN dbo.FSAllowedSlot sl WITH (NOLOCK) ON sl.fsSectionId     = fs.fsSectionId
                                             AND sl.isPrimary       = 1
      JOIN dbo.FSSlotRow     sr WITH (NOLOCK) ON sr.fsAllowedSlotId = sl.fsAllowedSlotId
                                             AND sr.isPrimary       = 1
      JOIN dbo.FSAllowedRow  ar WITH (NOLOCK) ON ar.fsAllowedRowId  = sr.fsAllowedRowId
                                             AND ar.isPrimary       = 1
      WHERE d.displayLabel IN (N'生命徵象及治療紀錄')
        AND ar.conceptId   = i.conceptId
  )

UNION
-- 組別 10：CRRT紀錄 (Prismaflex)
SELECT DISTINCT
     i.interventionId
    ,i.terseLabel

FROM dbo.Intervention i WITH (NOLOCK)
JOIN dbo.InterventionItem WITH (NOLOCK)
       ON i.interventionId = InterventionItem.interventionId
      AND InterventionItem.isPrimary = 1

WHERE
      i.isPrimary = 1
      AND i.terseLabel IN (N'TMP (mmHg)')
  AND EXISTS (
      SELECT 1
      FROM dbo.Document      d  WITH (NOLOCK)
      JOIN dbo.FSSection     fs WITH (NOLOCK) ON fs.documentId      = d.documentId
                                             AND fs.displayLabel    = N'觀察紀錄'
                                             AND fs.isPrimary       = 1
      JOIN dbo.FSAllowedSlot sl WITH (NOLOCK) ON sl.fsSectionId     = fs.fsSectionId
                                             AND sl.isPrimary       = 1
      JOIN dbo.FSSlotRow     sr WITH (NOLOCK) ON sr.fsAllowedSlotId = sl.fsAllowedSlotId
                                             AND sr.isPrimary       = 1
      JOIN dbo.FSAllowedRow  ar WITH (NOLOCK) ON ar.fsAllowedRowId  = sr.fsAllowedRowId
                                             AND ar.isPrimary       = 1
      WHERE d.displayLabel IN (N'CRRT紀錄 (Prismaflex)')
        AND ar.conceptId   = i.conceptId
  )

UNION

 --組別 11：CRRT紀錄 (Prismaflex) Fluid removed-UF rate (mL/hr)

SELECT DISTINCT
     i.interventionId
    ,i.terseLabel 
  
FROM dbo.Intervention i WITH (NOLOCK)
JOIN dbo.InterventionItem WITH (NOLOCK)
       ON i.interventionId = InterventionItem.interventionId
      AND InterventionItem.isPrimary = 1

WHERE
      i.isPrimary = 1
      AND i.terseLabel IN (N'Fluid removed-UF rate (mL/hr)')
  AND EXISTS (
      SELECT 1
      FROM dbo.Document      d  WITH (NOLOCK)
      JOIN dbo.FSSection     fs WITH (NOLOCK) ON fs.documentId      = d.documentId
                                             AND fs.displayLabel    = N'Settings'
                                             AND fs.isPrimary       = 1
      JOIN dbo.FSAllowedSlot sl WITH (NOLOCK) ON sl.fsSectionId     = fs.fsSectionId
                                             AND sl.isPrimary       = 1
      JOIN dbo.FSSlotRow     sr WITH (NOLOCK) ON sr.fsAllowedSlotId = sl.fsAllowedSlotId
                                             AND sr.isPrimary       = 1
      JOIN dbo.FSAllowedRow  ar WITH (NOLOCK) ON ar.fsAllowedRowId  = sr.fsAllowedRowId
                                             AND ar.isPrimary       = 1
      WHERE d.displayLabel IN (N'CRRT紀錄 (Prismaflex)')
        AND ar.conceptId   = i.conceptId
  )
 
UNION  
 --組別 11：CRRT紀錄 (Infomed) Fluid removed-weight loss (mL/hr)
SELECT DISTINCT
     i.interventionId
    ,i.terseLabel 
  
FROM dbo.Intervention i WITH (NOLOCK)
JOIN dbo.InterventionItem WITH (NOLOCK)
       ON i.interventionId = InterventionItem.interventionId
      AND InterventionItem.isPrimary = 1

WHERE
      i.isPrimary = 1
      AND i.terseLabel IN (N'Fluid removed-weight loss(mL/hr)')
  AND EXISTS (
      SELECT 1
      FROM dbo.Document      d  WITH (NOLOCK)
      JOIN dbo.FSSection     fs WITH (NOLOCK) ON fs.documentId      = d.documentId
                                             AND fs.displayLabel    = N'Setting'
                                             AND fs.isPrimary       = 1
      JOIN dbo.FSAllowedSlot sl WITH (NOLOCK) ON sl.fsSectionId     = fs.fsSectionId
                                             AND sl.isPrimary       = 1
      JOIN dbo.FSSlotRow     sr WITH (NOLOCK) ON sr.fsAllowedSlotId = sl.fsAllowedSlotId
                                             AND sr.isPrimary       = 1
      JOIN dbo.FSAllowedRow  ar WITH (NOLOCK) ON ar.fsAllowedRowId  = sr.fsAllowedRowId
                                             AND ar.isPrimary       = 1
      WHERE d.displayLabel IN (N'CRRT紀錄 (Infomed)')
        AND ar.conceptId   = i.conceptId
  )
  UNION

-- 組別 12：體外維生系統及生命徵象紀錄（這組不指定 FSSection，整張表單都收）
SELECT DISTINCT
     i.interventionId
    ,i.terseLabel
FROM dbo.Intervention i WITH (NOLOCK)
JOIN dbo.InterventionItem WITH (NOLOCK)
       ON i.interventionId = InterventionItem.interventionId
      AND InterventionItem.isPrimary = 1
WHERE
      i.isPrimary = 1
  AND i.terseLabel IN (N'Pump Speed',N'Blood Flow (L/min)',N'Gas Flow (L/min)',N'FiO2',N'Pulse Index',N'Pump Power')
  AND EXISTS (
      SELECT 1
      FROM dbo.Document      d  WITH (NOLOCK)
      JOIN dbo.FSSection     fs WITH (NOLOCK) ON fs.documentId      = d.documentId
                                             AND fs.isPrimary       = 1
      JOIN dbo.FSAllowedSlot sl WITH (NOLOCK) ON sl.fsSectionId     = fs.fsSectionId
                                             AND sl.isPrimary       = 1
      JOIN dbo.FSSlotRow     sr WITH (NOLOCK) ON sr.fsAllowedSlotId = sl.fsAllowedSlotId
                                             AND sr.isPrimary       = 1
      JOIN dbo.FSAllowedRow  ar WITH (NOLOCK) ON ar.fsAllowedRowId  = sr.fsAllowedRowId
                                             AND ar.isPrimary       = 1
      WHERE d.displayLabel IN (N'體外維生系統及生命徵象紀錄')
        AND ar.conceptId   = i.conceptId
  )

  UNION
-- 組別 13：生命徵象及治療紀錄 TPM/TCP
SELECT DISTINCT
     i.interventionId
    ,i.terseLabel
   
FROM dbo.Intervention i WITH (NOLOCK)
JOIN dbo.InterventionItem WITH (NOLOCK)
       ON i.interventionId = InterventionItem.interventionId
      AND InterventionItem.isPrimary = 1
WHERE
      i.isPrimary = 1
  AND i.terseLabel IN (N'TCP rate (ppm)',N'TCP output (mA)',N'Sensitivity (mV)')
  AND EXISTS (
      SELECT 1
      FROM dbo.Document      d  WITH (NOLOCK)
      JOIN dbo.FSSection     fs WITH (NOLOCK) ON fs.documentId      = d.documentId
                                             AND fs.displayLabel    = N'TPM/TCP'
                                             AND fs.isPrimary       = 1
      JOIN dbo.FSAllowedSlot sl WITH (NOLOCK) ON sl.fsSectionId     = fs.fsSectionId
                                             AND sl.isPrimary       = 1
      JOIN dbo.FSSlotRow     sr WITH (NOLOCK) ON sr.fsAllowedSlotId = sl.fsAllowedSlotId
                                             AND sr.isPrimary       = 1
      JOIN dbo.FSAllowedRow  ar WITH (NOLOCK) ON ar.fsAllowedRowId  = sr.fsAllowedRowId
                                             AND ar.isPrimary       = 1
      WHERE d.displayLabel IN (N'生命徵象及治療紀錄')
        AND ar.conceptId   = i.conceptId
  )
  ORDER BY terseLabel;