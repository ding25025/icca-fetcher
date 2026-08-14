/* ============================================================================
   中介資料庫：把舊版 sink-schema.sql 建出來的表，改成現行規格的樣子
   ----------------------------------------------------------------------------
   對象     dbo.CDSUnvalidatedData（生命徵象）、dbo.CISData（神經評估與其他臨床紀錄）
   來源     docs/interim-db-schema.html §2、§3；目標結構＝ sql/sink-schema.sql
   可重跑   是。每一段都先檢查現況，已經是新的就跳過。

   改了什麼
     CDSUnvalidatedData
       measurementTime          → 改名 chartTime，型別 DATETIME2(0) → DATETIME
       （新增）                 → textValue NVARCHAR(256) NULL
       lifetimeNumber/terseLabel→ NVARCHAR(50) → NVARCHAR(32)
       storeTime / insertedAt   → DATETIME2 → DATETIME
       isDelete / updatedAt / changedAt → 移除（來源只寫不改，列寫進去就不會被動到）
       索引                     → 只留 PK 與 IX_*_storeTime（下游的水位線查詢）
     CISData
       isDelete                 → 改名 isDeleted（規格 §3 的欄名）
       主鍵                     → 拿掉，改成叢集索引（識別鍵 + storeTime）
                                  同一組識別鍵要放得下多個版本：改過或作廢都是多一列
       （新增）                 → rowHash BINARY(20)，既有的列在這裡補算
       chartTime / storeTime    → DATETIME2(0) → DATETIME（規格 §1：全表一種時間基準）
       lifetimeNumber           → NVARCHAR(50) → NVARCHAR(32)
       terseLabel               → NVARCHAR(100) → NVARCHAR(32)
       updatedAt / changedAt    → 移除（列寫進去就不會再被動到）
       索引                     → CX_CISData、IX_*_storeTime、IX_*_rowHash

   ⚠ 表裡還沒有正式資料的話，最省事的做法是直接砍掉重建：
       DROP TABLE dbo.CDSUnvalidatedData;
       -- 然後 node sink.js --init
     這份腳本是給「已經寫了資料、想留著」用的。

   跑之前建議先備份，或至少確認這兩張表目前沒有人在讀（下游還沒接）。
   ============================================================================ */

SET NOCOUNT ON;
SET XACT_ABORT ON;
-- CISData 有 PERSISTED 計算欄位與建在它上面的索引，動這張表需要 QUOTED_IDENTIFIER ON。
-- SSMS 預設就是 ON；用 sqlcmd 跑的話預設是 OFF，所以這裡明講（或加 sqlcmd 的 -I）。
SET QUOTED_IDENTIFIER ON;
GO

