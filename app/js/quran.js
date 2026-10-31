/*
 * Sakina Quran reader and recitation player.
 * Text is bundled (app/quran). Audio streams per ayah from everyayah.com.
 */
(function () {
  const IDX = window.SakinaQuranIndex;
  const SURAHS = IDX.surahs;
  const cache = {};
  const waiting = {};

  // Each surah file calls SakinaQuran.loaded(n, data). A <script> tag works under file:// (Windows) and in the Android WebView.
  window.SakinaQuran = {
    loaded(n, data) { cache[n] = data; (waiting[n] || []).forEach((r) => r(data)); delete waiting[n]; },
  };
  function loadSurah(n) {
    if (cache[n]) return Promise.resolve(cache[n]);
    return new Promise((resolve, reject) => {
      if (!waiting[n]) {
        waiting[n] = [];
        const s = document.createElement('script');
        s.src = `quran/s/${String(n).padStart(3, '0')}.js`;
        s.onerror = () => { delete waiting[n]; reject(new Error('Could not load surah ' + n)); };
        document.head.appendChild(s);
      }
      waiting[n].push(resolve);
    });
  }

  const RECITERS = [
    { id: 'Alafasy_128kbps', name: 'Mishary Rashid Alafasy', cdn: 'ar.alafasy' },
    { id: 'Abdul_Basit_Murattal_192kbps', name: 'Abdul Basit (Murattal)', cdn: 'ar.abdulbasitmurattal' },
    { id: 'Husary_128kbps', name: 'Mahmoud Khalil Al-Husary', cdn: 'ar.husary' },
    { id: 'Minshawy_Murattal_128kbps', name: 'Muhammad Siddiq Al-Minshawi', cdn: 'ar.minshawi' },
    { id: 'Abdurrahmaan_As-Sudais_192kbps', name: 'Abdurrahman As-Sudais', cdn: 'ar.abdurrahmaansudais' },
    { id: 'Saood_ash-Shuraym_128kbps', name: 'Saud Ash-Shuraym', cdn: 'ar.saoodshuraym' },
    { id: 'MaherAlMuaiqly128kbps', name: 'Maher Al-Muaiqly', cdn: 'ar.mahermuaiqly' },
    { id: 'Yasser_Ad-Dussary_128kbps', name: 'Yasser Ad-Dossari', cdn: null },
    { id: 'ahmed_ibn_ali_al_ajamy_128kbps', name: 'Ahmed Al-Ajamy', cdn: 'ar.ahmedajamy' },
    { id: 'Husary_Muallim_128kbps', name: 'Al-Husary (teaching, with repetition)', cdn: null },
  ];
  // global ayah number (1..6236), used by the backup audio host
  const startOf = [];
  { let acc = 0; for (const s of SURAHS) { startOf[s.n] = acc; acc += s.ayahs; } }
  const pad = (n) => String(n).padStart(3, '0');
  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const arNum = (n) => String(n).replace(/\d/g, (d) => AR_DIGITS[d]);

  function install(ctx) {
    const { views, store, settings, saveSettings, esc, toast, Platform } = ctx;
    const $view = document.getElementById('view');
    const reciter = () => RECITERS.find((r) => r.id === settings.reciter) || RECITERS[0];

    let bookmarks = store.get('qbookmarks', []); // [{s, a, t}]
    const saveBookmarks = () => store.set('qbookmarks', bookmarks);
    const isBookmarked = (s, a) => bookmarks.some((b) => b.s === s && b.a === a);
    const lastRead = () => store.get('qlast', null);

    // ---------------- audio player ----------------
    const audio = new Audio();
    audio.preload = 'auto';
    const prefetch = new Audio();
    prefetch.preload = 'auto';
    const P = { surah: 0, ayah: 0, playing: false, basmala: false, repeat: 'off', triedBackup: false, loading: false };

    const urlFor = (s, a) => `https://everyayah.com/data/${reciter().id}/${pad(s)}${pad(a)}.mp3`;
    const backupUrl = (s, a) => reciter().cdn ? `https://cdn.islamic.network/quran/audio/128/${reciter().cdn}/${startOf[s] + a}.mp3` : null;

    function playAyah(s, a, { basmala } = {}) {
      P.surah = s; P.ayah = a; P.triedBackup = false;
      // recite the basmala before ayah 1, except Al-Fatiha (where it is ayah 1) and At-Tawbah
      P.basmala = !!basmala && a === 1 && s !== 1 && s !== 9;
      audio.src = P.basmala ? urlFor(1, 1) : urlFor(s, a);
      P.loading = true;
      audio.play().catch(() => {});
      P.playing = true;
      updateBar(); highlight(true);
      const meta = SURAHS[s - 1];
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({ title: `${meta.tr} ${s}:${a}`, artist: reciter().name, album: 'Sakina · Quran' });
        } catch (_) { /* ignore */ }
      }
      // warm up the next ayah
      if (a < meta.ayahs) prefetch.src = urlFor(s, a + 1);
    }
    function pause() { audio.pause(); P.playing = false; updateBar(); }
    function resume() { if (!audio.src) return; audio.play().catch(() => {}); P.playing = true; updateBar(); }
    function stop() { audio.pause(); audio.removeAttribute('src'); P.playing = false; P.surah = 0; highlight(false); updateBar(); }
    function step(d) {
      if (!P.surah) return;
      const meta = SURAHS[P.surah - 1];
      const a = P.ayah + d;
      if (a >= 1 && a <= meta.ayahs) playAyah(P.surah, a);
    }

    audio.addEventListener('playing', () => { P.loading = false; updateBar(); });
    audio.addEventListener('waiting', () => { P.loading = true; updateBar(); });
    audio.addEventListener('ended', () => {
      if (P.basmala) { P.basmala = false; audio.src = urlFor(P.surah, P.ayah); audio.play().catch(() => {}); return; }
      const meta = SURAHS[P.surah - 1];
      if (P.repeat === 'ayah') return playAyah(P.surah, P.ayah);
      if (P.ayah < meta.ayahs) return playAyah(P.surah, P.ayah + 1);
      if (P.repeat === 'surah') return playAyah(P.surah, 1, { basmala: true });
      if (settings.autoNextSurah && P.surah < 114) {
        const n = P.surah + 1;
        if (location.hash.startsWith('#/surah/')) location.hash = `#/surah/${n}`;
        return playAyah(n, 1, { basmala: true });
      }
      P.playing = false; updateBar();
    });
    audio.addEventListener('error', () => {
      if (!audio.getAttribute('src')) return;
      const b = !P.basmala && !P.triedBackup && backupUrl(P.surah, P.ayah);
      if (b) { P.triedBackup = true; audio.src = b; audio.play().catch(() => {}); return; }
      P.playing = false; P.loading = false; updateBar();
      toast(navigator.onLine === false ? 'You are offline. Recitation needs an internet connection.' : 'Could not load the recitation. Try another reciter.');
    });
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', resume);
        navigator.mediaSession.setActionHandler('pause', pause);
        navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
        navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
      } catch (_) { /* ignore */ }
    }

    // floating player bar, shared by all screens
    const bar = document.createElement('div');
    bar.className = 'player';
    bar.hidden = true;
    document.body.appendChild(bar);
    function updateBar() {
      if (!P.surah) { bar.hidden = true; document.body.classList.remove('has-player'); return; }
      bar.hidden = false; document.body.classList.add('has-player');
      const meta = SURAHS[P.surah - 1];
      bar.innerHTML = `
        <a class="pinfo" href="#/surah/${P.surah}?a=${P.ayah}">
          <span class="pt">${esc(meta.tr)} · ${P.surah}:${P.ayah}${P.basmala ? ' (basmala)' : ''}</span>
          <span class="ps">${P.loading && P.playing ? 'Loading…' : esc(reciter().name)}</span>
        </a>
        <button class="pbtn" data-a="prev" aria-label="Previous ayah">⏮</button>
        <button class="pbtn main" data-a="toggle" aria-label="${P.playing ? 'Pause' : 'Play'}">${P.playing ? '❚❚' : '▶'}</button>
        <button class="pbtn" data-a="next" aria-label="Next ayah">⏭</button>
        <button class="pbtn ${P.repeat !== 'off' ? 'on' : ''}" data-a="repeat" title="Repeat: ${P.repeat}" aria-label="Repeat ${P.repeat}">${P.repeat === 'ayah' ? '🔂' : '🔁'}</button>
        <button class="pbtn" data-a="close" aria-label="Stop">✕</button>`;
    }
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'toggle') P.playing ? pause() : resume();
      else if (a === 'prev') step(-1);
      else if (a === 'next') step(1);
      else if (a === 'close') stop();
      else if (a === 'repeat') {
        P.repeat = { off: 'ayah', ayah: 'surah', surah: 'off' }[P.repeat];
        toast({ off: 'Repeat off', ayah: 'Repeating this ayah', surah: 'Repeating the whole surah' }[P.repeat]);
        updateBar();
      }
    });

    function highlight(scroll) {
      document.querySelectorAll('.ayah.playing').forEach((el) => el.classList.remove('playing'));
      if (!P.surah) return;
      const el = document.getElementById(`a${P.surah}-${P.ayah}`);
      if (el) {
        el.classList.add('playing');
        if (scroll && settings.followAudio !== false) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    // ---------------- views ----------------
    function surahRow(s) {
      return `<a class="item" href="#/surah/${s.n}">
        <span class="snum">${s.n}</span>
        <div class="body"><div class="t">${esc(s.tr)}</div><div class="muted small">${esc(s.en)} · ${s.ayahs} ayahs · ${s.type}</div></div>
        <span class="sar">${esc(s.ar)}</span></a>`;
    }

    views.quran = (params) => {
      const tab = params.get('tab') || 'surah';
      const lr = lastRead();
      $view.innerHTML = `
        <h1>Quran</h1>
        ${lr ? `<a class="card hero" href="#/surah/${lr.s}?a=${lr.a}" style="display:block;text-decoration:none">
          <div class="muted small">Continue reading</div>
          <div style="font-size:20px;font-weight:700">${esc(SURAHS[lr.s - 1].tr)} · ayah ${lr.a}</div></a>` : ''}
        <input class="search" id="qs" type="search" placeholder="Surah name or number, 2:255, or words to search" autocomplete="off">
        <div class="chips">
          ${[['surah', 'Surahs'], ['juz', 'Juz'], ['bookmarks', `Bookmarks (${bookmarks.length})`]].map(([k, n]) => `<a class="chip ${tab === k ? 'on' : ''}" href="#/quran?tab=${k}" style="text-decoration:none">${n}</a>`).join('')}
        </div>
        <div id="qlist"></div>`;
      const box = document.getElementById('qlist');
      const input = document.getElementById('qs');
      const renderTab = () => {
        if (tab === 'juz') {
          box.innerHTML = `<div class="list">${IDX.juz.map(([s, a], i) => `<a class="item" href="#/surah/${s}?a=${a}">
            <span class="snum">${i + 1}</span><div class="body"><div class="t">Juz ${i + 1}</div><div class="muted small">Starts at ${esc(SURAHS[s - 1].tr)} ${s}:${a}</div></div></a>`).join('')}</div>`;
        } else if (tab === 'bookmarks') {
          box.innerHTML = bookmarks.length ? `<div class="list">${bookmarks.map((b) => `<a class="item" href="#/surah/${b.s}?a=${b.a}">
            <span class="snum">🔖</span><div class="body"><div class="t">${esc(SURAHS[b.s - 1].tr)} ${b.s}:${b.a}</div><div class="muted small">${new Date(b.t).toLocaleDateString()}</div></div></a>`).join('')}</div>`
            : '<div class="empty">Tap the bookmark on any ayah to save it here.</div>';
        } else {
          box.innerHTML = `<div class="list">${SURAHS.map(surahRow).join('')}</div>`;
        }
      };
      let searchToken = 0;
      input.addEventListener('input', async () => {
        const v = input.value.trim();
        const token = ++searchToken;
        if (!v) return renderTab();
        const ref = v.match(/^(\d{1,3})\s*[:.\s]\s*(\d{1,3})$/);
        if (ref) {
          const s = +ref[1], a = +ref[2];
          if (SURAHS[s - 1] && a >= 1 && a <= SURAHS[s - 1].ayahs) {
            box.innerHTML = `<div class="list"><a class="item" href="#/surah/${s}?a=${a}"><span class="snum">→</span><div class="body"><div class="t">Go to ${esc(SURAHS[s - 1].tr)} ${s}:${a}</div></div></a></div>`;
            return;
          }
        }
        const norm = (x) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ'`\-]/g, '');
        const n = norm(v);
        const names = SURAHS.filter((s) => String(s.n) === v || norm(s.tr).includes(n) || norm(s.en).includes(n) || s.ar.includes(v));
        box.innerHTML = (names.length ? `<div class="list">${names.map(surahRow).join('')}</div>` : '') +
          (v.length >= 3 ? `<h2>In the text</h2><div id="ftres" class="muted small">Searching…</div>` : '');
        if (v.length < 3) return;
        // full-text search over the English and transliteration (loads all surahs once)
        await new Promise((r) => setTimeout(r, 250));
        if (token !== searchToken) return;
        const all = await Promise.all(SURAHS.map((s) => loadSurah(s.n)));
        if (token !== searchToken) return;
        const hits = [];
        all.forEach((d, i) => d.en.forEach((t, j) => {
          if (hits.length < 60 && (norm(t).includes(n) || norm(d.tr[j]).includes(n))) hits.push({ s: i + 1, a: j + 1, t });
        }));
        const el = document.getElementById('ftres');
        if (el) el.outerHTML = hits.length ? `<div class="list">${hits.map((h) => `<a class="item" href="#/surah/${h.s}?a=${h.a}"><div class="body"><div class="t">${esc(SURAHS[h.s - 1].tr)} ${h.s}:${h.a}</div><div class="muted small">${esc(h.t.length > 160 ? h.t.slice(0, 160) + '…' : h.t)}</div></div></a>`).join('')}</div>${hits.length === 60 ? '<p class="muted small">Showing the first 60 matches.</p>' : ''}`
          : `<div class="empty">No ayahs match “${esc(v)}”.</div>`;
      });
      renderTab();
    };

    views.surah = async (params, nStr) => {
      const n = Number(nStr);
      const meta = SURAHS[n - 1];
      if (!meta) { location.hash = '#/quran'; return; }
      const target = Number(params.get('a') || 0);
      $view.innerHTML = `<a class="back" href="#/quran">‹ Quran</a><div class="empty">Loading ${esc(meta.tr)}…</div>`;
      let data;
      try { data = await loadSurah(n); } catch (e) { $view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      if (!location.hash.startsWith(`#/surah/${n}`)) return; // user navigated away while loading
      $view.innerHTML = `
        <a class="back" href="#/quran">‹ Quran</a>
        <div class="card surah-head">
          <div class="sar-big">${esc(meta.ar)}</div>
          <div style="font-size:20px;font-weight:700">${n}. ${esc(meta.tr)}</div>
          <div class="muted small">${esc(meta.en)} · ${meta.ayahs} ayahs · ${meta.type}</div>
          <div class="actions" style="justify-content:center">
            <button class="btn primary" id="playAll">▶ Play surah</button>
            <select class="btn" id="rec" aria-label="Reciter">${RECITERS.map((r) => `<option value="${r.id}" ${r.id === reciter().id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
          </div>
        </div>
        ${n !== 1 && n !== 9 ? `<div class="bism">${esc(IDX.bismillah)}</div>` : ''}
        <div id="ayahs">${data.ar.map((ar, i) => {
          const a = i + 1;
          return `<div class="ayah" id="a${n}-${a}" data-a="${a}">
            <div class="ayah-top"><span class="anum">${n}:${a}</span>
              <span class="ayah-actions">
                <button class="icon-btn" data-act="play" aria-label="Play ayah ${a}">▶</button>
                <button class="icon-btn ${isBookmarked(n, a) ? 'on' : ''}" data-act="mark" aria-label="Bookmark ayah ${a}">🔖</button>
                <button class="icon-btn" data-act="share" aria-label="Share ayah ${a}">⤴</button>
              </span></div>
            <p class="qar">${esc(ar)} <span class="aend">﴿${arNum(a)}﴾</span></p>
            ${settings.showTr ? `<p class="translit">${esc(data.tr[i])}</p>` : ''}
            ${settings.showEn ? `<p class="trans">${esc(data.en[i])}</p>` : ''}
          </div>`;
        }).join('')}</div>
        <div class="actions" style="justify-content:space-between;margin-top:16px">
          <a class="btn" ${n > 1 ? `href="#/surah/${n - 1}"` : 'style="visibility:hidden"'}>‹ ${n > 1 ? esc(SURAHS[n - 2].tr) : ''}</a>
          <a class="btn" ${n < 114 ? `href="#/surah/${n + 1}"` : 'style="visibility:hidden"'}>${n < 114 ? esc(SURAHS[n].tr) : ''} ›</a>
        </div>
        <p class="muted small" style="margin-top:20px">${esc(IDX.credits)}</p>`;

      document.getElementById('rec').onchange = (e) => {
        settings.reciter = e.target.value; saveSettings();
        toast(`Reciter: ${reciter().name}`);
        if (P.surah) playAyah(P.surah, P.ayah);
      };
      document.getElementById('playAll').onclick = () => {
        if (P.surah === n && audio.src) { P.playing ? pause() : resume(); return; }
        const firstVisible = currentTopAyah() || 1;
        playAyah(n, firstVisible, { basmala: firstVisible === 1 });
      };
      document.getElementById('ayahs').addEventListener('click', async (e) => {
        const b = e.target.closest('button[data-act]');
        if (!b) return;
        const a = Number(b.closest('.ayah').dataset.a);
        if (b.dataset.act === 'play') {
          if (P.surah === n && P.ayah === a && P.playing) pause(); else playAyah(n, a);
        } else if (b.dataset.act === 'mark') {
          if (isBookmarked(n, a)) bookmarks = bookmarks.filter((x) => !(x.s === n && x.a === a));
          else bookmarks.unshift({ s: n, a, t: Date.now() });
          saveBookmarks();
          b.classList.toggle('on', isBookmarked(n, a));
          toast(isBookmarked(n, a) ? `Bookmarked ${n}:${a}` : 'Bookmark removed');
        } else if (b.dataset.act === 'share') {
          const text = `${data.ar[a - 1]}\n\n${data.en[a - 1]}\n\n(Quran ${n}:${a}, ${meta.tr})`;
          const r = await Platform.share(`Quran ${n}:${a}`, text);
          if (r === 'copied') toast('Copied, ready to paste');
        }
      });

      // remember where the reader is
      function currentTopAyah() {
        const els = document.querySelectorAll('#ayahs .ayah');
        for (const el of els) { if (el.getBoundingClientRect().bottom > 80) return Number(el.dataset.a); }
        return 0;
      }
      let t = null;
      const onScroll = () => {
        clearTimeout(t);
        t = setTimeout(() => { const a = currentTopAyah(); if (a) store.set('qlast', { s: n, a }); }, 400);
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      ctx.setCleanup(() => { window.removeEventListener('scroll', onScroll); clearTimeout(t); });

      if (target > 1) {
        const el = document.getElementById(`a${n}-${target}`);
        if (el) { el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -12); el.classList.add('flash'); }
      } else {
        window.scrollTo(0, 0);
      }
      store.set('qlast', { s: n, a: target || 1 });
      highlight(false);
    };

    return { RECITERS, lastRead, surahs: SURAHS, scrollsItself: ['surah'] };
  }

  window.SakinaQuranUI = { install, RECITERS };
})();
