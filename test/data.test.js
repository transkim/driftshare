const test = require('node:test');
const assert = require('node:assert');
const { categories, duas, dhikr } = require('../app/js/duas.js');

test('every dua is complete and in a known category', () => {
  const cats = new Set(categories.map((c) => c.id));
  const ids = new Set();
  for (const d of duas) {
    assert.ok(!ids.has(d.id), `duplicate id ${d.id}`);
    ids.add(d.id);
    assert.ok(cats.has(d.cat), `${d.id} has unknown category ${d.cat}`);
    for (const k of ['title', 'ar', 'tr', 'en', 'src']) assert.ok(d[k] && d[k].trim(), `${d.id} missing ${k}`);
    assert.match(d.ar, /[؀-ۿ]/, `${d.id} Arabic text has no Arabic letters`);
    assert.ok(Number.isInteger(d.repeat) && d.repeat >= 1, `${d.id} repeat`);
  }
});

test('every category has at least one dua', () => {
  for (const c of categories) assert.ok(duas.some((d) => d.cat === c.id), `${c.id} is empty`);
});

test('dhikr entries have targets', () => {
  for (const z of dhikr) assert.ok(z.ar && z.tr && z.en && z.target > 0, z.id);
});
