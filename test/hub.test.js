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

test('phones send to each other through the PC, privately', async () => {
  const a = 'phone_alpha_1';
  const b = 'phone_bravo_2';
  const c = 'phone_charlie_3';
  for (const [id, name] of [[a, 'Alpha'], [b, 'Bravo'], [c, 'Charlie']]) {
    await fetch(`${base}/api/hello?${q(hub.pairCode, id)}&name=${name}`);
  }
  const helloA = await (await fetch(`${base}/api/hello?${q(hub.pairCode, a)}`)).json();
  assert.strictEqual(helloA.devices[0].id, 'hub', 'PC is listed first for phones');
  assert.ok(helloA.devices.some((d) => d.id === b));
  assert.ok(!helloA.devices.some((d) => d.id === a), 'a phone does not list itself');

  const toSelf = await fetch(`${base}/api/message?${q(hub.pairCode, a)}`, { method: 'POST', body: JSON.stringify({ text: 'me', to: a }) });
  assert.strictEqual(toSelf.status, 400);

  await fetch(`${base}/api/message?${q(hub.pairCode, a)}`, { method: 'POST', body: JSON.stringify({ text: 'hey bravo', to: b }) });
  const file = await (await fetch(`${base}/api/upload?${q(hub.pairCode, a)}&name=pic.jpg&to=${b}`, { method: 'POST', body: 'imagebytes' })).json();
  assert.strictEqual(file.to, b);
  assert.ok(!fs.existsSync(path.join(tmp, 'dl', 'pic.jpg')), 'relayed files stay out of the PC Downloads folder');
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'relay', 'pic.jpg')));

  const helloB = await (await fetch(`${base}/api/hello?${q(hub.pairCode, b)}`)).json();
  assert.ok(helloB.messages.some((m) => m.text === 'hey bravo'));
  assert.strictEqual(await (await fetch(`${base}/api/file/${file.fileId}?${q(hub.pairCode, b)}`)).text(), 'imagebytes');

  const helloC = await (await fetch(`${base}/api/hello?${q(hub.pairCode, c)}`)).json();
  assert.ok(!helloC.messages.some((m) => m.text === 'hey bravo'), 'other phones cannot see it');
  assert.strictEqual((await fetch(`${base}/api/file/${file.fileId}?${q(hub.pairCode, c)}`)).status, 404);
  const pc = await (await fetch(`${base}/api/hello?${q(hub.localKey, 'hub')}`)).json();
  assert.ok(!pc.messages.some((m) => m.text === 'hey bravo'), 'the PC screen only shows its own chats');
});

test('relayed files are removed after a week', async () => {
  const msg = await (await fetch(`${base}/api/upload?${q(hub.pairCode, 'phone_alpha_1')}&name=old.txt&to=phone_bravo_2`, { method: 'POST', body: 'x' })).json();
  hub.state.messages.find((m) => m.id === msg.id).ts -= 8 * 24 * 3600 * 1000;
  assert.ok((await hub.cleanRelay()) >= 1);
  assert.ok(!fs.existsSync(path.join(tmp, 'data', 'relay', 'old.txt')));
});

