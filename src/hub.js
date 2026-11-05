// Driftshare hub: a small HTTP server on the PC that phones connect to over Wi-Fi.
// It stores the message/file history, receives uploads, serves downloads and
// pushes live updates to every connected screen with Server-Sent Events.

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');
const QRCode = require('qrcode');
const yazl = require('yazl');

const DEFAULT_PORT = 47820;
const UI_DIR = path.join(__dirname, '..', 'ui');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json'
};

const HUB_ID = 'hub';
const MAX_BUNDLE_ITEMS = 5000;
const BATCH_ID = /^[A-Za-z0-9_-]{6,40}$/;

function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Short pairing code people can type on a phone, e.g. "K7P4QX" (no 0/O/1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function pairingCode(len = 6) {
  let out = '';
  for (const b of crypto.randomBytes(len)) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// Strip anything that could escape the download folder or upset Windows.
function sanitizeFileName(name) {
  let base = path.basename(String(name || 'file').replace(/\\/g, '/'));
  base = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base)) base = '_' + base;
  return base.slice(0, 200) || 'file';
}

// A path inside a sent folder, e.g. "Holiday/2024/beach.jpg". Every part is made
// safe on its own, and "..", "." and empty parts are dropped, so it can never
// point outside the folder it lands in.
function sanitizeRelPath(rel) {
  const parts = String(rel || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((x) => x && x !== '.' && x !== '..')
    .slice(-24)
    .map((x) => sanitizeFileName(x));
  return parts.length ? parts : ['file'];
}

function lanAddresses() {
  const out = [];
  for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ ifname, address: a.address });
    }
  }
  // Prefer typical home Wi-Fi ranges first.
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  return out.sort((x, y) => rank(x.address) - rank(y.address));
}

