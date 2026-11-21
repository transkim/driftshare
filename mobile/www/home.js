// Driftshare Android home screen: "Nearby phones" (direct, no PC) and "My PC".
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };

  // The native plugin. Tests can swap in a fake with window.__directMock.
  const Direct = window.__directMock || (window.capacitorExports && window.capacitorExports.registerPlugin('Direct'));
  const native = !!window.__directMock || !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  // ---------- identity ----------
  let myId = store.get('direct.id', null);
  if (!myId) {
    myId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    store.set('direct.id', myId);
  }
  function guessName() {
    const m = navigator.userAgent.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/);
    return m && m[1] && m[1] !== 'K' ? m[1].trim() : 'Android phone';
  }
  let myName = store.get('direct.name', null) || guessName();

  // ---------- state ----------
  let peers = []; // nearby right now: {id, name}
  let history = store.get('direct.history', []); // {id, peerId, peerName, dir, type, text, name, size, uri, ts}
  let current = null; // peer id of the open chat
  const transfers = new Map(); // transferId/offerId -> row element
  const pendingOffers = [];
  let shownOffer = null;

  function saveHistory() {
    if (history.length > 800) history = history.slice(-800);
    store.set('direct.history', history);
  }
  function addHistory(entry) {
    const e = { id: Math.random().toString(36).slice(2), ts: Date.now(), ...entry };
    history.push(e);
    saveHistory();
    if (current === e.peerId) appendMsg(e, true);
    renderPeers();
    return e;
  }

  // ---------- tabs ----------
  function showTab(view) {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.view === view);
    $('nearbyView').hidden = view !== 'nearbyView';
    $('pcView').hidden = view !== 'pcView';
    store.set('lastTab', view);
  }
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.view));

  // ---------- nearby list ----------
  function knownPeers() {
    // Nearby phones first, then phones we've talked to before (shown as not nearby).
    const list = peers.map((p) => ({ ...p, nearby: true }));
    const seen = new Set(list.map((p) => p.id));
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (!seen.has(h.peerId)) {
        seen.add(h.peerId);
        list.push({ id: h.peerId, name: h.peerName, nearby: false });
      }
    }
    return list;
  }

  function lastWith(id) {
    for (let i = history.length - 1; i >= 0; i--) if (history[i].peerId === id) return history[i];
    return null;
  }

  function renderPeers() {
    const ul = $('peers');
    ul.innerHTML = '';
    const list = knownPeers();
    $('nearbyHint').textContent = !native
      ? 'Nearby phones work in the Driftshare Android app.'
      : peers.length
        ? 'Tap a phone to send it files or a message.'
        : 'Looking for phones with Driftshare open on this Wi-Fi…';
    for (const p of list) {
      const li = document.createElement('li');
      li.className = 'peer' + (p.nearby ? '' : ' offline');
      li.innerHTML = '<div class="avatar">📱</div><div class="txt"><div class="nm"></div><div class="sub"></div></div><span class="dot"></span>';
      li.querySelector('.nm').textContent = p.name || 'Phone';
      const last = lastWith(p.id);
      li.querySelector('.sub').textContent = last
        ? (last.dir === 'out' ? 'You: ' : '') + (last.type === 'text' ? last.text : '📎 ' + last.name)
        : p.nearby ? 'Nearby' : 'Not nearby';
      li.addEventListener('click', () => openChat(p.id));
      ul.appendChild(li);
    }
    if (current) renderChatHeader();
  }

  $('myNameBtn').textContent = myName;
  $('myNameBtn').addEventListener('click', async () => {
    const n = prompt('Name other phones see:', myName);
    if (!n || !n.trim()) return;
    myName = n.trim().slice(0, 40);
    store.set('direct.name', myName);
    $('myNameBtn').textContent = myName;
    if (native) Direct.rename({ name: myName }).catch(() => {});
  });

  // ---------- chat ----------
  function peerById(id) {
    return knownPeers().find((p) => p.id === id);
  }

  function openChat(id) {
    current = id;
    $('peerList').hidden = true;
    $('chat').hidden = false;
    document.body.classList.add('in-chat');
    history_push();
    renderChatHeader();
    const tl = $('timeline');
    tl.innerHTML = '';
    const msgs = history.filter((h) => h.peerId === id);
    if (!msgs.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = 'Send photos, files or a message. The other phone has to keep Driftshare open to receive.';
      tl.appendChild(d);
    }
    for (const m of msgs) appendMsg(m, false);
    tl.scrollTop = tl.scrollHeight;
  }

  function closeChat() {
    current = null;
    $('chat').hidden = true;
    $('peerList').hidden = false;
    document.body.classList.remove('in-chat');
    renderPeers();
  }
  $('backBtn').addEventListener('click', () => (window.history.state && window.history.state.chat ? window.history.back() : closeChat()));

  // Android back button closes the chat instead of leaving the app.
  function history_push() {
    window.history.pushState({ chat: true }, '');
  }
  window.addEventListener('popstate', () => {
    if (current) closeChat();
  });

  function renderChatHeader() {
    const p = peerById(current);
    $('peerName').textContent = p ? p.name : 'Phone';
    $('peerStatus').textContent = p && p.nearby ? 'Nearby' : 'Not nearby right now';
  }

  function appendMsg(m, scroll) {
    const tl = $('timeline');
    tl.querySelector('.empty')?.remove();
    const row = document.createElement('div');
    row.className = 'msg ' + m.dir;
    const b = document.createElement('div');
    b.className = 'bubble';
    if (m.type === 'text') {
      b.textContent = m.text;
    } else {
      b.classList.add('file');
      b.innerHTML = '<span class="fi"></span><div><div class="fn"></div><div class="fs"></div></div>';
      b.querySelector('.fi').textContent = fileEmoji(m.name);
      b.querySelector('.fn').textContent = m.name;
      b.querySelector('.fs').textContent = formatSize(m.size) + (m.dir === 'in' ? ' · saved in Downloads/Driftshare' : '');
      if (m.uri && native) {
        b.classList.add('openable');
        b.addEventListener('click', () => Direct.openReceived({ uri: m.uri }).catch((e) => toast(e.message)));
      }
    }
    const t = document.createElement('div');
    t.className = 'time';
    t.textContent = new Date(m.ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
    row.append(b, t);
    tl.appendChild(row);
    if (scroll) tl.scrollTop = tl.scrollHeight;
  }

  const text = $('textInput');
  text.addEventListener('input', () => {
    text.style.height = 'auto';
    text.style.height = Math.min(text.scrollHeight, 140) + 'px';
  });

  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = text.value;
    if (!value.trim() || !current) return;
    const p = peerById(current);
    if (!p || !p.nearby) return toast("That phone isn't nearby right now.");
    text.value = '';
    text.style.height = 'auto';
    try {
      await Direct.sendText({ peerId: current, text: value });
      addHistory({ peerId: current, peerName: p.name, dir: 'out', type: 'text', text: value });
    } catch (err) {
      text.value = value;
      toast(err.message || 'Could not send');
    }
  });

  $('attachBtn').addEventListener('click', async () => {
    if (!current) return;
    const p = peerById(current);
    if (!p || !p.nearby) return toast("That phone isn't nearby right now.");
    const transferId = Math.random().toString(36).slice(2, 10);
    try {
      const r = await Direct.sendFiles({ peerId: current, transferId });
      if (r && r.accepted === false) toast(`${p.name} declined the files.`);
    } catch (err) {
      toast(err.message || 'Sending failed');
    }
  });

  // ---------- transfer progress ----------
  function transferRow(id, label) {
    let row = transfers.get(id);
    if (!row) {
      row = document.createElement('div');
      row.className = 'transfer';
      row.innerHTML = '<div class="label"><span class="l"></span><span class="p"></span></div><div class="bar"><span></span></div>';
      $('transfers').appendChild(row);
      transfers.set(id, row);
    }
    if (label) row.querySelector('.l').textContent = label;
    return row;
  }
  function dropRow(id, delay = 0) {
    const row = transfers.get(id);
    if (!row) return;
    setTimeout(() => {
      row.remove();
      transfers.delete(id);
    }, delay);
  }
  const outgoing = new Map(); // transferId -> {peerId, files}

  // ---------- incoming offers ----------
  function showNextOffer() {
    if (shownOffer || !pendingOffers.length) return;
    shownOffer = pendingOffers.shift();
    const o = shownOffer;
    const n = o.files.length;
    $('offerTitle').textContent = `${o.fromName} wants to send you ${n === 1 ? 'a file' : n + ' files'} (${formatSize(o.totalSize)})`;
    const ul = $('offerFiles');
    ul.innerHTML = '';
    for (const f of o.files.slice(0, 50)) {
      const li = document.createElement('li');
      const a = document.createElement('span');
      a.textContent = `${fileEmoji(f.name)} ${f.name}`;
      const s = document.createElement('span');
      s.textContent = f.size >= 0 ? formatSize(f.size) : '';
      li.append(a, s);
      ul.appendChild(li);
    }
    $('offerSheet').hidden = false;
  }
  async function answerOffer(accept) {
    const o = shownOffer;
    $('offerSheet').hidden = true;
    shownOffer = null;
    if (o) {
      try {
        await Direct.respond({ offerId: o.offerId, accept });
        if (accept) transferRow(o.offerId, `Receiving from ${o.fromName}`);
      } catch (err) {
        toast(err.message || 'That request expired');
      }
    }
    showNextOffer();
  }
  $('acceptBtn').addEventListener('click', () => answerOffer(true));
  $('declineBtn').addEventListener('click', () => answerOffer(false));

  // ---------- plugin events ----------
  async function startDirect() {
    if (!native || !Direct) {
      renderPeers();
      return;
    }
    Direct.addListener('peers', (e) => {
      peers = e.peers || [];
      renderPeers();
    });
    Direct.addListener('incomingText', (e) => {
      addHistory({ peerId: e.from, peerName: e.fromName, dir: 'in', type: 'text', text: e.text, ts: e.ts });
      if (current !== e.from) toast(`${e.fromName}: ${e.text.slice(0, 80)}`);
    });
    Direct.addListener('incomingOffer', (e) => {
      pendingOffers.push(e);
      showNextOffer();
    });
    Direct.addListener('offerExpired', (e) => {
      if (shownOffer && shownOffer.offerId === e.offerId) {
        $('offerSheet').hidden = true;
        shownOffer = null;
        showNextOffer();
      }
    });
    Direct.addListener('receiveProgress', (e) => {
      const row = transferRow(e.offerId);
      row.querySelector('.p').textContent = `${e.name} · ${formatSize(e.received)}`;
    });
    Direct.addListener('received', (e) => {
      addHistory({ peerId: e.from, peerName: e.fromName, dir: 'in', type: 'file', name: e.name, size: e.size, uri: e.uri, ts: e.ts });
      const row = transfers.get(e.offerId);
      if (row) row.querySelector('.p').textContent = `Saved ${e.name}`;
      dropRow(e.offerId, 2500);
    });
    Direct.addListener('sendStarted', (e) => {
      outgoing.set(e.transferId, { peerId: e.peerId, files: e.files, total: e.totalSize });
      const p = peerById(e.peerId);
      transferRow(e.transferId, `Waiting for ${p ? p.name : 'the other phone'} to accept…`);
    });
    Direct.addListener('sendProgress', (e) => {
      const info = outgoing.get(e.transferId);
      const p = info && peerById(info.peerId);
      const row = transferRow(e.transferId);
      if (e.state === 'sending') {
        row.querySelector('.l').textContent = `Sending to ${p ? p.name : 'phone'}`;
        row.querySelector('.p').textContent = e.detail || '';
        if (e.total > 0) row.querySelector('.bar span').style.width = `${Math.min(100, (e.sent / e.total) * 100)}%`;
      } else if (e.state === 'done') {
        if (info) for (const f of info.files) addHistory({ peerId: info.peerId, peerName: p ? p.name : 'Phone', dir: 'out', type: 'file', name: f.name, size: f.size });
        row.querySelector('.bar span').style.width = '100%';
        row.querySelector('.l').textContent = 'Sent';
        dropRow(e.transferId, 1500);
        outgoing.delete(e.transferId);
      } else if (e.state === 'declined') {
        dropRow(e.transferId);
        outgoing.delete(e.transferId);
      } else if (e.state === 'failed') {
        row.classList.add('failed');
        row.querySelector('.l').textContent = 'Sending failed';
        row.querySelector('.p').textContent = e.detail || '';
        dropRow(e.transferId, 5000);
        outgoing.delete(e.transferId);
      }
    });
    try {
      const r = await Direct.start({ id: myId, name: myName });
      peers = r.peers || [];
    } catch (err) {
      $('nearbyHint').textContent = err.message || "Couldn't start nearby sharing.";
    }
    renderPeers();
  }

  // ---------- My PC ----------
  const DEFAULT_PORT = 47820;
  const loadHubs = () => store.get('hubs', []);
  function normalize(addr) {
    addr = addr.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/:\d+$/.test(addr)) addr += ':' + DEFAULT_PORT;
    return addr;
  }
  async function reachable(addr) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    try {
      await fetch(`http://${addr}/icon.png`, { mode: 'no-cors', signal: ctl.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  }
  async function goPc(addr, code) {
    $('err').textContent = '';
    $('go').disabled = true;
    $('go').textContent = 'Connecting…';
    const ok = await reachable(addr);
    $('go').disabled = false;
    $('go').textContent = 'Connect';
    if (!ok) {
      $('err').textContent = `Can't reach ${addr}. Is Driftshare open on the PC, on the same Wi-Fi?`;
      return;
    }
    store.set('hubs', [{ addr, code }, ...loadHubs().filter((h) => h.addr !== addr)].slice(0, 5));
    store.set('lastTab', 'pcView');
    location.href = `http://${addr}/?k=${encodeURIComponent(code)}`;
  }
  $('pcForm').addEventListener('submit', (e) => {
    e.preventDefault();
    goPc(normalize($('addr').value), $('code').value.trim().toUpperCase());
  });
  for (const h of loadHubs()) {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = `Reconnect to ${h.addr}`;
    b.onclick = () => goPc(h.addr, h.code);
    $('recent').appendChild(b);
  }
  if (loadHubs()[0]) $('addr').value = loadHubs()[0].addr;

  // ---------- helpers ----------
  let toastTimer;
  function toast(msg) {
    $('toast').textContent = msg;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('toast').hidden = true), 3500);
  }
  function fileEmoji(name) {
    if (/\.(jpe?g|png|gif|webp|heic|bmp)$/i.test(name)) return '🖼️';
    if (/\.(mp4|mov|webm|3gp|mkv)$/i.test(name)) return '🎬';
    if (/\.(mp3|m4a|wav|ogg|flac|aac)$/i.test(name)) return '🎵';
    if (/\.(zip|rar|7z)$/i.test(name)) return '🗜️';
    if (/\.pdf$/i.test(name)) return '📕';
    if (/\.apk$/i.test(name)) return '📦';
    return '📄';
  }
  function formatSize(n) {
    if (!(n >= 0)) return '';
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
  }

  // ---------- start ----------
  const params = new URLSearchParams(location.search);
  const lastTab = store.get('lastTab', 'nearbyView');
  showTab(params.has('switch') ? 'pcView' : lastTab);
  startDirect();
  // Jump straight back to the last PC if that's what was used last time.
  const hubs = loadHubs();
  if (!params.has('switch') && lastTab === 'pcView' && hubs[0]) {
    reachable(hubs[0].addr).then((ok) => {
      if (ok) location.href = `http://${hubs[0].addr}/?k=${encodeURIComponent(hubs[0].code)}`;
    });
  }
})();
