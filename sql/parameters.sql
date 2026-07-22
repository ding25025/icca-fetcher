/*
 * 從 primary（ICCA_DB0x）查出生命徵象對應的 cdsParameterId。
 * 供 vitals.js --discover 使用；原始版本為 vitalsign3.sql。
 *
 * 回傳欄位必須包含 cdsParameterId（vitals.js 讀這個當過濾條件），
 * terseLabel 會被放進輸出每一筆的 _paramLabel。
 *
 * 注意 N'體溫(˚C)' 用的是 ˚ (U+02DA RING ABOVE)，不是 ° (U+00B0 DEGREE SIGN)，
 * 兩者長得幾乎一樣但比對不會相等。要改請直接從 SSMS 複製。
 */
SELECT DISTINCT
     i.terseLabel
    ,Attribute.propName
    ,CdsParameterMap.cdsParameterId
FROM Intervention i
JOIN InterventionItem ON i.interventionId                = InterventionItem.interventionId
                     AND InterventionItem.isPrimary      = 1
JOIN Attribute        ON InterventionItem.attributeId    = Attribute.attributeId
                     AND Attribute.isPrimary             = 1
JOIN CodedTerm        ON i.typeId                        = CodedTerm.codedTermId
                     AND CodedTerm.isPrimary             = 1
JOIN CdsParameterMap  ON CdsParameterMap.propName              = Attribute.propName
                     AND CdsParameterMap.interventionConceptId = i.conceptId
                     AND CdsParameterMap.isPrimary             = 1
--                   AND CdsParameterMap.cdsParameterId > 0
WHERE
      i.isPrimary = 1
  AND i.terseLabel IN (N'體溫(˚C)', N'HR', N'ABP', N'NBP', N'SpO2', N'ICP', N'PAP', N'CVP')
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
      WHERE d.displayLabel IN (N'生命徵象及治療紀錄', N'兒醫生命徵象及治療紀錄')
        AND ar.conceptId   = i.conceptId
  )
ORDER BY i.terseLabel