class Hub {
  constructor(opts = {}) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.host = opts.host ?? '0.0.0.0';
    this.dataDir = opts.dataDir || path.join(os.homedir(), '.driftshare');
    this.downloadDir = opts.downloadDir || path.join(os.homedir(), 'Downloads', 'Driftshare');
    this.hubName = opts.name || os.hostname();
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.relayDir = path.join(this.dataDir, 'relay');
    this.clients = new Set(); // live SSE connections
    this.state = null;
    this.saveTimer = null;
    this.failures = new Map(); // ip -> { count, since } for wrong-code throttling
    this.batches = new Map(); // batchId -> files uploading together (a folder or a multi-file pick)
  }

  // ---------- persistence ----------

  async load() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.mkdir(this.downloadDir, { recursive: true });
    await fsp.mkdir(this.relayDir, { recursive: true });
    try {
      this.state = JSON.parse(await fsp.readFile(this.stateFile, 'utf8'));
    } catch {
      this.state = null;
    }
    if (!this.state || typeof this.state !== 'object') this.state = {};
    if (!/^[A-Z2-9]{6}$/.test(this.state.pairKey || '')) this.state.pairKey = pairingCode();
    this.state.localKey ||= randomToken(24);
    this.state.devices ||= {};
    this.state.messages ||= [];
    this.state.files ||= {};
    this.state.bundles ||= {}; // msgId -> { root } local folder behind a bundle, never sent to phones
    await this.saveNow();
    await this.cleanRelay();
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow().catch(() => {}), 300);
  }

  async saveNow() {
    clearTimeout(this.saveTimer);
    const tmp = this.stateFile + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this.state, null, 1));
    await fsp.rename(tmp, this.stateFile);
  }

  // ---------- public helpers used by the desktop shell ----------

  get pairCode() {
    return this.state.pairKey;
  }

  get localKey() {
    return this.state.localKey;
  }

  localUrl() {
    return `http://127.0.0.1:${this.port}/?k=${encodeURIComponent(this.state.localKey)}&d=${HUB_ID}`;
  }

  pairUrls() {
    return lanAddresses().map((a) => ({
      ...a,
      url: `http://${a.address}:${this.port}/?k=${encodeURIComponent(this.state.pairKey)}`
    }));
  }

  async resetPairKey() {
    this.state.pairKey = pairingCode();
    await this.saveNow();
    // Kick every phone so the old key stops working right away.
    for (const c of this.clients) if (c.deviceId !== HUB_ID) c.res.end();
    this.broadcast('pairing', await this.pairingInfo());
  }

  async pairingInfo() {
    const urls = this.pairUrls();
    const primary = urls[0];
    return {
      urls,
      code: this.state.pairKey,
      port: this.port,
      qr: primary ? await QRCode.toString(primary.url, { type: 'svg', margin: 1 }) : null
    };
  }

  // Register files that already live on the PC (picked or dropped in the desktop app)
  // so phones can download them without making a copy. Folders are walked and sent
  // as one bundle that keeps their inner structure; several files picked together
  // are also sent as one bundle.
  async shareLocalFiles(paths, to) {
    const items = [];
    let dirs = 0;
    let lastDir = null;
    for (const p of paths) {
      let st;
      try {
        st = await fsp.stat(p);
      } catch {
        continue;
      }
      if (st.isFile()) {
        items.push({ path: p, rel: path.basename(p), size: st.size });
      } else if (st.isDirectory()) {
        dirs++;
        lastDir = p;
        await walkDir(p, path.basename(p), items);
      }
      if (items.length > MAX_BUNDLE_ITEMS) throw new Error(`Too many files (over ${MAX_BUNDLE_ITEMS}). Try a smaller folder or a .zip.`);
    }
    if (!items.length) return [];
    if (items.length === 1 && !dirs) {
      const it = items[0];
      const fileId = randomToken(9);
      const msg = this.addMessage({ from: HUB_ID, to, type: 'file', fileId, name: path.basename(it.path), size: it.size });
      this.state.files[fileId] = { path: it.path, name: path.basename(it.path), size: it.size, owned: false, msgId: msg.id };
      return [msg];
    }
    const kind = dirs === 1 && paths.length === 1 ? 'folder' : 'files';
    const name = kind === 'folder' ? path.basename(lastDir) : `${items.length} files`;
    const list = items.map((it) => {
      const fileId = randomToken(9);
      this.state.files[fileId] = { path: it.path, name: path.basename(it.path), size: it.size, owned: false };
      return { fileId, rel: it.rel.split(path.sep).join('/'), size: it.size };
    });
    const msg = this.addBundle({ from: HUB_ID, to, kind, name, items: list });
    if (kind === 'folder') this.state.bundles[msg.id] = { root: lastDir };
    return [msg];
  }

  addBundle({ from, to, kind, name, items }) {
    const size = items.reduce((n, i) => n + i.size, 0);
    const msg = this.addMessage({ from, to, type: 'bundle', kind, name, count: items.length, size, items });
    for (const i of items) if (this.state.files[i.fileId]) this.state.files[i.fileId].msgId = msg.id;
    return msg;
  }

  // The message a file belongs to (a single-file message or a bundle).
  messageForFile(fileId) {
    const meta = this.state.files[fileId];
    if (meta && meta.msgId) {
      const m = this.state.messages.find((x) => x.id === meta.msgId);
      if (m) return m;
    }
    return this.state.messages.find((m) => m.fileId === fileId || (m.items && m.items.some((i) => i.fileId === fileId)));
  }

  // Close a batch of uploads and post it as one chat message.
  finishBatch(batchId) {
    const b = this.batches.get(batchId);
    if (!b) return null;
    this.batches.delete(batchId);
    if (!b.items.length) return null;
    let msg;
    if (b.items.length === 1 && b.kind === 'files') {
      const it = b.items[0];
      const meta = this.state.files[it.fileId];
      msg = this.addMessage({ from: b.from, to: b.to, type: 'file', fileId: it.fileId, name: meta.name, size: it.size });
      meta.msgId = msg.id;
    } else {
      const name = b.kind === 'folder' && b.rootName ? b.rootName : `${b.items.length} files`;
      msg = this.addBundle({ from: b.from, to: b.to, kind: b.kind, name, items: b.items });
      if (b.kind === 'folder' && b.rootDir) this.state.bundles[msg.id] = { root: b.rootDir };
    }
    return msg;
  }

  // ---------- core model ----------

  addMessage(m) {
    const msg = { id: randomToken(9), ts: Date.now(), ...m };
    this.state.messages.push(msg);
    if (this.state.messages.length > 5000) this.state.messages.splice(0, this.state.messages.length - 5000);
    this.save();
    this.broadcast('message', msg, (c) => c.deviceId === msg.from || c.deviceId === msg.to);
    return msg;
  }

  touchDevice(id, info = {}) {
    if (id === HUB_ID) return;
    const d = (this.state.devices[id] ||= { id, firstSeen: Date.now() });
    if (info.name) d.name = String(info.name).slice(0, 60);
    if (info.platform) d.platform = String(info.platform).slice(0, 40);
    d.lastSeen = Date.now();
    this.save();
  }

  // The devices a given viewer can talk to. Phones also see the PC itself and
  // every other paired phone, so they can send to each other through the PC.
  deviceList(viewer = HUB_ID) {
    const online = new Set([...this.clients].map((c) => c.deviceId));
    const list = Object.values(this.state.devices)
      .filter((d) => d.id !== viewer)
      .map((d) => ({ id: d.id, name: d.name, platform: d.platform, lastSeen: d.lastSeen, online: online.has(d.id) }))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    if (viewer !== HUB_ID) list.unshift({ id: HUB_ID, name: this.hubName, platform: 'pc', isHub: true, online: true });
    return list;
  }

  // Everyone, the PC included, only gets the conversations they are part of.
  historyFor(deviceId) {
    return this.state.messages.filter((m) => m.from === deviceId || m.to === deviceId);
  }

  // Who a message or file may be addressed to. The PC can send to any phone;
  // a phone can send to the PC or to another paired phone (not to itself).
  resolveTarget(from, isLocal, raw) {
    const to = String(raw || '');
    if (isLocal) return this.state.devices[to] ? to : null;
    if (!to || to === HUB_ID) return HUB_ID;
    return to !== from && this.state.devices[to] ? to : null;
  }

  // Phone-to-phone files pass through the PC but aren't the PC owner's files,
  // so they live in a private relay folder and are cleaned up after a week.
  async cleanRelay(maxAgeMs = 7 * 24 * 3600 * 1000) {
    let removed = 0;
    for (const [id, meta] of Object.entries(this.state.files)) {
      if (!meta.relay) continue;
      const pending = [...this.batches.values()].some((b) => b.items.some((i) => i.fileId === id));
      if (pending) continue;
      const msg = this.messageForFile(id);
      if (!msg || Date.now() - msg.ts > maxAgeMs) {
        await fsp.rm(meta.path, { force: true });
        delete this.state.files[id];
        removed++;
      }
    }
    if (removed) {
      this.save();
      await pruneEmptyDirs(this.relayDir, false);
    }
    return removed;
  }

  broadcast(event, data, filter = () => true) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) if (filter(c)) c.res.write(payload);
  }

  broadcastDevices() {
    const lists = new Map();
    for (const c of this.clients) {
      if (!lists.has(c.deviceId)) lists.set(c.deviceId, `event: devices\ndata: ${JSON.stringify(this.deviceList(c.deviceId))}\n\n`);
      c.res.write(lists.get(c.deviceId));
    }
  }

  // ---------- HTTP ----------

  // Returns { deviceId, isLocal } or null if the caller isn't allowed in.
  authenticate(req, url) {
    const key = String(url.searchParams.get('k') || req.headers['x-drift-key'] || '');
    const deviceId = String(url.searchParams.get('d') || req.headers['x-drift-device'] || '').slice(0, 64);
    const remote = req.socket.remoteAddress;
    if (safeEqual(key, this.state.localKey) && isLoopback(remote)) return { deviceId: HUB_ID, isLocal: true };
    if (safeEqual(key.toUpperCase(), this.state.pairKey) && /^[A-Za-z0-9_-]{6,64}$/.test(deviceId) && deviceId !== HUB_ID) {
      return { deviceId, isLocal: false };
    }
    return null;
  }

  start() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
        else res.destroy();
      });
    });
    this.server.requestTimeout = 0; // big uploads can take a while
    this.server.headersTimeout = 30000;
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        this.relayTimer = setInterval(() => {
          // Uploads that never said "done" (phone went away) still become a message.
          for (const [id, b] of this.batches) if (Date.now() - b.created > 6 * 3600 * 1000) this.finishBatch(id);
          this.cleanRelay().catch(() => {});
        }, 3600 * 1000);
        this.relayTimer.unref();
        resolve(this);
      });
    });
  }

  async stop() {
    clearInterval(this.relayTimer);
    for (const c of this.clients) c.res.end();
    await new Promise((r) => this.server.close(r));
    await this.saveNow();
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // Static UI is public; everything under /api needs a key.
    if (!p.startsWith('/api/')) return this.serveStatic(p, res);

    const ip = req.socket.remoteAddress;
    const fail = this.failures.get(ip);
    if (fail && Date.now() - fail.since > 60000) this.failures.delete(ip);
    if (fail && fail.count >= 10 && Date.now() - fail.since <= 60000) {
      return sendJson(res, 429, { error: 'Too many wrong codes. Wait a minute and try again.' });
    }
    const auth = this.authenticate(req, url);
    if (!auth) {
      const f = this.failures.get(ip) || { count: 0, since: Date.now() };
      f.count++;
      this.failures.set(ip, f);
      return sendJson(res, 401, { error: 'Wrong or old pairing code. Check the code on your PC.' });
    }
    const { deviceId, isLocal } = auth;

    if (req.method === 'GET' && p === '/api/hello') {
      this.touchDevice(deviceId, { name: url.searchParams.get('name'), platform: url.searchParams.get('platform') });
      this.broadcastDevices();
      return sendJson(res, 200, {
        hub: { id: HUB_ID, name: this.hubName },
        you: deviceId,
        isLocal,
        devices: this.deviceList(deviceId),
        messages: this.historyFor(deviceId),
        pairing: isLocal ? await this.pairingInfo() : undefined,
        downloadDir: isLocal ? this.downloadDir : undefined
      });
    }

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write('retry: 2000\n\n');
      const client = { deviceId, res };
      this.clients.add(client);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      this.broadcastDevices();
      req.on('close', () => {
        clearInterval(ping);
        this.clients.delete(client);
        this.touchDevice(deviceId);
        this.broadcastDevices();
      });
      return;
    }

    if (req.method === 'POST' && p === '/api/message') {
      const body = await readJson(req, 64 * 1024);
      const text = String(body.text || '').slice(0, 20000);
      if (!text.trim()) return sendJson(res, 400, { error: 'Empty message' });
      const to = this.resolveTarget(deviceId, isLocal, body.to);
      if (!to) return sendJson(res, 400, { error: 'Unknown device' });
      return sendJson(res, 200, this.addMessage({ from: deviceId, to, type: 'text', text }));
    }

    if (req.method === 'POST' && p === '/api/upload') {
      const to = this.resolveTarget(deviceId, isLocal, url.searchParams.get('to'));
      if (!to) return sendJson(res, 400, { error: 'Unknown device' });
      const relay = deviceId !== HUB_ID && to !== HUB_ID;
      const baseDir = relay ? this.relayDir : this.downloadDir;

      // Part of a batch (several files, or a folder)? Then it joins that batch and
      // the chat message is posted once, by /api/batch-done.
      const batchId = url.searchParams.get('batch');
      let batch = null;
      if (batchId) {
        if (!BATCH_ID.test(batchId)) return sendJson(res, 400, { error: 'Bad batch id' });
        batch = this.batches.get(batchId);
        if (!batch) {
          const kind = url.searchParams.get('kind') === 'folder' ? 'folder' : 'files';
          batch = { from: deviceId, to, kind, items: [], created: Date.now(), rootName: null, rootDir: null };
          this.batches.set(batchId, batch);
        }
        if (batch.from !== deviceId || batch.to !== to) return sendJson(res, 403, { error: 'Not your batch' });
        if (batch.items.length >= MAX_BUNDLE_ITEMS) return sendJson(res, 413, { error: `Too many files (over ${MAX_BUNDLE_ITEMS})` });
      }

      let target;
      let rel;
      if (batch && batch.kind === 'folder') {
        const parts = sanitizeRelPath(url.searchParams.get('rel') || url.searchParams.get('name'));
        if (parts.length < 2) parts.unshift('Folder');
        if (!batch.rootName) {
          batch.rootDir = await uniquePath(baseDir, parts[0]);
          batch.rootName = path.basename(batch.rootDir);
        }
        const dir = path.join(batch.rootDir, ...parts.slice(1, -1));
        await fsp.mkdir(dir, { recursive: true });
        target = await uniquePath(dir, parts[parts.length - 1]);
        rel = [batch.rootName, ...parts.slice(1, -1), path.basename(target)].join('/');
      } else {
        target = await uniquePath(baseDir, sanitizeFileName(url.searchParams.get('name')));
        rel = path.basename(target);
      }

      const tmp = target + '.part';
      let size = 0;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        req.on('data', (chunk) => (size += chunk.length));
        req.on('aborted', () => reject(new Error('Upload cancelled')));
        out.on('error', reject);
        out.on('finish', resolve);
        req.pipe(out);
      }).catch(async (err) => {
        await fsp.rm(tmp, { force: true });
        throw err;
      });
      await fsp.rename(tmp, target);
      const fileId = randomToken(9);
      this.state.files[fileId] = { path: target, name: path.basename(target), size, owned: true, relay };
      if (batch) {
        batch.items.push({ fileId, rel, size });
        this.save();
        return sendJson(res, 200, { fileId, rel, size });
      }
      const msg = this.addMessage({ from: deviceId, to, type: 'file', fileId, name: path.basename(target), size });
      this.state.files[fileId].msgId = msg.id;
      return sendJson(res, 200, msg);
    }

    if (req.method === 'POST' && p === '/api/batch-done') {
      const body = await readJson(req, 4096);
      const b = this.batches.get(String(body.batch || ''));
      if (!b || b.from !== deviceId) return sendJson(res, 404, { error: 'Unknown batch' });
      const msg = this.finishBatch(String(body.batch));
      return sendJson(res, 200, msg || { empty: true });
    }

    const zipMatch = p.match(/^\/api\/bundle\/([A-Za-z0-9_-]+)\/zip$/);
    if (req.method === 'GET' && zipMatch) {
      const msg = this.state.messages.find((m) => m.id === zipMatch[1] && m.type === 'bundle');
      if (!msg || (msg.from !== deviceId && msg.to !== deviceId)) return sendJson(res, 404, { error: 'Not found' });
      return this.serveZip(res, msg);
    }

    if (req.method === 'POST' && p === '/api/share-local' && isLocal) {
      const body = await readJson(req, 256 * 1024);
      const to = String(body.to || '');
      if (!this.state.devices[to]) return sendJson(res, 400, { error: 'Unknown device' });
      const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
      return sendJson(res, 200, await this.shareLocalFiles(paths, to));
    }

    if (req.method === 'POST' && p === '/api/reset-pairing' && isLocal) {
      await this.resetPairKey();
      return sendJson(res, 200, await this.pairingInfo());
    }

    if (req.method === 'POST' && p === '/api/forget' && isLocal) {
      const body = await readJson(req, 4096);
      delete this.state.devices[String(body.id)];
      this.save();
      this.broadcastDevices();
      return sendJson(res, 200, { ok: true });
    }

    const fileMatch = p.match(/^\/api\/file\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && fileMatch) {
      const fileId = fileMatch[1];
      const msg = this.messageForFile(fileId);
      const meta = this.state.files[fileId];
      if (!msg || !meta) return sendJson(res, 404, { error: 'File not found' });
      if (msg.from !== deviceId && msg.to !== deviceId) return sendJson(res, 404, { error: 'File not found' });
      return serveFile(req, res, meta.path, meta.name, url.searchParams.get('inline') === '1');
    }

    if (req.method === 'GET' && p === '/api/local-path' && isLocal) {
      const meta = this.state.files[url.searchParams.get('id')];
      return sendJson(res, meta ? 200 : 404, { path: meta?.path });
    }

    sendJson(res, 404, { error: 'Not found' });
  }

  // Everything in a bundle as one .zip, built on the fly (stored, not compressed:
  // photos and videos don't shrink, and this keeps big folders fast).
  async serveZip(res, msg) {
    const zip = new yazl.ZipFile();
    const used = new Set();
    for (const it of msg.items) {
      const meta = this.state.files[it.fileId];
      if (!meta) continue;
      try {
        await fsp.access(meta.path);
      } catch {
        continue; // moved or deleted on the PC: leave it out
      }
      let rel = msg.kind === 'folder' ? it.rel : it.rel.split('/').pop();
      while (used.has(rel)) rel = rel.replace(/(\.[^./]*)?$/, ' (copy)$1');
      used.add(rel);
      zip.addFile(meta.path, rel, { compress: false });
    }
    zip.end();
    const zipName = `${msg.name}.zip`;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(zipName)}`
    });
    zip.outputStream.pipe(res);
  }

  async serveStatic(p, res) {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.join(UI_DIR, rel);
    if (!file.startsWith(UI_DIR + path.sep)) return sendJson(res, 404, { error: 'Not found' });
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: 'Not found' });
    }
  }
}

// ---------- small HTTP utilities ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Bad JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Collect every file under a folder (not following links), with paths relative to it.
async function walkDir(dir, rel, out) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const r = rel + '/' + e.name;
    if (e.isDirectory()) await walkDir(full, r, out);
    else if (e.isFile()) {
      const st = await fsp.stat(full);
      out.push({ path: full, rel: r, size: st.size });
    }
    if (out.length > MAX_BUNDLE_ITEMS) return;
  }
}

// Remove empty folders left behind under root (root itself is kept unless removeSelf).
async function pruneEmptyDirs(dir, removeSelf) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) await pruneEmptyDirs(path.join(dir, e.name), true);
  if (removeSelf) {
    try {
      if (!(await fsp.readdir(dir)).length) await fsp.rmdir(dir);
    } catch {}
  }
}

async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i ? `${stem} (${i})${ext}` : name);
    try {
      await fsp.access(candidate);
    } catch {
      try {
        await fsp.access(candidate + '.part');
      } catch {
        return candidate;
      }
    }
  }
}

async function serveFile(req, res, filePath, name, inline) {
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch {
    return sendJson(res, 410, { error: 'That file was moved or deleted on the PC.' });
  }
  const type = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
  const disp = `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  const headers = { 'Content-Type': type, 'Content-Disposition': disp, 'Accept-Ranges': 'bytes' };

  // Range support lets phones resume and lets video previews seek.
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, st.size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  fs.createReadStream(filePath).pipe(res);
}

module.exports = { Hub, HUB_ID, DEFAULT_PORT, sanitizeFileName, sanitizeRelPath, lanAddresses };
