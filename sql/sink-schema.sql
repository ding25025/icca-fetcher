-- vitals：[dbo].[CDSUnvalidatedData]
IF OBJECT_ID(N'[dbo].[CDSUnvalidatedData]', N'U') IS NULL
BEGIN
  CREATE TABLE [dbo].[CDSUnvalidatedData] (
    [lifetimeNumber] NVARCHAR(32) NOT NULL,
    [terseLabel] NVARCHAR(32) NOT NULL,
    [propName] NVARCHAR(64) NOT NULL,
    [chartTime] DATETIME NOT NULL,
    [numericValue] FLOAT NULL,
    [textValue] NVARCHAR(256) NULL,
    [storeTime] DATETIME NULL,
    [insertedAt] DATETIME NOT NULL CONSTRAINT [DF_CDSUnvalidatedData_insertedAt] DEFAULT (SYSDATETIME()),
    CONSTRAINT [PK_CDSUnvalidatedData] PRIMARY KEY CLUSTERED ([lifetimeNumber], [terseLabel], [propName], [chartTime])
  );
  CREATE NONCLUSTERED INDEX [IX_CDSUnvalidatedData_storeTime] ON [dbo].[CDSUnvalidatedData] ([storeTime]);
END
GO

-- neuro：[dbo].[CISData]
IF OBJECT_ID(N'[dbo].[CISData]', N'U') IS NULL
BEGIN
  CREATE TABLE [dbo].[CISData] (
    [ptEncounterId] NVARCHAR(36) NOT NULL,
    [interventionId] NVARCHAR(36) NOT NULL,
    [chartTime] DATETIME NOT NULL,
    [lifetimeNumber] NVARCHAR(32) NOT NULL,
    [terseLabel] NVARCHAR(32) NULL,
    [terseForm] NVARCHAR(32) NULL,
    [verboseForm] NVARCHAR(256) NULL,
    [storeTime] DATETIME NULL,
    [isDeleted] BIT NOT NULL CONSTRAINT [DF_CISData_isDeleted] DEFAULT (0),
    [rowHash] BINARY(20) NOT NULL,
    [insertedAt] DATETIME NOT NULL CONSTRAINT [DF_CISData_insertedAt] DEFAULT (SYSDATETIME())
  );
  CREATE CLUSTERED INDEX [CX_CISData] ON [dbo].[CISData] ([ptEncounterId], [interventionId], [chartTime], [storeTime]);
  CREATE NONCLUSTERED INDEX [IX_CISData_storeTime] ON [dbo].[CISData] ([storeTime]);
  CREATE NONCLUSTERED INDEX [IX_CISData_rowHash] ON [dbo].[CISData] ([rowHash]);
END
GO

