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
    { interventionId: ID_A, terseLabel: '項目 A' },
    { interventionId: ID_A, terseLabel: '不應覆蓋' },
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
    assert.deepEqual(neuro.loadIdsFile(file), {
      ids: [ID_A, ID_B],
      labels: { [ID_A]: '項目 A', [ID_B]: null },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
