'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sink = require('./sink');

const ENC = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
const INT = 'BF2F01A2-FF39-4396-919C-1BAAD6A1C0AE';

const baseRow = {
  ptEncounterId: ENC,
  interventionId: INT,
  chartTime: '2026-10-20 08:00:00',
  lifetimeNumber: 'A123456',
  terseLabel: 'Pump Speed',
  terseForm: '3000',
  verboseForm: '3000 rpm',
  storeTime: '2026-10-20 08:03:12',
  isDeleted: 0,
};

test('sectionLabel / documentLabel are written but do not take part in rowHash', () => {
  const spec = sink.NEURO_SPEC;
  const stats = {};
  const bare = sink.valuesOf(spec, baseRow, stats);
  const labelled = sink.valuesOf(spec, {
    ...baseRow,
    sectionLabel: 'ECMO #1; ECMO #2; ECMO #3; HeartMate II; HeartMate III; HeartWare',
    documentLabel: '體外維生系統及生命徵象紀錄',
  }, stats);

  // 兩欄確實會進 INSERT（值在 valuesOf 的輸出裡）
  const at = (name) => spec.columns.findIndex((c) => c.name === name);
  assert.equal(bare[at('sectionLabel')], null);
  assert.equal(labelled[at('sectionLabel')], 'ECMO #1; ECMO #2; ECMO #3; HeartMate II; HeartMate III; HeartWare');
  assert.equal(labelled[at('documentLabel')], '體外維生系統及生命徵象紀錄');

  // 但雜湊一樣：加欄之前寫進去的列，加欄之後不會被當成新內容再寫一次
  assert.deepEqual(sink.rowHashOf(spec, labelled), sink.rowHashOf(spec, bare));

  // 內容真的變了雜湊才變
  const edited = sink.valuesOf(spec, { ...baseRow, terseForm: '3100' }, stats);
  assert.notDeepEqual(sink.rowHashOf(spec, edited), sink.rowHashOf(spec, bare));
});

test('flattenNeuro carries sectionLabel / documentLabel and leaves them NULL when absent', () => {
  const patient = { lifetimeNumber: 'A123456', bed: 'ICU-1', records: [
    { interventionId: INT, terseLabel: 'Pump Speed', sectionLabel: 'ECMO #1', documentLabel: '體外維生系統及生命徵象紀錄',
      terseForm: '3000', verboseForm: '3000 rpm', storeTime: baseRow.storeTime, chartTime: baseRow.chartTime, isDeleted: 0 },
    // 藥物醫囑的列：不在 interventionId 清單裡，沒有區段／表單名
    { interventionId: INT, terseLabel: 'Fentanyl', terseForm: '1', verboseForm: '1 mL/hr',
      storeTime: baseRow.storeTime, chartTime: baseRow.chartTime, isDeleted: 0 },
  ] };
  Object.defineProperty(patient, '_encounterId', { value: ENC, enumerable: false });

  const flat = sink.flattenNeuro([patient]);
  assert.equal(flat.length, 2);
  assert.equal(flat[0].sectionLabel, 'ECMO #1');
  assert.equal(flat[0].documentLabel, '體外維生系統及生命徵象紀錄');
  assert.equal(flat[1].sectionLabel, null);
  assert.equal(flat[1].documentLabel, null);
});

test('CREATE TABLE for CISData includes the two label columns', () => {
  const d = sink.ddlFor(sink.NEURO_SPEC, { schema: 'dbo', neuroTable: 'CISData', vitalsTable: 'CDSUnvalidatedData' });
  assert.match(d.create, /\[sectionLabel\] NVARCHAR\(256\) NULL/);
  assert.match(d.create, /\[documentLabel\] NVARCHAR\(128\) NULL/);
});