test('phone uploads a folder; it arrives as one item with its subfolders', async () => {
  const ph = 'phone_folder_1';
  await fetch(`${base}/api/hello?${q(hub.pairCode, ph)}&name=Folder`);
  const up = (rel, body) =>
    fetch(`${base}/api/upload?${q(hub.pairCode, ph)}&batch=batch_aaa111&kind=folder&name=${encodeURIComponent(rel.split('/').pop())}&rel=${encodeURIComponent(rel)}`, { method: 'POST', body });
  assert.strictEqual((await up('Holiday/a.jpg', 'A')).status, 200);
  assert.strictEqual((await up('Holiday/2024/../../../evil/b.jpg', 'B')).status, 200);
  assert.strictEqual((await up('Holiday/2024/c.jpg', 'C')).status, 200);
  const msg = await (await fetch(`${base}/api/batch-done?${q(hub.pairCode, ph)}`, { method: 'POST', body: JSON.stringify({ batch: 'batch_aaa111' }) })).json();
  assert.strictEqual(msg.type, 'bundle');
  assert.strictEqual(msg.kind, 'folder');
  assert.strictEqual(msg.name, 'Holiday');
  assert.strictEqual(msg.count, 3);
  assert.deepStrictEqual(msg.items.map((i) => i.rel).sort(), ['Holiday/2024/c.jpg', 'Holiday/2024/evil/b.jpg', 'Holiday/a.jpg']);
  assert.ok(fs.existsSync(path.join(tmp, 'dl', 'Holiday', '2024', 'c.jpg')));
  assert.ok(!fs.existsSync(path.join(tmp, 'evil')), 'no escaping the folder');

  // the same folder name again gets "Holiday (1)"
  await up('Holiday/x.txt', 'X'); // still the finished batch id -> new batch
  const again = await (await fetch(`${base}/api/batch-done?${q(hub.pairCode, ph)}`, { method: 'POST', body: JSON.stringify({ batch: 'batch_aaa111' }) })).json();
  assert.strictEqual(again.name, 'Holiday (1)');

  // single items and the whole folder as a zip
  const one = await fetch(`${base}/api/file/${msg.items[0].fileId}?${q(hub.pairCode, ph)}`);
  assert.strictEqual(one.status, 200);
  const zip = await fetch(`${base}/api/bundle/${msg.id}/zip?${q(hub.pairCode, ph)}`);
  assert.strictEqual(zip.status, 200);
  const buf = Buffer.from(await zip.arrayBuffer());
  assert.strictEqual(buf.readUInt32LE(0), 0x04034b50, 'starts like a zip');
  assert.ok(buf.includes(Buffer.from('Holiday/2024/c.jpg')));
  const other = await fetch(`${base}/api/bundle/${msg.id}/zip?${q(hub.pairCode, 'someone_else_9')}`);
  assert.strictEqual(other.status, 404);
});

test('several files picked together become one item; a lone file stays a file', async () => {
  const ph = 'phone_multi_1';
  await fetch(`${base}/api/hello?${q(hub.pairCode, ph)}&name=Multi`);
  for (const n of ['one.pdf', 'two.pdf', 'three.pdf']) {
    await fetch(`${base}/api/upload?${q(hub.pairCode, ph)}&batch=batch_bbb222&name=${n}`, { method: 'POST', body: n });
  }
  const msg = await (await fetch(`${base}/api/batch-done?${q(hub.pairCode, ph)}`, { method: 'POST', body: JSON.stringify({ batch: 'batch_bbb222' }) })).json();
  assert.strictEqual(msg.type, 'bundle');
  assert.strictEqual(msg.kind, 'files');
  assert.strictEqual(msg.name, '3 files');
  await fetch(`${base}/api/upload?${q(hub.pairCode, ph)}&batch=batch_ccc333&name=solo.txt`, { method: 'POST', body: 'x' });
  const solo = await (await fetch(`${base}/api/batch-done?${q(hub.pairCode, ph)}`, { method: 'POST', body: JSON.stringify({ batch: 'batch_ccc333' }) })).json();
  assert.strictEqual(solo.type, 'file');
  const thief = await fetch(`${base}/api/upload?${q(hub.pairCode, 'phone_thief_1')}&batch=batch_bbb999&name=a`, { method: 'POST', body: 'a' });
  assert.strictEqual(thief.status, 200);
  const steal = await fetch(`${base}/api/batch-done?${q(hub.pairCode, ph)}`, { method: 'POST', body: JSON.stringify({ batch: 'batch_bbb999' }) });
  assert.strictEqual(steal.status, 404, "can't finish someone else's batch");
});

test('PC shares a whole folder without copying it', async () => {
  const dir = path.join(tmp, 'Photos');
  fs.mkdirSync(path.join(dir, 'Trip'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.jpg'), 'a');
  fs.writeFileSync(path.join(dir, 'Trip', 'b.jpg'), 'bb');
  const [msg] = await (await fetch(`${base}/api/share-local?${q(hub.localKey, 'hub')}`, { method: 'POST', body: JSON.stringify({ to: phone, paths: [dir] }) })).json();
  assert.strictEqual(msg.kind, 'folder');
  assert.strictEqual(msg.name, 'Photos');
  assert.deepStrictEqual(msg.items.map((i) => i.rel).sort(), ['Photos/Trip/b.jpg', 'Photos/a.jpg']);
  assert.strictEqual(msg.size, 3);
  assert.ok(!JSON.stringify(msg).includes(tmp), "the PC's own paths are never sent to phones");
  const got = await fetch(`${base}/api/file/${msg.items.find((i) => i.rel.endsWith('b.jpg')).fileId}?${q(hub.pairCode, phone)}`);
  assert.strictEqual(await got.text(), 'bb');
});
