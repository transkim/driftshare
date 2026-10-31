'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hub, sanitizeFileName } = require('../src/hub');

let hub, base, tmp;
const phone = 'phone_test_123';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-'));
  hub = new Hub({ port: 0, host: '127.0.0.1', dataDir: path.join(tmp, 'data'), downloadDir: path.join(tmp, 'dl') });
  await hub.load();
  await hub.start();
  base = `http://127.0.0.1:${hub.port}`;
});
after(() => hub.stop());

const q = (k, d) => `k=${encodeURIComponent(k)}&d=${d}`;

test('rejects wrong code', async () => {
  const r = await fetch(`${base}/api/hello?${q('WRONG1', phone)}`);
  assert.strictEqual(r.status, 401);
});

test('phone pairs, PC sees it, messages flow both ways', async () => {
  const hello = await (await fetch(`${base}/api/hello?${q(hub.pairCode.toLowerCase(), phone)}&name=Pixel`)).json();
  assert.strictEqual(hello.isLocal, false);
  assert.strictEqual(hello.pairing, undefined, 'phones never see pairing info');
  const pc = await (await fetch(`${base}/api/hello?${q(hub.localKey, 'hub')}`)).json();
  assert.strictEqual(pc.isLocal, true);
  assert.ok(pc.devices.some((d) => d.id === phone && d.name === 'Pixel'));

  await fetch(`${base}/api/message?${q(hub.pairCode, phone)}`, { method: 'POST', body: JSON.stringify({ text: 'hi pc' }) });
  await fetch(`${base}/api/message?${q(hub.localKey, 'hub')}`, { method: 'POST', body: JSON.stringify({ text: 'hi phone', to: phone }) });
  const h = await (await fetch(`${base}/api/hello?${q(hub.pairCode, phone)}`)).json();
  assert.deepStrictEqual(h.messages.map((m) => m.text), ['hi pc', 'hi phone']);
});

test('phone upload lands in download folder and can be downloaded with ranges', async () => {
  const data = Buffer.from('0123456789'.repeat(1000));
  const r = await fetch(`${base}/api/upload?${q(hub.pairCode, phone)}&name=${encodeURIComponent('../../evil.txt')}`, { method: 'POST', body: data });
  const msg = await r.json();
  assert.strictEqual(msg.name, 'evil.txt');
  assert.ok(fs.existsSync(path.join(tmp, 'dl', 'evil.txt')));
  const again = await (await fetch(`${base}/api/upload?${q(hub.pairCode, phone)}&name=evil.txt`, { method: 'POST', body: 'x' })).json();
  assert.strictEqual(again.name, 'evil (1).txt');
  const part = await fetch(`${base}/api/file/${msg.fileId}?${q(hub.pairCode, phone)}`, { headers: { Range: 'bytes=10-19' } });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(await part.text(), '0123456789');
});

test('PC shares a local file without copying; other phones cannot read it', async () => {
  const src = path.join(tmp, 'photo.jpg');
  fs.writeFileSync(src, 'jpegdata');
  const [msg] = await (await fetch(`${base}/api/share-local?${q(hub.localKey, 'hub')}`, { method: 'POST', body: JSON.stringify({ to: phone, paths: [src] }) })).json();
  const got = await fetch(`${base}/api/file/${msg.fileId}?${q(hub.pairCode, phone)}`);
  assert.strictEqual(await got.text(), 'jpegdata');
  const other = await fetch(`${base}/api/file/${msg.fileId}?${q(hub.pairCode, 'someone_else_1')}`);
  assert.strictEqual(other.status, 404);
  const sneaky = await fetch(`${base}/api/share-local?${q(hub.pairCode, phone)}`, { method: 'POST', body: JSON.stringify({ to: phone, paths: ['/etc/passwd'] }) });
  assert.strictEqual(sneaky.status, 404, 'phones cannot share PC paths');
});

test('file names are made safe for Windows', () => {
  assert.strictEqual(sanitizeFileName('a:b*c?.txt'), 'a_b_c_.txt');
  assert.strictEqual(sanitizeFileName('CON.txt'), '_CON.txt');
  assert.strictEqual(sanitizeFileName('..\\..\\x.exe'), 'x.exe');
});

test('new pairing code locks out old one', async () => {
  const old = hub.pairCode;
  await hub.resetPairKey();
  const r = await fetch(`${base}/api/hello?${q(old, phone)}`);
  assert.strictEqual(r.status, 401);
});
