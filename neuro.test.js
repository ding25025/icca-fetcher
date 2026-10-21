'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const neuro = require('./neuro');

const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';

test('exported intervention JSON round-trips as a unique ID list', () => {
  const interventions = neuro.indexInterventions([
    { interventionId: ID_A, terseLabel: '項目 A', sectionLabel: 'ECMO #1', documentLabel: '表單 X' },
    { interventionId: ID_A, terseLabel: '不應覆蓋', sectionLabel: 'ECMO #2', documentLabel: '表單 X' },
    { interventionId: ID_A, terseLabel: null, sectionLabel: 'ECMO #1', documentLabel: null },
    { interventionId: ID_B, terseLabel: null },
  ]);
  const payload = neuro.interventionIdsJson(interventions, 'CISPrimaryDB');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icca-neuro-'));
  const file = path.join(dir, 'interventions.json');
  try {
    fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
    assert.equal(payload.primaryDatabase, 'CISPrimaryDB');
    assert.equal(payload.count, 2);
    assert.equal(payload.interventions.length, 2);
    // 同一個 ID 掛在兩個區段：區段名去重相接、表單名只留一份，terseLabel 以第一次為準
    assert.deepEqual(payload.interventions[0], {
      interventionId: ID_A, terseLabel: '項目 A', sectionLabel: 'ECMO #1; ECMO #2', documentLabel: '表單 X',
    });
    assert.deepEqual(payload.interventions[1], {
      interventionId: ID_B, terseLabel: null, sectionLabel: null, documentLabel: null,
    });
    assert.deepEqual(neuro.loadIdsFile(file), {
      ids: [ID_A, ID_B],
      labels: { [ID_A]: '項目 A', [ID_B]: null },
      sections: { [ID_A]: 'ECMO #1; ECMO #2' },
      documents: { [ID_A]: '表單 X' },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSection picks the one section the descriptor instance name points at', () => {
  const list = 'ECMO #1; ECMO #2; ECMO #3; HeartMate II; HeartMate III; HeartWare; LVAD; RVAD';
  assert.equal(neuro.resolveSection(list, 'Pump Speed (#1)'), 'ECMO #1');
  assert.equal(neuro.resolveSection(list, 'Pump Speed (#3)'), 'ECMO #3');
  assert.equal(neuro.resolveSection(list, 'Pump Speed (LVAD)'), 'LVAD');
  assert.equal(neuro.resolveSection(list, 'Pump Speed (ECMO #2)'), 'ECMO #2');
  // 對不到、對到不只一個、沒有 descriptor：維持整串，不猜
  assert.equal(neuro.resolveSection(list, 'Pump Speed (HM)'), list);
  assert.equal(neuro.resolveSection(list, 'Pump Speed (VAD)'), list);
  assert.equal(neuro.resolveSection(list, null), list);
  // 只有一個區段的項目不看 descriptor
  assert.equal(neuro.resolveSection('Intake & Output', 'Pump Speed (#1)'), 'Intake & Output');
  assert.equal(neuro.resolveSection(null, 'Pump Speed (#1)'), null);
});

test('every instance name seen in production (2026-10-21) resolves to exactly one section', () => {
  const list = 'ECMO #1; ECMO #2; ECMO #3; HeartMate II; HeartMate III; HeartWare; LVAD; RVAD';
  const expect = { '#1': 'ECMO #1', '#2': 'ECMO #2', '#3': 'ECMO #3', 'HeartMate II': 'HeartMate II',
    'HeartMate III': 'HeartMate III', HeartWare: 'HeartWare', LVAD: 'LVAD', RVAD: 'RVAD' };
  for (const item of ['Pump Speed', 'Blood Flow (L/min)', 'Gas Flow (L/min)', 'FiO2', 'Pulse Index', 'Pump Power']) {
    for (const [suffix, section] of Object.entries(expect)) {
      assert.equal(neuro.resolveSection(list, `${item} (${suffix})`), section, `${item} (${suffix})`);
    }
  }
  // Pulse Index / Pump Power 只掛在 HeartMate 兩個區段，候選清單較短也要對得到
  assert.equal(neuro.resolveSection('HeartMate II; HeartMate III', 'Pulse Index (HeartMate III)'), 'HeartMate III');
});

test('neuro.interventionIdsFile skips the discovery SQL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icca-neuro-'));
  const file = path.join(dir, 'interventions.json');
  const config = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ interventions: [{ interventionId: ID_A, terseLabel: '項目 A' }] }), 'utf8');
    fs.writeFileSync(config, JSON.stringify({
      databases: [{ name: 'primary', connection: { server: 'db.example.test', database: 'CISPrimaryDB' } }],
      neuro: { interventionIdsFile: file },
    }), 'utf8');
    const prep = neuro.prepare({ config });
    assert.equal(prep.idsFile, file);
    assert.equal(prep.intSql, '');
    assert.deepEqual(prep.idsFromFile.ids, [ID_A]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON list is not re-scanned line by line, so a GUID inside a label is not a second ID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icca-neuro-'));
  const file = path.join(dir, 'interventions.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      interventions: [{ interventionId: ID_A, terseLabel: `備註 ${ID_B}` }],
    }, null, 2), 'utf8');
    assert.deepEqual(neuro.loadIdsFile(file), {
      ids: [ID_A],
      labels: { [ID_A]: `備註 ${ID_B}` },
      sections: {},
      documents: {},
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON without a recognised list is rejected instead of silently scanned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icca-neuro-'));
  const file = path.join(dir, 'interventions.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ note: ID_A }), 'utf8');
    assert.throws(() => neuro.loadIdsFile(file), /interventions/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plain text list still parses GUID plus label per line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icca-neuro-'));
  const file = path.join(dir, 'ids.txt');
  try {
    fs.writeFileSync(file, `# 註解\n${ID_A}, 昏迷指數\n${ID_B}\n${ID_A}\t重複\n`, 'utf8');
    assert.deepEqual(neuro.loadIdsFile(file), {
      ids: [ID_A, ID_B],
      labels: { [ID_A]: '昏迷指數', [ID_B]: null },
      sections: {},
      documents: {},
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
