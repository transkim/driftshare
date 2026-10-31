/* Sakina app: views, routing and state. */
(function () {
  const { categories, duas, dhikr } = window.SakinaData;
  const Astro = window.SakinaAstro;
  const cities = window.SakinaCities;
  const $view = document.getElementById('view');

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('sakina.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('sakina.' + k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
  };
  const DEFAULTS = {
    theme: 'auto', arSize: 30, showTr: true, showEn: true,
    location: null, method: 'MWL', methodAuto: true, asr: 'standard', hijriAdj: 0,
    dailyOn: false, dailyTime: '08:00', prayerAlerts: false, tasbihTarget: 0,
    reciter: 'Alafasy_128kbps', autoNextSurah: false, followAudio: true,
  };
  const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);
  let favs = new Set(store.get('favs', []));
  const saveFavs = () => store.set('favs', [...favs]);

  // ---------- helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const catById = Object.fromEntries(categories.map((c) => [c.id, c]));
  const duaById = Object.fromEntries(duas.map((d) => [d.id, d]));
  const PRAYERS = [['fajr', 'Fajr'], ['sunrise', 'Sunrise'], ['dhuhr', 'Dhuhr'], ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha']];
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function applyTheme() {
    const dark = settings.theme === 'dark' || (settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.setProperty('--ar-size', settings.arSize + 'px');
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  const tzOf = () => (settings.location && settings.location.tz) || deviceTz;
  function fmtTime(d) {
    if (!d) return '--:--';
    return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', timeZone: tzOf() }).format(d);
  }
  // calendar date "today" at the chosen location, shifted by offset days
  function localDate(offset = 0) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tzOf(), year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date()).map((p) => [p.type, p.value]));
    return new Date(+parts.year, +parts.month - 1, +parts.day + offset, 12);
  }
  function gregorian(d) {
    return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function hijri(d) {
    const x = new Date(d); x.setDate(x.getDate() + Number(settings.hijriAdj || 0));
    try {
      return new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' }).format(x).replace(/\s?AH$/, '') + ' AH';
    } catch (_) { return ''; }
  }
  function timesFor(offset = 0) {
    const L = settings.location;
    if (!L) return null;
    return Astro.prayerTimes(localDate(offset), L.lat, L.lng, { method: settings.method, asr: settings.asr });
  }
  function nextPrayer() {
    const now = new Date();
    for (const off of [0, 1]) {
      const t = timesFor(off);
      if (!t) return null;
      for (const [k, name] of PRAYERS) {
        if (k === 'sunrise') continue;
        if (t[k] && t[k] > now) return { key: k, name, at: t[k] };
      }
    }
    return null;
  }
  function countdown(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
  }
  function guessMethod(tz) {
    const map = [
      [/^America\//, 'ISNA'], [/Karachi|Kolkata|Dhaka|Kabul|Colombo/, 'Karachi'], [/Riyadh|Aden/, 'Makkah'],
      [/Cairo|Khartoum|Tripoli/, 'Egypt'], [/Dubai|Muscat/, 'Dubai'], [/Qatar|Bahrain/, 'Qatar'], [/Kuwait/, 'Kuwait'],
      [/Istanbul/, 'Turkey'], [/Kuala_Lumpur|Singapore|Jakarta|Brunei|Makassar|Jayapura/, 'Singapore'], [/Tehran/, 'Tehran'],
      [/Moscow|Samara|Yekaterinburg/, 'Russia'],
    ];
    for (const [re, m] of map) if (re.test(tz)) return m;
    return 'MWL';
  }
  function setLocation(loc) {
    settings.location = loc;
    if (settings.methodAuto) settings.method = guessMethod(loc.tz || deviceTz);
    saveSettings(); reschedule();
  }
  function dailyIndex() {
    const d = localDate();
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
  }
  const duaOfDay = () => duas[dailyIndex() % duas.length];

  // ---------- notifications ----------
  async function reschedule() {
    const items = [];
    if (settings.prayerAlerts && settings.location) {
      let id = 100;
      for (let off = 0; off < 7; off++) {
        const t = timesFor(off);
        for (const [k, name] of PRAYERS) {
          if (k === 'sunrise' || !t[k]) continue;
          items.push({ id: id++, at: t[k], title: `${name} · ${fmtTime(t[k])}`, body: `It is time for ${name} in ${settings.location.name}.` });
        }
      }
    }
    let daily = null;
    if (settings.dailyOn) {
      const [hour, minute] = settings.dailyTime.split(':').map(Number);
      const d = duaOfDay();
      daily = { hour, minute, title: 'A dua for today', body: `${d.title}: ${d.en}`.slice(0, 180) };
    }
    await Platform.schedule(items, daily);
  }

  // ---------- views ----------
  let cleanup = null;
  const views = {};

  views.home = () => {
    const today = localDate();
    const np = nextPrayer();
    const d = duaOfDay();
    const L = settings.location;
    $view.innerHTML = `
      <div class="card hero">
        <div class="muted small">${esc(gregorian(today))}</div>
        <div style="font-size:18px;font-weight:600;margin-bottom:14px">${esc(hijri(today))}</div>
        ${np ? `
          <div class="row">
            <div><div class="muted small">Next prayer${L ? ' in ' + esc(L.name) : ''}</div><div class="big">${np.name} ${fmtTime(np.at)}</div></div>
            <div class="muted" id="cd">in ${countdown(np.at - new Date())}</div>
          </div>` : `
          <div class="muted">Set your location to see prayer times.</div>
          <div style="margin-top:10px"><a class="btn" href="#/settings" style="color:inherit;background:rgba(255,255,255,.15);border-color:transparent">Choose location</a></div>`}
      </div>

      ${(() => { const lr = Q.lastRead(); return lr ? `<a class="card" href="#/surah/${lr.s}?a=${lr.a}" style="display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit">
        <span style="font-size:26px">📖</span><div style="flex:1"><div class="muted small">Continue reading</div><div style="font-weight:600">${esc(Q.surahs[lr.s - 1].tr)} · ayah ${lr.a}</div></div><span class="muted">›</span></a>` : ''; })()}

      <h2>Dua of the day</h2>
      <a class="card" href="#/dua/${d.id}" style="display:block;text-decoration:none;color:inherit">
        <div class="muted small">${esc(catById[d.cat].name)}</div>
        <div style="font-weight:600;margin:2px 0 4px">${esc(d.title)}</div>
        <div class="ar" style="margin:4px 0 8px;font-size:calc(var(--ar-size) * .85)">${esc(d.ar)}</div>
        <div class="muted">${esc(d.en)}</div>
      </a>

      <h2>Browse</h2>
      <div class="grid">
        <a class="tile" href="#/quran"><span class="ic">📖</span><span class="t">The Quran</span><span class="c">114 surahs, with recitation</span></a>
        <a class="tile" href="#/fav"><span class="ic">⭐</span><span class="t">Favourites</span><span class="c">${favs.size} saved</span></a>
        ${categories.slice(0, 4).map(tile).join('')}
        <a class="tile" href="#/duas"><span class="ic">➕</span><span class="t">All categories</span><span class="c">${duas.length} duas</span></a>
      </div>`;
    if (np) {
      const iv = setInterval(() => {
        const el = document.getElementById('cd');
        if (!el) return;
        if (np.at <= new Date()) return route();
        el.textContent = 'in ' + countdown(np.at - new Date());
      }, 1000);
      cleanup = () => clearInterval(iv);
    }
  };

  function tile(c) {
    const n = duas.filter((d) => d.cat === c.id).length;
    return `<a class="tile" href="#/cat/${c.id}"><span class="ic">${c.icon}</span><span class="t">${esc(c.name)}</span><span class="c">${n} dua${n === 1 ? '' : 's'}</span></a>`;
  }
  function item(d) {
    return `<a class="item" href="#/dua/${d.id}">
      <div class="body"><div class="t">${esc(d.title)}</div><div class="ar-preview">${esc(d.ar)}</div></div>
      ${d.repeat > 1 ? `<span class="badge">×${d.repeat}</span>` : ''}
      ${favs.has(d.id) ? '<span title="Favourite">⭐</span>' : ''}
    </a>`;
  }

  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ًͯ-ْٰ']/g, '');
  function search(q) {
    const n = norm(q.trim());
    if (!n) return [];
    return duas.filter((d) => norm([d.title, d.en, d.tr, d.ar, d.src, catById[d.cat].name].join(' ')).includes(n));
  }

  views.duas = (params) => {
    const q = params.get('q') || '';
    $view.innerHTML = `
      <h1>Duas</h1>
      <input class="search" id="q" type="search" placeholder="Search duas, e.g. travel, rain, parents" value="${esc(q)}" autocomplete="off">
      <div id="results"></div>`;
    const input = document.getElementById('q');
    const render = () => {
      const v = input.value;
      history.replaceState(null, '', v ? '#/duas?q=' + encodeURIComponent(v) : '#/duas');
      const box = document.getElementById('results');
      if (!v.trim()) {
        box.innerHTML = `<div class="grid">
          <a class="tile" href="#/fav"><span class="ic">⭐</span><span class="t">Favourites</span><span class="c">${favs.size} saved</span></a>
          ${categories.map(tile).join('')}</div>`;
        return;
      }
      const r = search(v);
      box.innerHTML = r.length ? `<div class="list">${r.map(item).join('')}</div>` : `<div class="empty">No duas match “${esc(v)}”.</div>`;
    };
    input.addEventListener('input', render);
    render();
    if (q) input.focus();
  };

  views.cat = (params, id) => {
    const c = catById[id];
    if (!c) return go('#/duas');
    const list = duas.filter((d) => d.cat === id);
    $view.innerHTML = `
      <a class="back" href="#/duas">‹ Duas</a>
      <h1>${c.icon} ${esc(c.name)}</h1>
      <div class="list">${list.map(item).join('')}</div>`;
  };

  views.fav = () => {
    const list = duas.filter((d) => favs.has(d.id));
    $view.innerHTML = `
      <a class="back" href="#/duas">‹ Duas</a>
      <h1>⭐ Favourites</h1>
      ${list.length ? `<div class="list">${list.map(item).join('')}</div>` : '<div class="empty">Tap the star on any dua to keep it here.</div>'}`;
  };

  views.dua = (params, id) => {
    const d = duaById[id];
    if (!d) return go('#/duas');
    const siblings = duas.filter((x) => x.cat === d.cat);
    const i = siblings.indexOf(d);
    const prev = siblings[i - 1], next = siblings[i + 1];
    const c = catById[d.cat];
    let count = 0;
    $view.innerHTML = `
      <a class="back" href="#/cat/${c.id}">‹ ${esc(c.name)}</a>
      <div class="card">
        <h1 style="margin:0 0 4px;font-size:22px">${esc(d.title)}</h1>
        ${d.repeat > 1 ? `<span class="badge">Recite ${d.repeat} times</span>` : ''}
        <p class="ar">${esc(d.ar)}</p>
        ${settings.showTr ? `<p class="translit">${esc(d.tr)}</p>` : ''}
        ${settings.showEn ? `<p class="trans">${esc(d.en)}</p>` : ''}
        ${d.note ? `<div class="note">${esc(d.note)}</div>` : ''}
        <div class="src">Source: ${esc(d.src)}</div>
        ${d.repeat > 1 ? `<div class="counter"><button class="btn primary" id="cnt">Tap to count · 0 / ${d.repeat}</button><button class="btn" id="cntReset">Reset</button></div>` : ''}
        <div class="actions">
          <button class="btn ${favs.has(d.id) ? 'fav-on' : ''}" id="fav">${favs.has(d.id) ? '★ Saved' : '☆ Favourite'}</button>
          <button class="btn" id="copy">Copy</button>
          <button class="btn" id="share">Share</button>
        </div>
      </div>
      <div class="actions" style="justify-content:space-between">
        <a class="btn" ${prev ? `href="#/dua/${prev.id}"` : 'style="visibility:hidden"'}>‹ Previous</a>
        <a class="btn" ${next ? `href="#/dua/${next.id}"` : 'style="visibility:hidden"'}>Next ›</a>
      </div>`;
    const text = `${d.title}\n\n${d.ar}\n\n${d.tr}\n\n${d.en}\n\n(${d.src})`;
    document.getElementById('fav').onclick = (e) => {
      if (favs.has(d.id)) favs.delete(d.id); else favs.add(d.id);
      saveFavs();
      const on = favs.has(d.id);
      e.currentTarget.classList.toggle('fav-on', on);
      e.currentTarget.textContent = on ? '★ Saved' : '☆ Favourite';
      toast(on ? 'Added to favourites' : 'Removed from favourites');
    };
    document.getElementById('copy').onclick = async () => toast((await Platform.copy(text)) ? 'Copied' : 'Could not copy');
    document.getElementById('share').onclick = async () => {
      const r = await Platform.share(d.title, text);
      if (r === 'copied') toast('Copied, ready to paste');
    };
    const cnt = document.getElementById('cnt');
    if (cnt) {
      cnt.onclick = () => {
        count++;
        if (count >= d.repeat) { Platform.done(); cnt.textContent = `Done · ${count} / ${d.repeat}`; }
        else { Platform.tap(); cnt.textContent = `Tap to count · ${count} / ${d.repeat}`; }
      };
      document.getElementById('cntReset').onclick = () => { count = 0; cnt.textContent = `Tap to count · 0 / ${d.repeat}`; };
    }
  };

  views.tasbih = () => {
    const state = Object.assign({ id: dhikr[0].id, count: 0, day: '', today: 0 }, store.get('tasbih', {}));
    const dayKey = localDate().toDateString();
    if (state.day !== dayKey) { state.day = dayKey; state.today = 0; }
    const save = () => store.set('tasbih', state);
    const C = 2 * Math.PI * 140;

    const draw = () => {
      const z = dhikr.find((x) => x.id === state.id) || dhikr[0];
      const target = Number(settings.tasbihTarget) || z.target;
      const inRound = state.count % target || (state.count ? target : 0);
      $view.innerHTML = `
        <h1>Tasbih</h1>
        <div class="chips">${dhikr.map((x) => `<button class="chip ${x.id === z.id ? 'on' : ''}" data-id="${x.id}">${esc(x.tr)}</button>`).join('')}</div>
        <div class="tasbih">
          <div class="dhikr-ar">${esc(z.ar)}</div>
          <div class="muted" style="text-align:center;margin-top:-8px">${esc(z.en)}</div>
          <button class="ring" id="tap" aria-label="Count">
            <svg viewBox="0 0 300 300"><circle class="track" cx="150" cy="150" r="140"/><circle class="prog" id="prog" cx="150" cy="150" r="140" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - inRound / target)}"/></svg>
            <div class="inner"><div class="count" id="count">${state.count}</div><div class="of" id="of">round ${Math.floor(Math.max(0, state.count - 1) / target) + 1} · ${inRound}/${target}</div></div>
          </button>
          <div class="actions" style="justify-content:center">
            <button class="btn" id="reset">Reset</button>
            <select class="btn" id="target" aria-label="Target">
              ${[0, 33, 34, 99, 100, 1000].map((n) => `<option value="${n}" ${Number(settings.tasbihTarget) === n ? 'selected' : ''}>${n ? 'Target ' + n : 'Default target'}</option>`).join('')}
            </select>
          </div>
          <div class="muted small" id="todayTotal">Today: ${state.today} in total</div>
        </div>`;
      $view.querySelectorAll('.chip').forEach((b) => b.onclick = () => { state.id = b.dataset.id; state.count = 0; save(); draw(); });
      document.getElementById('reset').onclick = () => { state.count = 0; save(); draw(); };
      document.getElementById('target').onchange = (e) => { settings.tasbihTarget = Number(e.target.value); saveSettings(); draw(); };
      document.getElementById('tap').onclick = () => {
        state.count++; state.today++; save();
        const ir = state.count % target || target;
        document.getElementById('count').textContent = state.count;
        document.getElementById('todayTotal').textContent = `Today: ${state.today} in total`;
        document.getElementById('of').textContent = `round ${Math.floor((state.count - 1) / target) + 1} · ${ir}/${target}`;
        document.getElementById('prog').setAttribute('stroke-dashoffset', C * (1 - ir / target));
        if (ir === target) { Platform.done(); toast(`${target} complete. ${z.tr}!`); } else Platform.tap();
      };
    };
    draw();
    const key = (e) => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); document.getElementById('tap')?.click(); } };
    document.addEventListener('keydown', key);
    cleanup = () => document.removeEventListener('keydown', key);
  };

  views.prayer = (params) => {
    const L = settings.location;
    if (!L) {
      $view.innerHTML = `<h1>Prayer times</h1><div class="card"><p>Choose your location to see prayer times and the Qibla direction.</p>
        <div class="actions"><button class="btn primary" id="gps">Use my location</button><a class="btn" href="#/settings">Pick a city</a></div></div>`;
      document.getElementById('gps').onclick = detectLocation;
      return;
    }
    const off = Number(params.get('d') || 0);
    const t = timesFor(off);
    const np = off === 0 ? nextPrayer() : null;
    const day = localDate(off);
    const bearing = Astro.qibla(L.lat, L.lng);
    $view.innerHTML = `
      <h1>Prayer times</h1>
      <div class="card">
        <div class="daynav">
          <a class="btn" href="#/prayer?d=${off - 1}" aria-label="Previous day">‹</a>
          <div style="text-align:center"><div style="font-weight:600">${off === 0 ? 'Today' : esc(day.toLocaleDateString([], { weekday: 'long' }))}</div>
            <div class="muted small">${esc(day.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }))} · ${esc(hijri(day))}</div></div>
          <a class="btn" href="#/prayer?d=${off + 1}" aria-label="Next day">›</a>
        </div>
        <table class="ptable">${PRAYERS.map(([k, n]) => `<tr class="${k === 'sunrise' ? 'sun' : ''} ${np && np.key === k && t[k].getTime() === np.at.getTime() ? 'next' : ''}"><td>${n}</td><td>${fmtTime(t[k])}</td></tr>`).join('')}</table>
        <div class="muted small" style="margin-top:8px">📍 ${esc(L.name)} · ${esc(Astro.METHODS[settings.method].name)} · Asr ${settings.asr === 'hanafi' ? 'Hanafi' : 'standard'} · <a href="#/settings">change</a></div>
      </div>

      <h2>Qibla</h2>
      <div class="card" style="text-align:center">
        <div class="compass"><div class="dial" id="dial">
          <span style="top:6px">N</span><span style="bottom:6px">S</span>
          <span style="top:50%;left:12px;transform:translateY(-50%)">W</span><span style="top:50%;left:auto;right:12px;transform:translateY(-50%)">E</span>
          <div class="needle" style="transform:rotate(${bearing}deg)"><span class="kaaba">🕋</span></div>
          <div class="hub"></div>
        </div></div>
        <div style="font-size:22px;font-weight:700">${bearing.toFixed(1)}° from North</div>
        <div class="muted small" id="cmp">${Platform.platform === 'android' ? 'Hold your phone flat. The needle points to the Kaaba.' : 'Face this many degrees clockwise from true North.'}</div>
        <div class="muted small">${Math.round(Astro.distanceKm(L.lat, L.lng)).toLocaleString()} km to Makkah</div>
      </div>`;

    // live compass where available
    let got = false;
    const onOrient = (e) => {
      let heading = null;
      if (typeof e.webkitCompassHeading === 'number') heading = e.webkitCompassHeading;
      else if (e.absolute && typeof e.alpha === 'number') heading = 360 - e.alpha;
      if (heading == null) return;
      got = true;
      const dial = document.getElementById('dial');
      if (dial) dial.style.transform = `rotate(${-heading}deg)`;
      const diff = Math.abs(((bearing - heading + 540) % 360) - 180);
      const el = document.getElementById('cmp');
      if (el) el.textContent = diff < 5 ? 'You are facing the Qibla ✓' : 'Turn until the needle points straight up.';
    };
    const evt = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(evt, onOrient);
    const tm = setTimeout(() => {
      if (!got && Platform.platform === 'android') {
        const el = document.getElementById('cmp');
        if (el) el.textContent = 'No compass found. Face the angle above, clockwise from North.';
      }
    }, 3000);
    cleanup = () => { window.removeEventListener(evt, onOrient); clearTimeout(tm); };
  };

  async function detectLocation() {
    toast('Finding your location…');
    try {
      const p = await Platform.getPosition();
      // name it after the nearest known city if close, otherwise by coordinates
      let best = null, bestD = Infinity;
      for (const c of cities) {
        const dd = (c.lat - p.lat) ** 2 + ((c.lng - p.lng) * Math.cos(p.lat * Math.PI / 180)) ** 2;
        if (dd < bestD) { bestD = dd; best = c; }
      }
      const near = Math.sqrt(bestD) * 111 < 40;
      setLocation({ name: near ? best.name : `${p.lat.toFixed(2)}, ${p.lng.toFixed(2)}`, lat: p.lat, lng: p.lng, tz: deviceTz });
      toast('Location set');
      route();
    } catch (e) {
      toast(e.message + ' Pick a city instead.');
    }
  }

  views.settings = () => {
    const L = settings.location;
    const cityOpts = cities.map((c, i) => `<option value="${i}" ${L && L.name === c.name && L.lat === c.lat ? 'selected' : ''}>${esc(c.name)}, ${esc(c.country)}</option>`).join('');
    $view.innerHTML = `
      <h1>Settings</h1>
      <h2>Location & prayer times</h2>
      <div class="card">
        <div class="field"><label>Current location<div class="muted small">${L ? esc(L.name) + ` (${L.lat.toFixed(3)}, ${L.lng.toFixed(3)})` : 'Not set'}</div></label><button class="btn" id="gps">Detect</button></div>
        <div class="field"><label for="city">Choose a city</label><select id="city"><option value="">Select…</option>${cityOpts}</select></div>
        <div class="field"><label>Or enter coordinates<div class="muted small">Latitude, longitude</div></label>
          <span style="display:flex;gap:6px;max-width:60%"><input id="coords" type="text" placeholder="51.50, -0.12" style="max-width:none;width:100%"><button class="btn" id="setc">Set</button></span></div>
        <div class="field"><label for="method">Calculation method</label><select id="method">${Object.entries(Astro.METHODS).map(([k, m]) => `<option value="${k}" ${settings.method === k ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="asr">Asr time</label><select id="asr"><option value="standard">Standard (Shafi'i, Maliki, Hanbali)</option><option value="hanafi" ${settings.asr === 'hanafi' ? 'selected' : ''}>Hanafi</option></select></div>
        <div class="field"><label for="hadj">Hijri date adjustment</label><select id="hadj">${[-2, -1, 0, 1, 2].map((n) => `<option value="${n}" ${Number(settings.hijriAdj) === n ? 'selected' : ''}>${n > 0 ? '+' + n : n} day${Math.abs(n) === 1 ? '' : 's'}</option>`).join('')}</select></div>
      </div>

      <h2>Reminders</h2>
      <div class="card">
        <div class="field"><label for="palerts">Prayer time alerts<div class="muted small">${Platform.platform === 'android' ? 'Scheduled for the next 7 days, refreshed when you open the app' : 'Shown while Sakina is running (it stays in the system tray)'}</div></label><input type="checkbox" class="switch" id="palerts" ${settings.prayerAlerts ? 'checked' : ''}></div>
        <div class="field"><label for="daily">Daily dua reminder</label><input type="checkbox" class="switch" id="daily" ${settings.dailyOn ? 'checked' : ''}></div>
        <div class="field"><label for="dtime">Reminder time</label><input type="time" id="dtime" value="${esc(settings.dailyTime)}"></div>
      </div>

      <h2>Quran recitation</h2>
      <div class="card">
        <div class="field"><label for="reciter">Reciter<div class="muted small">Streams over the internet</div></label><select id="reciter">${Q.RECITERS.map((r) => `<option value="${r.id}" ${settings.reciter === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="follow">Scroll to the ayah being recited</label><input type="checkbox" class="switch" id="follow" ${settings.followAudio !== false ? 'checked' : ''}></div>
        <div class="field"><label for="autonext">Continue to the next surah</label><input type="checkbox" class="switch" id="autonext" ${settings.autoNextSurah ? 'checked' : ''}></div>
      </div>

      <h2>Reading</h2>
      <div class="card">
        <div class="field"><label for="theme">Theme</label><select id="theme">${['auto', 'light', 'dark'].map((t) => `<option value="${t}" ${settings.theme === t ? 'selected' : ''}>${t === 'auto' ? 'Match system' : t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select></div>
        <div class="field"><label for="ars">Arabic text size</label><input type="range" id="ars" min="22" max="48" value="${settings.arSize}"></div>
        <div class="ar" id="arPrev" style="margin:0">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</div>
        <div class="field"><label for="str">Show transliteration</label><input type="checkbox" class="switch" id="str" ${settings.showTr ? 'checked' : ''}></div>
        <div class="field"><label for="sen">Show English meaning</label><input type="checkbox" class="switch" id="sen" ${settings.showEn ? 'checked' : ''}></div>
      </div>

      <h2>About</h2>
      <div class="card small">
        <p style="margin-top:0"><b>Sakina</b> 0.2.0 · works offline, except Quran recitation.</p>
        <p>Arabic texts are from the Qur'an and the hadith collections named on each dua. Transliterations and English meanings are written for Sakina and are approximate; please check with a teacher you trust, and report any mistake.</p>
        <p>Quran: Tanzil Uthmani text (tanzil.net, CC BY 3.0, used unchanged), English by M. H. Shakir and transliteration via tanzil.net. Recitations stream from everyayah.com. Quran font: Amiri Quran (SIL OFL).</p>
        <p>Prayer times are calculated on your device and may differ by a minute or two from your local mosque. Arabic font: Amiri (SIL Open Font License).</p>
      </div>`;

    const $ = (id) => document.getElementById(id);
    $('gps').onclick = detectLocation;
    $('city').onchange = (e) => {
      if (e.target.value === '') return;
      const c = cities[Number(e.target.value)];
      setLocation({ name: c.name, lat: c.lat, lng: c.lng, tz: c.tz });
      toast(`Location set to ${c.name}`); route();
    };
    $('setc').onclick = () => {
      const m = $('coords').value.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
      if (!m || Math.abs(+m[1]) > 90 || Math.abs(+m[2]) > 180) return toast('Enter latitude, longitude, e.g. 51.5, -0.12');
      setLocation({ name: `${(+m[1]).toFixed(2)}, ${(+m[2]).toFixed(2)}`, lat: +m[1], lng: +m[2], tz: deviceTz });
      toast('Location set'); route();
    };
    $('method').onchange = (e) => { settings.method = e.target.value; settings.methodAuto = false; saveSettings(); reschedule(); };
    $('asr').onchange = (e) => { settings.asr = e.target.value; saveSettings(); reschedule(); };
    $('hadj').onchange = (e) => { settings.hijriAdj = Number(e.target.value); saveSettings(); };
    const toggleNotify = (key) => async (e) => {
      if (e.target.checked && !(await Platform.askNotify())) {
        e.target.checked = false; toast('Notifications are blocked. Allow them in system settings.'); return;
      }
      if (key === 'prayerAlerts' && e.target.checked && !settings.location) toast('Set a location first so alerts can be scheduled.');
      settings[key] = e.target.checked; saveSettings(); reschedule();
      if (e.target.checked) toast('Reminder on');
    };
    $('palerts').onchange = toggleNotify('prayerAlerts');
    $('daily').onchange = toggleNotify('dailyOn');
    $('dtime').onchange = (e) => { settings.dailyTime = e.target.value || '08:00'; saveSettings(); reschedule(); };
    $('reciter').onchange = (e) => { settings.reciter = e.target.value; saveSettings(); };
    $('follow').onchange = (e) => { settings.followAudio = e.target.checked; saveSettings(); };
    $('autonext').onchange = (e) => { settings.autoNextSurah = e.target.checked; saveSettings(); };
    $('theme').onchange = (e) => { settings.theme = e.target.value; saveSettings(); applyTheme(); };
    $('ars').oninput = (e) => { settings.arSize = Number(e.target.value); saveSettings(); applyTheme(); };
    $('str').onchange = (e) => { settings.showTr = e.target.checked; saveSettings(); };
    $('sen').onchange = (e) => { settings.showEn = e.target.checked; saveSettings(); };
  };

  // ---------- Quran ----------
  const Q = window.SakinaQuranUI.install({
    views, store, settings, saveSettings, esc, toast, Platform,
    setCleanup: (f) => { cleanup = f; },
  });

  // ---------- routing ----------
  const TAB_OF = { quran: 'quran', surah: 'quran', home: 'home', duas: 'duas', cat: 'duas', fav: 'duas', dua: 'duas', tasbih: 'tasbih', prayer: 'prayer', settings: 'settings' };
  function go(h) { location.hash = h; }
  function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    const raw = location.hash.replace(/^#\/?/, '') || 'home';
    const [path, qs] = raw.split('?');
    const [name, arg] = path.split('/');
    const view = views[name] || views.home;
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (TAB_OF[name] || 'home')));
    view(new URLSearchParams(qs || ''), arg && decodeURIComponent(arg));
    if (!(name === 'duas' && new URLSearchParams(qs || '').get('q'))) window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  Platform.onBack(() => {
    const raw = location.hash.replace(/^#\/?/, '') || 'home';
    if (raw === 'home' || raw === '') Platform.exit();
    else history.back();
  });

  applyTheme();
  route();
  reschedule();
  // keep desktop timers and the home countdown fresh
  setInterval(() => { if (Platform.platform !== 'android') reschedule(); }, 30 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { reschedule(); if (/^#\/(home)?$/.test(location.hash || '#/')) route(); } });
})();
