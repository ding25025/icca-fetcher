/*
 * 神經系統評估對應的 interventionId + terseLabel（primary / CISPrimaryDB）。
 *
 * 供 neuro.js 使用：interventionId 當 PtIntervention 的過濾條件，terseLabel 會原名
 * 併進輸出的每一筆（HR/GCS 這類臨床項目名稱）。等同 vitals.js 的 --discover。
 *
 * 篩選邏輯：i.terseLabel 落在下面這串神經評估項目，且該 intervention 確實出現在
 *   Document「神經學檢查及昏迷評估紀錄」的「神經系統病人生命徵象」區段裡
 *   （EXISTS 那段，用 conceptId 對回 Intervention）。這樣才不會把同名但屬於別張
 *   表單的 intervention 一起撈進來。
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
        N'昏迷指數', N'睜眼反應', N'語言反應', N'運動反應',
        N'瞳孔大小(右/左)', N'瞳孔對光反應(右/左)', N'眼球活動(右/左)',
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
      WHERE d.displayLabel IN (N'神經學檢查及昏迷評估紀錄', N'神經學檢查及昏迷評估紀錄(小於兩歲)')
        AND ar.conceptId   = i.conceptId
  )
ORDER BY i.terseLabel;
