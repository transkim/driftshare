// Driftshare screen. The same page runs in the PC window and in a phone's browser
// or the Android app; it changes layout depending on who it's talking to.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const desktop = window.driftDesktop || null;
  const store = {
    get(k) {
      try { return localStorage.getItem(k); } catch { return null; }
    },
    set(k, v) {
      try { localStorage.setItem(k, v); } catch {}
    }
  };

  // ---------- identity ----------
  const params = new URLSearchParams(location.search);
  let key = params.get('k') || store.get('drift.key') || '';
  let deviceId = params.get('d') || store.get('drift.device');
  if (!deviceId) {
    deviceId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (deviceId !== 'hub') {
    store.set('drift.key', key);
    store.set('drift.device', deviceId);
  }
  // Keep the code out of the address bar / history once we've read it.
  if (params.has('k')) history.replaceState(null, '', location.pathname + (deviceId === 'hub' ? `?k=${encodeURIComponent(key)}&d=hub` : ''));

  function guessName() {
    const ua = navigator.userAgent;
    const m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/);
    if (m && m[1] && !/^K$/.test(m[1])) return m[1].trim();
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android phone';
    return 'Browser';
  }
  const myName = store.get('drift.name') || guessName();
  const platform = /Android/.test(navigator.userAgent) ? 'android' : /iPhone|iPad/.test(navigator.userAgent) ? 'ios' : 'web';

  // ---------- state ----------
  let isLocal = false;
  let hubInfo = null;
  let devices = [];
  let messages = [];
  let selected = null; // device id of the open conversation ('hub' means the PC)
  let events = null;

  const api = (p, q = {}) => {
    const u = new URL(p, location.origin);
    u.searchParams.set('k', key);
    u.searchParams.set('d', deviceId);
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return u.toString();
  };

  async function call(method, p, body) {
    const r = await fetch(api(p), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `Error ${r.status}`), { status: r.status });
    return data;
  }

  // ---------- startup ----------
  async function connect() {
    try {
      const hello = await call('GET', '/api/hello?' + new URLSearchParams({ name: myName, platform }));
      isLocal = hello.isLocal;
      hubInfo = hello.hub;
      messages = hello.messages;
      devices = hello.devices || [];
      if (isLocal) renderPairing(hello.pairing);
      document.body.classList.toggle('is-desktop', isLocal);
      document.body.classList.toggle('is-phone', !isLocal);
      const inApp = /DriftshareApp/.test(navigator.userAgent);
      $('forgetBtn').hidden = !isLocal && !inApp;
      if (inApp && !isLocal) $('forgetBtn').textContent = 'Home';
      $('textInput').placeholder = isLocal ? 'Type a message or drop files' : 'Type a message';
      $('hubName').textContent = isLocal ? 'This PC' : `Connected to ${hubInfo.name}`;
      $('pairBtn').hidden = !isLocal;
      $('openDownloads').hidden = !isLocal;
      openEvents();
      if (!isLocal && !selected) selected = 'hub';
      route();
    } catch (err) {
      showError(err);
    }
  }

  function openEvents() {
    if (events) events.close();
    events = new EventSource(api('/api/events'));
    events.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (!messages.some((x) => x.id === m.id)) messages.push(m);
      if (isCurrent(m)) appendMessage(m, true);
      renderDevices();
    });
    events.addEventListener('devices', (e) => {
      devices = JSON.parse(e.data);
      renderDevices();
      renderChatHeader();
    });
    events.addEventListener('pairing', (e) => renderPairing(JSON.parse(e.data)));
    events.onerror = () => {
      // EventSource retries by itself; if the code was reset, we'll get 401s.
      setTimeout(async () => {
        if (events.readyState === EventSource.CLOSED) connect();
      }, 3000);
    };
  }

  function showError(err) {
    show('errorPane');
    $('errorText').textContent =
      err.status === 401
        ? 'This device is not paired, or the pairing code changed. Type the code shown on your PC.'
        : err.status === 429
          ? err.message
          : "Can't reach your PC. Make sure Driftshare is open there and both devices are on the same Wi-Fi.";
    $('codeForm').hidden = isLocal || err.status === 429 ? true : false;
  }

  $('codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    key = $('codeInput').value.trim().toUpperCase();
    store.set('drift.key', key);
    connect();
  });

  // ---------- routing between panes ----------
  function show(id) {
    for (const p of ['pairPane', 'chatPane', 'errorPane', 'pickPane']) $(p).hidden = p !== id;
    document.body.classList.toggle('in-chat', id === 'chatPane');
  }

  function route() {
    renderDevices();
    if (selected && devices.some((d) => d.id === selected)) {
      show('chatPane');
      renderChat();
    } else {
      selected = null;
      show(isLocal ? 'pairPane' : 'pickPane');
    }
  }

  $('pairBtn').addEventListener('click', () => {
    selected = null;
    route();
  });
  $('backBtn').addEventListener('click', () => {
    selected = null;
    route();
  });
  $('openDownloads').addEventListener('click', () => desktop && desktop.openDownloads());
  $('resetCode').addEventListener('click', async () => {
    if (!confirm('Make a new pairing code? Every connected phone will need the new code.')) return;
    renderPairing(await call('POST', '/api/reset-pairing'));
  });
  $('forgetBtn').addEventListener('click', async () => {
    if (!isLocal) {
      location.href = 'http://localhost/?switch=1'; // back to the Android app's connect screen
      return;
    }
    if (!selected) return;
    const d = devices.find((x) => x.id === selected);
    if (!confirm(`Remove ${d ? d.name : 'this device'} from the list? Your chat history stays.`)) return;
    await call('POST', '/api/forget', { id: selected });
    selected = null;
    route();
  });

  // ---------- rendering ----------
  function renderPairing(p) {
    if (!p) return;
    $('qr').innerHTML = p.qr || '<p class="muted">No Wi-Fi network found on this PC.</p>';
    $('code').textContent = p.code;
    $('addr').innerHTML = '';
    for (const u of p.urls) {
      const div = document.createElement('div');
      div.textContent = `${u.address}:${p.port}`;
      div.title = u.ifname;
      $('addr').appendChild(div);
    }
  }

  // A conversation is the messages between this device and one other.
  function between(m, other) {
    return (m.from === other && m.to === deviceId) || (m.from === deviceId && m.to === other);
  }

  function lastMessageWith(id) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (between(messages[i], id)) return messages[i];
    }
    return null;
  }

  function renderDevices() {
    const ul = $('devices');
    ul.innerHTML = '';
    if (!devices.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = isLocal ? 'No phones yet' : 'No other devices yet';
      ul.appendChild(li);
    }
    for (const d of devices) {
      const li = document.createElement('li');
      li.className = 'device' + (d.id === selected ? ' active' : '') + (d.isHub ? ' hub' : '');
      const last = lastMessageWith(d.id);
      li.innerHTML = `<span class="dot ${d.online ? 'on' : ''}"></span>
        <div class="dev-text"><div class="dev-name"></div><div class="dev-last"></div></div>`;
      li.querySelector('.dev-name').textContent = (d.isHub ? '💻 ' : '') + (d.name || 'Unnamed device');
      li.querySelector('.dev-last').textContent = last
        ? last.type === 'text' ? last.text.slice(0, 50) : last.type === 'bundle' ? `${last.kind === 'folder' ? '📁' : '🗂️'} ${last.name}` : `📎 ${last.name}`
        : d.online ? 'Online' : 'Offline';
      li.addEventListener('click', () => {
        selected = d.id;
        route();
      });
      ul.appendChild(li);
    }
  }

  function renderChatHeader() {
    const d = devices.find((x) => x.id === selected);
    $('peerName').textContent = d ? d.name || 'Unnamed device' : '';
    $('peerStatus').textContent = !d
      ? ''
      : d.isHub
        ? 'Your PC'
        : d.online
          ? 'Online'
          : `Offline, last seen ${timeAgo(d.lastSeen)}. Files wait on the PC until they come back.`;
  }

  function isCurrent(m) {
    return !!selected && between(m, selected);
  }

  function renderChat() {
    renderChatHeader();
    const tl = $('timeline');
    tl.innerHTML = '';
    const list = messages.filter(isCurrent);
    if (!list.length) {
      const p = document.createElement('div');
      p.className = 'empty-chat';
      p.textContent = selected === 'hub' ? 'Send photos, files or messages to your PC.' : 'Send a file or a message to this phone.';
      tl.appendChild(p);
    }
    for (const m of list) appendMessage(m, false);
    tl.scrollTop = tl.scrollHeight;
  }

  const IMG = /\.(jpe?g|png|gif|webp|bmp)$/i;
  const VID = /\.(mp4|webm|mov)$/i;

  function appendMessage(m, scroll) {
    const tl = $('timeline');
    tl.querySelector('.empty-chat')?.remove();
    if (tl.querySelector(`[data-id="${m.id}"]`)) return;
    const mine = m.from === deviceId;
    const row = document.createElement('div');
    row.className = 'msg ' + (mine ? 'mine' : 'theirs');
    row.dataset.id = m.id;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (m.type === 'bundle') {
      renderBundle(m, bubble, mine);
    } else if (m.type === 'text') {
      bubble.appendChild(linkify(m.text));
      const copy = document.createElement('button');
      copy.className = 'mini';
      copy.textContent = 'Copy';
      copy.onclick = () => copyText(m.text, copy);
      bubble.appendChild(copy);
    } else {
      bubble.classList.add('file');
      if (IMG.test(m.name)) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = api(`/api/file/${m.fileId}`, { inline: '1' });
        img.alt = m.name;
        img.onclick = () => openFile(m);
        bubble.appendChild(img);
      } else if (VID.test(m.name)) {
        const v = document.createElement('video');
        v.controls = true;
        v.preload = 'metadata';
        v.src = api(`/api/file/${m.fileId}`, { inline: '1' });
        bubble.appendChild(v);
      }
      const meta = document.createElement('div');
      meta.className = 'file-meta';
      meta.innerHTML = `<span class="file-icon">${fileEmoji(m.name)}</span><div><div class="file-name"></div><div class="file-size"></div></div>`;
      meta.querySelector('.file-name').textContent = m.name;
      meta.querySelector('.file-size').textContent = formatSize(m.size);
      bubble.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'file-actions';
      if (desktop) {
        actions.append(button('Open', () => desktop.openFile(m.fileId)), button('Show in folder', () => desktop.showInFolder(m.fileId)));
      } else {
        const a = document.createElement('a');
        a.href = api(`/api/file/${m.fileId}`);
        a.download = m.name;
        a.textContent = mine ? 'Download again' : 'Download';
        a.className = 'mini';
        actions.appendChild(a);
      }
      bubble.appendChild(actions);
    }
    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = new Date(m.ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
    row.append(bubble, time);
    tl.appendChild(row);
    if (scroll) tl.scrollTop = tl.scrollHeight;
  }

  // A folder, or several files sent together: one bubble with a peek inside.
  function renderBundle(m, bubble, mine) {
    bubble.classList.add('file', 'bundle');
    const pics = m.items.filter((i) => IMG.test(i.rel)).slice(0, 4);
    if (pics.length) {
      const grid = document.createElement('div');
      grid.className = 'thumbs n' + pics.length;
      for (const it of pics) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = it.rel;
        img.src = api(`/api/file/${it.fileId}`, { inline: '1' });
        img.onclick = () => openItem(it);
        grid.appendChild(img);
      }
      bubble.appendChild(grid);
    }
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    meta.innerHTML = '<span class="file-icon"></span><div><div class="file-name"></div><div class="file-size"></div></div>';
    meta.querySelector('.file-icon').textContent = m.kind === 'folder' ? '📁' : '🗂️';
    meta.querySelector('.file-name').textContent = m.name;
    meta.querySelector('.file-size').textContent =
      m.kind === 'folder' ? `${m.count} ${m.count === 1 ? 'file' : 'files'} · ${formatSize(m.size)}` : formatSize(m.size);
    bubble.appendChild(meta);

    const list = document.createElement('ul');
    list.className = 'items';
    const SHOW = 5;
    const fill = (all) => {
      list.innerHTML = '';
      for (const it of all ? m.items : m.items.slice(0, SHOW)) {
        const li = document.createElement('li');
        const label = document.createElement(desktop ? 'button' : 'a');
        label.className = 'item';
        // Inside a folder, show the path below the folder's own name.
        label.textContent = `${fileEmoji(it.rel)} ${m.kind === 'folder' ? it.rel.split('/').slice(1).join('/') : it.rel}`;
        if (desktop) label.onclick = () => desktop.openFile(it.fileId);
        else {
          label.href = api(`/api/file/${it.fileId}`);
          label.download = it.rel.split('/').pop();
        }
        const size = document.createElement('span');
        size.className = 'item-size';
        size.textContent = formatSize(it.size);
        li.append(label, size);
        list.appendChild(li);
      }
      if (!all && m.items.length > SHOW) {
        const more = button(`Show all ${m.items.length}`, () => fill(true));
        more.classList.add('more');
        const li = document.createElement('li');
        li.appendChild(more);
        list.appendChild(li);
      }
    };
    fill(false);
    bubble.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    if (desktop) {
      actions.append(button(m.kind === 'folder' ? 'Open folder' : 'Show in folder', () => desktop.openBundle(m.id, m.items[0] && m.items[0].fileId)));
    } else {
      const a = document.createElement('a');
      a.href = api(`/api/bundle/${m.id}/zip`);
      a.download = `${m.name}.zip`;
      a.textContent = mine ? 'Download all again (.zip)' : 'Download all (.zip)';
      a.className = 'mini';
      actions.appendChild(a);
    }
    bubble.appendChild(actions);
  }

  function openItem(it) {
    if (desktop) desktop.openFile(it.fileId);
    else window.open(api(`/api/file/${it.fileId}`, { inline: '1' }), '_blank');
  }

  function openFile(m) {
    if (desktop) desktop.openFile(m.fileId);
    else window.open(api(`/api/file/${m.fileId}`, { inline: '1' }), '_blank');
  }

  function button(label, fn) {
    const b = document.createElement('button');
    b.className = 'mini';
    b.type = 'button';
    b.textContent = label;
    b.onclick = fn;
    return b;
  }

  function linkify(text) {
    const frag = document.createElement('div');
    frag.className = 'text';
    const re = /\bhttps?:\/\/[^\s<>"']+/g;
    let last = 0;
    for (const match of text.matchAll(re)) {
      frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      const a = document.createElement('a');
      a.href = match[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = match[0];
      frag.appendChild(a);
      last = match.index + match[0].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = 'Copy'), 1200);
  }

  function fileEmoji(name) {
    if (IMG.test(name)) return '🖼️';
    if (VID.test(name)) return '🎬';
    if (/\.(mp3|m4a|wav|ogg|flac)$/i.test(name)) return '🎵';
    if (/\.(zip|rar|7z|tar|gz)$/i.test(name)) return '🗜️';
    if (/\.pdf$/i.test(name)) return '📕';
    if (/\.apk$/i.test(name)) return '📦';
    return '📄';
  }

  function formatSize(n) {
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do {
      n /= 1024;
      i++;
    } while (n >= 1024 && i < u.length - 1);
    return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
  }

  function timeAgo(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }

  // ---------- sending ----------
  const textInput = $('textInput');
  textInput.addEventListener('input', autoGrow);
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });
  function autoGrow() {
    textInput.style.height = 'auto';
    textInput.style.height = Math.min(textInput.scrollHeight, 160) + 'px';
  }

  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textInput.value;
    if (!text.trim()) return;
    textInput.value = '';
    autoGrow();
    try {
      await call('POST', '/api/message', { text, to: selected });
    } catch (err) {
      textInput.value = text;
      alert(err.message);
    }
  });

  // "+" opens a small menu: send files, or send a whole folder.
  const canPickFolder = !!desktop || 'webkitdirectory' in document.createElement('input');
  $('pickFolderBtn').hidden = !canPickFolder;
  $('attachBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('attachMenu').hidden = !$('attachMenu').hidden;
  });
  document.addEventListener('click', () => ($('attachMenu').hidden = true));
  $('pickFilesBtn').addEventListener('click', async () => {
    $('attachMenu').hidden = true;
    if (desktop) {
      const paths = await desktop.pickFiles();
      if (paths.length) shareLocal(paths);
    } else $('fileInput').click();
  });
  $('pickFolderBtn').addEventListener('click', async () => {
    $('attachMenu').hidden = true;
    if (desktop) {
      const paths = await desktop.pickFolder();
      if (paths.length) shareLocal(paths);
    } else $('folderInput').click();
  });
  $('fileInput').addEventListener('change', () => {
    uploadFiles([...$('fileInput').files].map((f) => ({ file: f, rel: f.name })), 'files');
    $('fileInput').value = '';
  });
  $('folderInput').addEventListener('change', () => {
    const files = [...$('folderInput').files];
    if (files.length) uploadFiles(files.map((f) => ({ file: f, rel: f.webkitRelativePath || f.name })), 'folder');
    $('folderInput').value = '';
  });

  async function shareLocal(paths) {
    try {
      await call('POST', '/api/share-local', { to: selected, paths });
    } catch (err) {
      alert(err.message);
    }
  }

  // Each pick (one file, several files, or a folder) is one job with one progress
  // row. Jobs run one after another, and files within a job one at a time, so a
  // phone on weak Wi-Fi doesn't choke. Several files or a folder become one chat
  // item: the PC groups them by batch id and posts them on "batch-done".
  const jobs = [];
  let running = false;

  function uploadFiles(entries, kind) {
    if (!entries.length) return;
    const batched = kind === 'folder' || entries.length > 1;
    const label =
      kind === 'folder'
        ? `📁 ${entries[0].rel.split('/')[0]}`
        : entries.length > 1
          ? `${entries.length} files`
          : entries[0].file.name;
    jobs.push({
      entries,
      kind,
      to: selected || 'hub',
      batchId: batched ? 'b' + Math.random().toString(36).slice(2, 12) : null,
      label,
      total: entries.reduce((n, e) => n + e.file.size, 0)
    });
    if (!running) nextJob();
  }

  async function nextJob() {
    const job = jobs.shift();
    if (!job) {
      running = false;
      return;
    }
    running = true;
    const row = document.createElement('div');
    row.className = 'upload';
    row.innerHTML = '<div class="up-name"></div><div class="bar"><span></span></div><button class="mini">Cancel</button>';
    const name = row.querySelector('.up-name');
    const bar = row.querySelector('.bar span');
    $('uploads').appendChild(row);

    let cancelled = false;
    let current = null;
    let sentBefore = 0;
    const failed = [];
    row.querySelector('button').onclick = () => {
      cancelled = true;
      if (current) current.abort();
    };

    for (let i = 0; i < job.entries.length && !cancelled; i++) {
      const { file, rel } = job.entries[i];
      name.textContent = job.entries.length > 1 ? `${job.label} · ${i + 1} of ${job.entries.length}` : job.label;
      const q = { name: file.name, to: job.to };
      if (job.batchId) Object.assign(q, { batch: job.batchId, kind: job.kind, rel });
      const err = await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        current = xhr;
        xhr.open('POST', api('/api/upload', q));
        xhr.upload.onprogress = (e) => {
          if (job.total > 0) bar.style.width = `${((sentBefore + e.loaded) / job.total) * 100}%`;
        };
        xhr.onload = () => resolve(xhr.status === 200 ? null : safeJson(xhr.responseText).error || `Error ${xhr.status}`);
        xhr.onerror = () => resolve('connection lost');
        xhr.onabort = () => resolve('cancelled');
        xhr.send(file);
      });
      current = null;
      sentBefore += file.size;
      if (err && !cancelled) failed.push(`${rel}: ${err}`);
      if (err === 'connection lost') break; // the PC is gone; don't hammer it
    }

    // Post whatever made it, even after a cancel, so nothing is left invisible.
    if (job.batchId) await call('POST', '/api/batch-done', { batch: job.batchId }).catch(() => {});

    if (failed.length || cancelled) {
      row.classList.add('failed');
      name.textContent = cancelled
        ? `${job.label}: cancelled`
        : `${job.label}: ${failed.length === 1 ? failed[0] : `${failed.length} files didn't send (${failed[0]})`}`;
      row.querySelector('button').textContent = 'Dismiss';
      row.querySelector('button').onclick = () => row.remove();
    } else row.remove();
    nextJob();
  }

  function safeJson(t) {
    try { return JSON.parse(t); } catch { return {}; }
  }

  // Drag and drop (PC window, or desktop browsers).
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!selected || !e.dataTransfer.types.includes('Files')) return;
    dragDepth++;
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('dragging');
    }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    if (!selected) return;
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    if (!desktop) {
      // Desktop browsers: dropped folders have to be walked through the entries API.
      const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
      if (entries.some((en) => en.isDirectory)) {
        for (const en of entries) {
          if (en.isDirectory) collectEntries(en, en.name).then((list) => uploadFiles(list, 'folder'));
          else en.file((f) => uploadFiles([{ file: f, rel: f.name }], 'files'));
        }
        return;
      }
    }
    if (desktop) {
      const withPath = files.filter((f) => desktop.pathForFile(f));
      if (withPath.length) shareLocal(withPath.map((f) => desktop.pathForFile(f)));
      const noPath = files.filter((f) => !desktop.pathForFile(f));
      if (noPath.length) uploadFiles(noPath.map((f) => ({ file: f, rel: f.name })), 'files');
    } else uploadFiles(files.map((f) => ({ file: f, rel: f.name })), 'files');
  });

  async function collectEntries(dirEntry, prefix) {
    const out = [];
    const readAll = (reader) =>
      new Promise((resolve, reject) => {
        const all = [];
        const more = () =>
          reader.readEntries((batch) => {
            if (!batch.length) resolve(all);
            else {
              all.push(...batch);
              more();
            }
          }, reject);
        more();
      });
    for (const en of await readAll(dirEntry.createReader())) {
      if (en.isDirectory) out.push(...(await collectEntries(en, `${prefix}/${en.name}`)));
      else out.push({ file: await new Promise((res, rej) => en.file(res, rej)), rel: `${prefix}/${en.name}` });
    }
    return out;
  }

  // Paste an image or file straight into the chat.
  document.addEventListener('paste', (e) => {
    if (!selected) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      uploadFiles(files.map((f) => ({ file: f, rel: f.name || 'pasted.png' })), 'files');
    }
  });

  connect();
})();
