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
        ? (last.dir === 'out' ? 'You: ' : '') +
          (last.type === 'text' ? last.text : last.type === 'bundle' ? `${last.kind === 'folder' ? '📁' : '🗂️'} ${last.name}` : '📎 ' + last.name)
        : p.nearby ? 'Nearby' : 'Not nearby';
      li.addEventListener('click', () => openChat(p.id));
      ul.appendChild(li);
    }
    if (current) renderChatHeader();
    if (sharing) renderShareTargets();
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
    row.dataset.id = m.id;
    const b = document.createElement('div');
    b.className = 'bubble';
    if (m.type === 'bundle') {
      renderBundle(m, b);
    } else if (m.type === 'text') {
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
    const old = tl.querySelector(`[data-id="${m.id}"]`);
    if (old) old.replaceWith(row);
    else tl.appendChild(row);
    if (scroll) tl.scrollTop = tl.scrollHeight;
  }

  // A folder or several files sent together: one bubble listing what's inside.
  function renderBundle(m, b) {
    b.classList.add('file', 'bundle');
    const head = document.createElement('div');
    head.className = 'bundle-head';
    head.innerHTML = '<span class="fi"></span><div><div class="fn"></div><div class="fs"></div></div>';
    head.querySelector('.fi').textContent = m.kind === 'folder' ? '📁' : '🗂️';
    head.querySelector('.fn').textContent = m.name;
    head.querySelector('.fs').textContent =
      `${m.count} ${m.count === 1 ? 'file' : 'files'} · ${formatSize(m.size)}` + (m.dir === 'in' ? ' · in Downloads/Driftshare' : '');
    b.appendChild(head);
    const ul = document.createElement('ul');
    ul.className = 'items';
    const SHOW = 5;
    const fill = (all) => {
      ul.innerHTML = '';
      for (const it of all ? m.items : m.items.slice(0, SHOW)) {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.className = 'item';
        label.textContent = `${fileEmoji(it.name)} ${it.path && m.kind === 'folder' ? it.path.split('/').slice(1).join('/') : it.name}`;
        const size = document.createElement('span');
        size.className = 'item-size';
        size.textContent = formatSize(it.size);
        if (it.uri && native) {
          li.classList.add('openable');
          li.addEventListener('click', () => Direct.openReceived({ uri: it.uri }).catch((e) => toast(e.message)));
        }
        li.append(label, size);
        ul.appendChild(li);
      }
      if (!all && m.items.length > SHOW) {
        const li = document.createElement('li');
        const more = document.createElement('button');
        more.className = 'more';
        more.textContent = `Show all ${m.items.length}`;
        more.onclick = () => fill(true);
        li.appendChild(more);
        ul.appendChild(li);
      }
    };
    fill(false);
    b.appendChild(ul);
  }

  // Received files of one transfer collect into a single bundle entry.
  function addToBundle(key, base, item) {
    let e = history.find((h) => h.bundleKey === key);
    if (!e) {
      e = { id: Math.random().toString(36).slice(2), ts: Date.now(), type: 'bundle', bundleKey: key, items: [], count: 0, size: 0, ...base };
      history.push(e);
    }
    e.items.push(item);
    e.count = e.items.length;
    e.size += item.size || 0;
    saveHistory();
    if (current === e.peerId) appendMsg(e, true);
    renderPeers();
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

  // "+" opens a small menu: files, or a whole folder.
  $('attachBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('attachMenu').hidden = !$('attachMenu').hidden;
  });
  document.addEventListener('click', () => ($('attachMenu').hidden = true));
  $('pickFilesBtn').addEventListener('click', () => pickAndSend(false));
  $('pickFolderBtn').addEventListener('click', () => pickAndSend(true));

  async function pickAndSend(folder) {
    $('attachMenu').hidden = true;
    if (!current) return;
    const p = peerById(current);
    if (!p || !p.nearby) return toast("That phone isn't nearby right now.");
    const transferId = Math.random().toString(36).slice(2, 10);
    try {
      const r = await Direct.sendFiles({ peerId: current, transferId, folder });
      if (r && r.accepted === false) toast(`${p.name} declined the files.`);
    } catch (err) {
      toast(err.message || 'Sending failed');
    }
  }

  // ---------- transfer progress ----------
  function transferRow(id, label) {
    let row = transfers.get(id);
    if (!row) {
      row = document.createElement('div');
      row.className = 'transfer';
      row.innerHTML = '<div class="label"><span class="l"></span><span class="p"></span></div><div class="bar"><span></span></div>';
      (shareTransferIds.has(id) ? $('shareProgress') : $('transfers')).appendChild(row);
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
  const outgoing = new Map(); // transferId -> {peerId, files, folder}
  const offerTotals = new Map(); // offerId -> {size, done} for the receive progress bar
  const shareTransferIds = new Set(); // transfers started from the share sheet show their progress there

  // ---------- incoming offers ----------
  function showNextOffer() {
    if (shownOffer || !pendingOffers.length) return;
    shownOffer = pendingOffers.shift();
    const o = shownOffer;
    const n = o.files.length;
    $('offerTitle').textContent = o.folder
      ? `${o.fromName} wants to send you the folder "${o.folder}" (${n} ${n === 1 ? 'file' : 'files'}, ${formatSize(o.totalSize)})`
      : `${o.fromName} wants to send you ${n === 1 ? 'a file' : n + ' files'} (${formatSize(o.totalSize)})`;
    const ul = $('offerFiles');
    ul.innerHTML = '';
    for (const f of o.files.slice(0, 50)) {
      const li = document.createElement('li');
      const a = document.createElement('span');
      a.textContent = `${fileEmoji(f.name)} ${f.path ? f.path.split('/').slice(1).join('/') : f.name}`;
      const s = document.createElement('span');
      s.textContent = f.size >= 0 ? formatSize(f.size) : '';
      li.append(a, s);
      ul.appendChild(li);
    }
    if (o.files.length > 50) {
      const li = document.createElement('li');
      li.textContent = `…and ${o.files.length - 50} more`;
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
      offerTotals.set(e.offerId, { size: Math.max(1, e.totalSize || 0), done: 0 });
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
      const total = offerTotals.get(e.offerId);
      if (total) row.querySelector('.bar span').style.width = `${Math.min(100, ((total.done + e.received) / total.size) * 100)}%`;
    });
    Direct.addListener('received', (e) => {
      const count = e.count || 1;
      if (count > 1) {
        const n = e.folder ? null : count;
        addToBundle(
          'in-' + e.offerId,
          { peerId: e.from, peerName: e.fromName, dir: 'in', kind: e.folder ? 'folder' : 'files', name: e.folder || `${n} files` },
          { name: e.name, path: e.path, size: e.size, uri: e.uri }
        );
      } else {
        addHistory({ peerId: e.from, peerName: e.fromName, dir: 'in', type: 'file', name: e.name, size: e.size, uri: e.uri, ts: e.ts });
      }
      const total = offerTotals.get(e.offerId);
      if (total) total.done += e.size;
      const row = transfers.get(e.offerId);
      if (row && total) row.querySelector('.bar span').style.width = `${Math.min(100, (total.done / total.size) * 100)}%`;
      if (row) row.querySelector('.p').textContent = count > 1 ? `Saved ${(e.index || 0) + 1} of ${count}` : `Saved ${e.name}`;
      if ((e.index || 0) + 1 >= count) {
        dropRow(e.offerId, 2500);
        offerTotals.delete(e.offerId);
      }
    });
    Direct.addListener('sendStarted', (e) => {
      outgoing.set(e.transferId, { peerId: e.peerId, files: e.files, total: e.totalSize, folder: e.folder });
      const p = peerById(e.peerId);
      transferRow(e.transferId, e.peerId === 'pc' ? 'Sending to your PC…' : `Waiting for ${p ? p.name : 'the other phone'} to accept…`);
    });
    Direct.addListener('sendProgress', (e) => {
      const info = outgoing.get(e.transferId);
      const p = info && peerById(info.peerId);
      const row = transferRow(e.transferId);
      if (e.state === 'sending') {
        row.querySelector('.l').textContent = `Sending to ${info && info.peerId === 'pc' ? 'your PC' : p ? p.name : 'phone'}`;
        row.querySelector('.p').textContent = e.detail || '';
        if (e.total > 0) row.querySelector('.bar span').style.width = `${Math.min(100, (e.sent / e.total) * 100)}%`;
      } else if (e.state === 'done') {
        if (info && info.peerId === 'pc') {
          // The PC keeps its own chat; nothing to add to the nearby history.
        } else if (info && info.files.length === 1 && !info.folder) {
          const f = info.files[0];
          addHistory({ peerId: info.peerId, peerName: p ? p.name : 'Phone', dir: 'out', type: 'file', name: f.name, size: f.size });
        } else if (info) {
          addHistory({
            peerId: info.peerId,
            peerName: p ? p.name : 'Phone',
            dir: 'out',
            type: 'bundle',
            kind: info.folder ? 'folder' : 'files',
            name: info.folder || `${info.files.length} files`,
            count: info.files.length,
            size: info.files.reduce((n, f) => n + Math.max(0, f.size || 0), 0),
            items: info.files.map((f) => ({ name: f.name, path: f.path, size: f.size }))
          });
        }
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

  // ---------- shared from another app ----------
  // Driftshare was picked in Gallery's (or any app's) Share menu. Show what was
  // shared and let the person pick a nearby phone or their PC.
  let sharing = null; // { files: [{name, size, type}], text }
  let shareBusy = false;

  async function checkShared() {
    if (!native || !Direct.getShared) return;
    try {
      const r = await Direct.getShared();
      if ((r.files && r.files.length) || r.text) {
        sharing = { files: r.files || [], text: r.text || null };
        showShareSheet();
      }
    } catch (err) {
      toast(err.message || "Couldn't read what was shared");
    }
  }

  function showShareSheet() {
    const n = sharing.files.length;
    const size = sharing.files.reduce((t, f) => t + Math.max(0, f.size || 0), 0);
    $('shareTitle').textContent = sharing.text
      ? 'Send this text'
      : `Send ${n === 1 ? sharing.files[0].name : n + ' items'}${size ? ` (${formatSize(size)})` : ''}`;
    const ul = $('shareFiles');
    ul.innerHTML = '';
    if (sharing.text) {
      const li = document.createElement('li');
      li.textContent = sharing.text.length > 200 ? sharing.text.slice(0, 200) + '…' : sharing.text;
      ul.appendChild(li);
    }
    for (const f of sharing.files.slice(0, n === 1 ? 0 : 6)) {
      const li = document.createElement('li');
      const a = document.createElement('span');
      a.textContent = `${fileEmoji(f.name)} ${f.name}`;
      const b = document.createElement('span');
      b.textContent = f.size >= 0 ? formatSize(f.size) : '';
      li.append(a, b);
      ul.appendChild(li);
    }
    if (n > 6) {
      const li = document.createElement('li');
      li.textContent = `…and ${n - 6} more`;
      ul.appendChild(li);
    }
    $('shareProgress').innerHTML = '';
    renderShareTargets();
    $('shareSheet').hidden = false;
  }

  function renderShareTargets() {
    const ul = $('shareTargets');
    if (!ul || !sharing) return;
    ul.innerHTML = '';
    const hub = loadHubs()[0];
    const add = (icon, name, sub, onPick) => {
      const li = document.createElement('li');
      li.className = 'peer' + (shareBusy ? ' busy' : '');
      li.innerHTML = '<div class="avatar"></div><div class="txt"><div class="nm"></div><div class="sub"></div></div>';
      li.querySelector('.avatar').textContent = icon;
      li.querySelector('.nm').textContent = name;
      li.querySelector('.sub').textContent = sub;
      li.addEventListener('click', onPick);
      ul.appendChild(li);
    };
    for (const p of peers) add('📱', p.name, 'Nearby', () => shareToPhone(p));
    if (hub) add('💻', 'My PC', hub.addr, () => shareToPc(hub));
    $('shareHint').textContent = peers.length
      ? ''
      : hub
        ? 'No phones nearby yet. Open Driftshare on the other phone to see it here.'
        : 'Looking for nearby phones… To send to your PC, connect to it once under My PC.';
  }

  function setShareBusy(b) {
    shareBusy = b;
    $('shareCancel').textContent = b ? 'Close' : 'Cancel';
    renderShareTargets();
  }

  function finishShare(msg) {
    sharing = null;
    shareBusy = false;
    if (native) Direct.clearShared().catch(() => {});
    $('shareSheet').hidden = true;
    if (msg) toast(msg);
  }

  async function shareToPhone(p) {
    const transferId = Math.random().toString(36).slice(2, 10);
    setShareBusy(true);
    try {
      if (sharing.text) {
        await Direct.sendText({ peerId: p.id, text: sharing.text });
        addHistory({ peerId: p.id, peerName: p.name, dir: 'out', type: 'text', text: sharing.text });
        finishShare(`Sent to ${p.name}`);
        openChat(p.id);
        return;
      }
      // Progress shows in the chat with that phone, like any other send.
      $('shareSheet').hidden = true;
      openChat(p.id);
      const r = await Direct.sendShared({ peerId: p.id, transferId });
      finishShare(r && r.accepted === false ? `${p.name} declined.` : null);
    } catch (err) {
      setShareBusy(false);
      $('shareSheet').hidden = false;
      toast(err.message || 'Sending failed');
    }
  }

  async function shareToPc(hub) {
    const transferId = Math.random().toString(36).slice(2, 10);
    shareTransferIds.add(transferId);
    setShareBusy(true);
    try {
      await Direct.sendSharedToPc({ addr: hub.addr, code: hub.code, transferId });
      finishShare('Sent to your PC');
    } catch (err) {
      setShareBusy(false);
      toast(err.message || "Couldn't reach the PC");
    } finally {
      shareTransferIds.delete(transferId);
    }
  }

  $('shareCancel').addEventListener('click', () => finishShare(shareBusy ? null : 'Cancelled'));

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
    location.href = `http://${addr}/?k=${encodeURIComponent(code)}&d=${myId}`;
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
  // Shared from another app? Show the Nearby tab and the "Send to" sheet instead of
  // jumping to the PC chat.
  const hubs = loadHubs();
  startDirect()
    .then(checkShared)
    .then(() => {
      if (sharing) showTab('nearbyView');
      autoReconnect();
    });
  // Jump straight back to the last PC if that's what was used last time.
  function autoReconnect() {
    if (params.has('switch') || params.has('share') || lastTab !== 'pcView' || !hubs[0] || sharing) return;
    reachable(hubs[0].addr).then((ok) => {
      if (ok && !sharing) location.href = `http://${hubs[0].addr}/?k=${encodeURIComponent(hubs[0].code)}&d=${myId}`;
    });
  }
})();