/* ---------------------------------------------------------------------------
   1. CDSUnvalidatedData
   --------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.CDSUnvalidatedData', N'U') IS NULL
BEGIN
  PRINT N'dbo.CDSUnvalidatedData 不存在 → 不必轉換，直接跑 node sink.js --init';
END
ELSE IF COL_LENGTH('dbo.CDSUnvalidatedData', 'chartTime') IS NOT NULL
     AND COL_LENGTH('dbo.CDSUnvalidatedData', 'textValue') IS NOT NULL
     AND COL_LENGTH('dbo.CDSUnvalidatedData', 'isDelete')  IS NULL
BEGIN
  PRINT N'dbo.CDSUnvalidatedData 已經是新結構 → 跳過';
END
ELSE
BEGIN
  PRINT N'--- 轉換 dbo.CDSUnvalidatedData ---';

  -- 1a. 縮短欄位長度前先確認沒有值會被截掉。有的話就停下來，不要默默砍資料。
  DECLARE @tooLong INT;
  SELECT @tooLong = COUNT(*)
  FROM   dbo.CDSUnvalidatedData
  WHERE  LEN([lifetimeNumber]) > 32 OR LEN([terseLabel]) > 32;

  IF @tooLong > 0
  BEGIN
    RAISERROR(N'有 %d 列的 lifetimeNumber 或 terseLabel 超過 32 個字，縮短欄位會截斷資料。先確認那些值是什麼再決定怎麼處理。', 16, 1, @tooLong);
    RETURN;
  END

  -- 1b. 先拆掉會擋住改欄位的東西。順序有講究：索引要在計算欄位之前砍
  --     （IX_*_changed 建在 changedAt 上，欄位還被索引引用時砍不掉）。
  IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CDSUnvalidatedData_time'      AND object_id = OBJECT_ID('dbo.CDSUnvalidatedData'))
    DROP INDEX [IX_CDSUnvalidatedData_time]    ON dbo.CDSUnvalidatedData;
  IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CDSUnvalidatedData_patient'   AND object_id = OBJECT_ID('dbo.CDSUnvalidatedData'))
    DROP INDEX [IX_CDSUnvalidatedData_patient] ON dbo.CDSUnvalidatedData;
  IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CDSUnvalidatedData_changed'   AND object_id = OBJECT_ID('dbo.CDSUnvalidatedData'))
    DROP INDEX [IX_CDSUnvalidatedData_changed] ON dbo.CDSUnvalidatedData;

  IF COL_LENGTH('dbo.CDSUnvalidatedData', 'changedAt') IS NOT NULL
    ALTER TABLE dbo.CDSUnvalidatedData DROP COLUMN [changedAt];

  DECLARE @sql NVARCHAR(MAX), @name SYSNAME;

  SELECT @name = kc.name FROM sys.key_constraints kc
  WHERE  kc.parent_object_id = OBJECT_ID('dbo.CDSUnvalidatedData') AND kc.type = 'PK';
  IF @name IS NOT NULL
  BEGIN
    SET @sql = N'ALTER TABLE dbo.CDSUnvalidatedData DROP CONSTRAINT ' + QUOTENAME(@name) + N';';
    EXEC sp_executesql @sql;
  END

  -- 預設值條件約束會擋住「砍欄位」與「改型別」，isDelete 與 insertedAt 兩個都要先拆。
  -- 名字不一定是 DF_<表>_<欄> （建立當下沒指定名字的話是亂數），所以照欄位查出真正的名字。
  DECLARE @dc TABLE (name SYSNAME);
  INSERT INTO @dc (name)
  SELECT dc.name FROM sys.default_constraints dc
  JOIN   sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
  WHERE  dc.parent_object_id = OBJECT_ID('dbo.CDSUnvalidatedData') AND c.name IN ('isDelete', 'insertedAt');

  WHILE EXISTS (SELECT 1 FROM @dc)
  BEGIN
    SELECT TOP 1 @name = name FROM @dc;
    SET @sql = N'ALTER TABLE dbo.CDSUnvalidatedData DROP CONSTRAINT ' + QUOTENAME(@name) + N';';
    EXEC sp_executesql @sql;
    DELETE FROM @dc WHERE name = @name;
  END

  IF COL_LENGTH('dbo.CDSUnvalidatedData', 'isDelete')  IS NOT NULL
    ALTER TABLE dbo.CDSUnvalidatedData DROP COLUMN [isDelete];
  IF COL_LENGTH('dbo.CDSUnvalidatedData', 'updatedAt') IS NOT NULL
    ALTER TABLE dbo.CDSUnvalidatedData DROP COLUMN [updatedAt];

  -- 1c. 改名：ICCA 來源端叫 measurementTime，中介庫跟 CISData 對齊叫 chartTime
  IF COL_LENGTH('dbo.CDSUnvalidatedData', 'measurementTime') IS NOT NULL
     AND COL_LENGTH('dbo.CDSUnvalidatedData', 'chartTime') IS NULL
    EXEC sp_rename N'dbo.CDSUnvalidatedData.measurementTime', N'chartTime', N'COLUMN';

  -- 1d. 補上非數值的量測值
  IF COL_LENGTH('dbo.CDSUnvalidatedData', 'textValue') IS NULL
    ALTER TABLE dbo.CDSUnvalidatedData ADD [textValue] NVARCHAR(256) NULL;

  -- 1e. 型別對齊規格（DATETIME2 → DATETIME 只會少掉用不到的精度，值不變）
  ALTER TABLE dbo.CDSUnvalidatedData ALTER COLUMN [lifetimeNumber] NVARCHAR(32) NOT NULL;
  ALTER TABLE dbo.CDSUnvalidatedData ALTER COLUMN [terseLabel]     NVARCHAR(32) NOT NULL;
  ALTER TABLE dbo.CDSUnvalidatedData ALTER COLUMN [propName]       NVARCHAR(64) NOT NULL;
  ALTER TABLE dbo.CDSUnvalidatedData ALTER COLUMN [chartTime]      DATETIME     NOT NULL;
  ALTER TABLE dbo.CDSUnvalidatedData ALTER COLUMN [storeTime]      DATETIME     NULL;
  ALTER TABLE dbo.CDSUnvalidatedData ALTER COLUMN [insertedAt]     DATETIME     NOT NULL;

  -- 剛才為了改型別拆掉的預設值裝回去（新列沒帶 insertedAt 時由 DB 蓋時間戳）
  IF NOT EXISTS (
        SELECT 1 FROM sys.default_constraints dc
        JOIN   sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
        WHERE  dc.parent_object_id = OBJECT_ID('dbo.CDSUnvalidatedData') AND c.name = 'insertedAt')
    ALTER TABLE dbo.CDSUnvalidatedData
      ADD CONSTRAINT [DF_CDSUnvalidatedData_insertedAt] DEFAULT (SYSDATETIME()) FOR [insertedAt];

  -- 1f. 主鍵與索引重建。DATETIME 的精度比 DATETIME2(0) 粗（3.33 毫秒），
  --     理論上不會讓原本不同的兩列變成同一把鑰匙（chartTime 都是整秒），
  --     但真的撞上就會建不起來——那表示資料本身有問題，值得停下來看。
  ALTER TABLE dbo.CDSUnvalidatedData
    ADD CONSTRAINT [PK_CDSUnvalidatedData]
    PRIMARY KEY CLUSTERED ([lifetimeNumber], [terseLabel], [propName], [chartTime]);

  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CDSUnvalidatedData_storeTime' AND object_id = OBJECT_ID('dbo.CDSUnvalidatedData'))
    CREATE NONCLUSTERED INDEX [IX_CDSUnvalidatedData_storeTime] ON dbo.CDSUnvalidatedData ([storeTime]);

  PRINT N'dbo.CDSUnvalidatedData 轉換完成';
END
GO

/* ---------------------------------------------------------------------------
   2. CISData：改成「同一組識別鍵放得下多個版本」（規格 §3）

   舊的是「一組識別鍵一列、就地更新」：護理師改過紀錄就把那一列蓋掉，改動前的內容
   查不回來。新的是只新增——改過或作廢都是**多一列**，舊的原封不動留著，
   靠 storeTime 分先後，取現值就是最大的那一列。

   所以主鍵要拿掉（有主鍵就放不下第二個版本），改成一般叢集索引；
   去重改看內容雜湊 rowHash（內容一模一樣就不寫），既有的列在這裡一起補算。
   --------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.CISData', N'U') IS NULL
BEGIN
  PRINT N'dbo.CISData 不存在 → 不必轉換，直接跑 node sink.js --init';
END
ELSE IF COL_LENGTH('dbo.CISData', 'rowHash') IS NOT NULL
     AND COL_LENGTH('dbo.CISData', 'changedAt') IS NULL
BEGIN
  PRINT N'dbo.CISData 已經是新結構 → 跳過';
END
ELSE
BEGIN
  PRINT N'--- 轉換 dbo.CISData ---';

  DECLARE @sql2 NVARCHAR(MAX), @name2 SYSNAME;

  -- 2a. 欄名對齊規格
  IF COL_LENGTH('dbo.CISData', 'isDelete') IS NOT NULL AND COL_LENGTH('dbo.CISData', 'isDeleted') IS NULL
    EXEC sp_rename N'dbo.CISData.isDelete', N'isDeleted', N'COLUMN';

  -- 2b. 索引要在計算欄位之前砍（IX_*_changed 建在 changedAt 上）
  IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CISData_time'    AND object_id = OBJECT_ID('dbo.CISData'))
    DROP INDEX [IX_CISData_time]    ON dbo.CISData;
  IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CISData_patient' AND object_id = OBJECT_ID('dbo.CISData'))
    DROP INDEX [IX_CISData_patient] ON dbo.CISData;
  IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CISData_changed' AND object_id = OBJECT_ID('dbo.CISData'))
    DROP INDEX [IX_CISData_changed] ON dbo.CISData;

  IF COL_LENGTH('dbo.CISData', 'changedAt') IS NOT NULL
    ALTER TABLE dbo.CISData DROP COLUMN [changedAt];
  IF COL_LENGTH('dbo.CISData', 'updatedAt') IS NOT NULL
    ALTER TABLE dbo.CISData DROP COLUMN [updatedAt];

  -- 2c. 主鍵拿掉——同一組識別鍵底下要放得下多列（先後版本）
  SELECT @name2 = kc.name FROM sys.key_constraints kc
  WHERE  kc.parent_object_id = OBJECT_ID('dbo.CISData') AND kc.type = 'PK';
  IF @name2 IS NOT NULL
  BEGIN
    SET @sql2 = N'ALTER TABLE dbo.CISData DROP CONSTRAINT ' + QUOTENAME(@name2) + N';';
    EXEC sp_executesql @sql2;
  END

  -- 2d. insertedAt 改成 DATETIME（預設值會擋住型別變更，先拆再裝回去）
  SET @name2 = NULL;
  SELECT @name2 = dc.name FROM sys.default_constraints dc
  JOIN   sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
  WHERE  dc.parent_object_id = OBJECT_ID('dbo.CISData') AND c.name = 'insertedAt';
  IF @name2 IS NOT NULL
  BEGIN
    SET @sql2 = N'ALTER TABLE dbo.CISData DROP CONSTRAINT ' + QUOTENAME(@name2) + N';';
    EXEC sp_executesql @sql2;
  END
  ALTER TABLE dbo.CISData ALTER COLUMN [insertedAt] DATETIME NOT NULL;
  IF NOT EXISTS (
        SELECT 1 FROM sys.default_constraints dc
        JOIN   sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
        WHERE  dc.parent_object_id = OBJECT_ID('dbo.CISData') AND c.name = 'insertedAt')
    ALTER TABLE dbo.CISData
      ADD CONSTRAINT [DF_CISData_insertedAt] DEFAULT (SYSDATETIME()) FOR [insertedAt];

  -- 2e. 型別對齊規格 §1／§3：兩張表的臨床時間與 storeTime 都是 DATETIME。
  --     （DATETIME2(0) → DATETIME 只是少掉用不到的精度，值不變；chartTime 是識別鍵，
  --     所以要等主鍵拆掉之後才改得動——上面 2c 已經拆了。）
  --     lifetimeNumber 縮到 32 之前先確認沒有值會被截掉。
  DECLARE @tooLong2 INT;
  SELECT @tooLong2 = COUNT(*) FROM dbo.CISData
  WHERE  LEN([lifetimeNumber]) > 32 OR LEN([terseLabel]) > 32;
  IF @tooLong2 > 0
  BEGIN
    RAISERROR(N'有 %d 列的 lifetimeNumber 或 terseLabel 超過 32 個字，縮短欄位會截斷資料。先確認那些值是什麼再決定怎麼處理。', 16, 1, @tooLong2);
    RETURN;
  END

  ALTER TABLE dbo.CISData ALTER COLUMN [chartTime]      DATETIME     NOT NULL;
  ALTER TABLE dbo.CISData ALTER COLUMN [storeTime]      DATETIME     NULL;
  ALTER TABLE dbo.CISData ALTER COLUMN [lifetimeNumber] NVARCHAR(32) NOT NULL;
  ALTER TABLE dbo.CISData ALTER COLUMN [terseLabel]     NVARCHAR(32) NULL;

  -- 2f. 內容雜湊：先加成可為空，補算既有的列，再鎖成 NOT NULL。
  --     這個算式必須跟 sink.js 的 rowHashOf 完全一致——欄位值以 NCHAR(31) 相接、
  --     null 當空字串、時間取到秒（19 個字）、以 UTF-16LE 編碼後 SHA-1。
  --     算不出同一個值的話，既有的每一列下次都會被當成「新內容」再寫一次。
  IF COL_LENGTH('dbo.CISData', 'rowHash') IS NULL
    ALTER TABLE dbo.CISData ADD [rowHash] BINARY(20) NULL;
END
GO

IF OBJECT_ID(N'dbo.CISData', N'U') IS NOT NULL AND COL_LENGTH('dbo.CISData', 'rowHash') IS NOT NULL
BEGIN
  UPDATE dbo.CISData
  SET    [rowHash] = HASHBYTES('SHA1', CONCAT_WS(NCHAR(31),
           ISNULL([ptEncounterId], N''),
           ISNULL([interventionId], N''),
           ISNULL(CONVERT(NVARCHAR(19), [chartTime], 120), N''),
           ISNULL([lifetimeNumber], N''),
           ISNULL([terseLabel], N''),
           ISNULL([terseForm], N''),
           ISNULL([verboseForm], N''),
           ISNULL(CONVERT(NVARCHAR(19), [storeTime], 120), N''),
           ISNULL(CONVERT(NVARCHAR(1), [isDeleted]), N'')))
  WHERE  [rowHash] IS NULL;

  IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.CISData') AND name = 'rowHash' AND is_nullable = 1)
    ALTER TABLE dbo.CISData ALTER COLUMN [rowHash] BINARY(20) NOT NULL;

  -- 2g. 索引重建：叢集索引擺識別鍵 + storeTime（「取最新版本」與「看完整歷史」都是一次 seek），
  --     rowHash 給寫入時的「這個內容寫過了嗎」，storeTime 給下游的增量讀取。
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'CX_CISData' AND object_id = OBJECT_ID('dbo.CISData'))
    CREATE CLUSTERED INDEX [CX_CISData] ON dbo.CISData ([ptEncounterId], [interventionId], [chartTime], [storeTime]);
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CISData_storeTime' AND object_id = OBJECT_ID('dbo.CISData'))
    CREATE NONCLUSTERED INDEX [IX_CISData_storeTime] ON dbo.CISData ([storeTime]);
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CISData_rowHash' AND object_id = OBJECT_ID('dbo.CISData'))
    CREATE NONCLUSTERED INDEX [IX_CISData_rowHash] ON dbo.CISData ([rowHash]);

  PRINT N'dbo.CISData 轉換完成';
END
GO

/* ---------------------------------------------------------------------------
   3. 驗收：兩張表現在長什麼樣
   --------------------------------------------------------------------------- */
SELECT  t.name AS [表], c.column_id AS [#], c.name AS [欄位],
        ty.name + CASE WHEN ty.name LIKE 'nvarchar%' THEN '(' + CAST(c.max_length / 2 AS VARCHAR(10)) + ')' ELSE '' END AS [型別],
        CASE c.is_nullable WHEN 1 THEN 'NULL' ELSE 'NOT NULL' END AS [可為空]
FROM    sys.columns c
JOIN    sys.tables  t  ON t.object_id = c.object_id
JOIN    sys.types   ty ON ty.user_type_id = c.user_type_id
WHERE   t.name IN ('CDSUnvalidatedData', 'CISData')
ORDER   BY t.name, c.column_id;

SELECT  t.name AS [表], i.name AS [索引], i.type_desc AS [種類], i.is_primary_key AS [是主鍵]
FROM    sys.indexes i
JOIN    sys.tables  t ON t.object_id = i.object_id
WHERE   t.name IN ('CDSUnvalidatedData', 'CISData') AND i.name IS NOT NULL
ORDER   BY t.name, i.is_primary_key DESC, i.name;
GO
