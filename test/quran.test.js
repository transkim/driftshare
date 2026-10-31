const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'app', 'quran');
const sandbox = { window: {}, SakinaQuran: { loaded(n, d) { sandbox.loaded[n] = d; } }, loaded: {} };
vm.runInNewContext(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), sandbox);
const IDX = sandbox.window.SakinaQuranIndex;
for (let n = 1; n <= 114; n++) vm.runInNewContext(fs.readFileSync(path.join(dir, 's', String(n).padStart(3, '0') + '.js'), 'utf8'), sandbox);

test('114 surahs with 6236 ayahs in total', () => {
  assert.equal(IDX.surahs.length, 114);
  assert.equal(IDX.surahs.reduce((t, s) => t + s.ayahs, 0), 6236);
});

test('every surah file matches its index entry', () => {
  for (const s of IDX.surahs) {
    const d = sandbox.loaded[s.n];
    assert.ok(d, `surah ${s.n} not loaded`);
    for (const k of ['ar', 'tr', 'en']) {
      assert.equal(d[k].length, s.ayahs, `surah ${s.n} ${k} count`);
      d[k].forEach((t, i) => assert.ok(t && t.trim(), `surah ${s.n}:${i + 1} empty ${k}`));
    }
  }
});

test('basmala is not repeated inside ayah 1 (except Al-Fatiha)', () => {
  assert.ok(sandbox.loaded[1].ar[0].startsWith('بِسْمِ'));
  for (let n = 2; n <= 114; n++) assert.ok(!sandbox.loaded[n].ar[0].startsWith('بِسْمِ'), `surah ${n}`);
  assert.equal(sandbox.loaded[2].ar[0], 'الٓمٓ');
});

test('30 juz starting points', () => {
  assert.equal(IDX.juz.length, 30);
  assert.deepEqual(IDX.juz[0], [1, 1]);
  assert.deepEqual(IDX.juz[29], [78, 1]);
});
