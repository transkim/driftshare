/*
 * Sakina astronomy helpers: prayer times, Qibla bearing.
 * Prayer times use standard solar position formulas (accuracy around one minute).
 */
(function (root) {
  const DEG = Math.PI / 180;
  const sin = (d) => Math.sin(d * DEG);
  const cos = (d) => Math.cos(d * DEG);
  const tan = (d) => Math.tan(d * DEG);
  const asin = (x) => Math.asin(x) / DEG;
  const acos = (x) => Math.acos(x) / DEG;
  const atan2 = (y, x) => Math.atan2(y, x) / DEG;
  const fix = (a, b) => { a = a - b * Math.floor(a / b); return a < 0 ? a + b : a; };

  // fajr/isha: degrees below horizon. ishaMin: fixed minutes after maghrib instead.
  const METHODS = {
    MWL: { name: 'Muslim World League', fajr: 18, isha: 17 },
    ISNA: { name: 'Islamic Society of North America', fajr: 15, isha: 15 },
    Egypt: { name: 'Egyptian General Authority of Survey', fajr: 19.5, isha: 17.5 },
    Makkah: { name: 'Umm al-Qura, Makkah', fajr: 18.5, ishaMin: 90 },
    Karachi: { name: 'University of Islamic Sciences, Karachi', fajr: 18, isha: 18 },
    Tehran: { name: 'Institute of Geophysics, Tehran', fajr: 17.7, isha: 14, maghrib: 4.5 },
    Gulf: { name: 'Gulf region', fajr: 19.5, ishaMin: 90 },
    Kuwait: { name: 'Kuwait', fajr: 18, isha: 17.5 },
    Qatar: { name: 'Qatar', fajr: 18, ishaMin: 90 },
    Dubai: { name: 'Dubai', fajr: 18.2, isha: 18.2 },
    Singapore: { name: 'Singapore, Malaysia, Indonesia', fajr: 20, isha: 18 },
    Turkey: { name: 'Turkey (Diyanet, approximate)', fajr: 18, isha: 17 },
    France: { name: 'France (UOIF, 12°)', fajr: 12, isha: 12 },
    Russia: { name: 'Russia', fajr: 16, isha: 15 },
  };

  function julian(y, m, d) {
    if (m <= 2) { y -= 1; m += 12; }
    const A = Math.floor(y / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
  }

  function sunPosition(jd) {
    const D = jd - 2451545.0;
    const g = fix(357.529 + 0.98560028 * D, 360);
    const q = fix(280.459 + 0.98564736 * D, 360);
    const L = fix(q + 1.915 * sin(g) + 0.020 * sin(2 * g), 360);
    const e = 23.439 - 0.00000036 * D;
    const RA = atan2(cos(e) * sin(L), cos(L)) / 15;
    const eqt = q / 15 - fix(RA, 24);
    const decl = asin(sin(e) * sin(L));
    return { decl, eqt };
  }

  /**
   * Compute prayer times for a calendar date at a location.
   * Returns Date objects (absolute instants). Format them in the place's time zone.
   * opts: { method: 'MWL', asr: 'standard'|'hanafi', highLat: 'angle'|'none' }
   */
  function prayerTimes(date, lat, lng, opts = {}) {
    const method = METHODS[opts.method] || METHODS.MWL;
    const asrFactor = opts.asr === 'hanafi' ? 2 : 1;
    const y = date.getFullYear(), mo = date.getMonth() + 1, d = date.getDate();
    const jDate = julian(y, mo, d) - lng / (15 * 24);

    const midDay = (t) => fix(12 - sunPosition(jDate + t).eqt, 24);
    const angleTime = (angle, t, ccw) => {
      const { decl } = sunPosition(jDate + t);
      const noon = midDay(t);
      const T = acos((-sin(angle) - sin(decl) * sin(lat)) / (cos(decl) * cos(lat))) / 15;
      return noon + (ccw ? -T : T);
    };
    const asrTime = (factor, t) => {
      const { decl } = sunPosition(jDate + t);
      const angle = -atan2(1, factor + tan(Math.abs(lat - decl))); // -arccot
      return angleTime(angle, t);
    };

    // times in local solar hours, iterate twice for precision
    let t = { fajr: 5, sunrise: 6, dhuhr: 12, asr: 13, sunset: 18, maghrib: 18, isha: 18 };
    for (let i = 0; i < 2; i++) {
      const p = {};
      for (const k in t) p[k] = t[k] / 24;
      t = {
        fajr: angleTime(method.fajr, p.fajr, true),
        sunrise: angleTime(0.833, p.sunrise, true),
        dhuhr: midDay(p.dhuhr),
        asr: asrTime(asrFactor, p.asr),
        sunset: angleTime(0.833, p.sunset),
        maghrib: method.maghrib ? angleTime(method.maghrib, p.maghrib) : angleTime(0.833, p.maghrib),
        isha: method.ishaMin ? NaN : angleTime(method.isha, p.isha),
      };
    }
    if (method.ishaMin) t.isha = t.maghrib + method.ishaMin / 60;

    // high latitude adjustment (angle-based)
    if (opts.highLat !== 'none') {
      const night = fix(t.sunrise - t.sunset, 24);
      const fajrMax = (method.fajr / 60) * night;
      if (isNaN(t.fajr) || fix(t.sunrise - t.fajr, 24) > fajrMax) t.fajr = t.sunrise - fajrMax;
      if (!method.ishaMin) {
        const ishaMax = (method.isha / 60) * night;
        if (isNaN(t.isha) || fix(t.isha - t.sunset, 24) > ishaMax) t.isha = t.sunset + ishaMax;
      }
    }

    const base = Date.UTC(y, mo - 1, d);
    const out = {};
    for (const k of ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha']) {
      const utcHours = t[k] - lng / 15;
      out[k] = isNaN(utcHours) ? null : new Date(base + Math.round(utcHours * 3600) * 1000);
    }
    return out;
  }

  const KAABA = { lat: 21.422487, lng: 39.826206 };
  function qibla(lat, lng) {
    const dLng = KAABA.lng - lng;
    const b = atan2(sin(dLng), cos(lat) * tan(KAABA.lat) - sin(lat) * cos(dLng));
    return fix(b, 360);
  }

  function distanceKm(lat, lng) {
    const dLat = (KAABA.lat - lat) * DEG, dLng = (KAABA.lng - lng) * DEG;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * DEG) * Math.cos(KAABA.lat * DEG) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  const api = { METHODS, prayerTimes, qibla, distanceKm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SakinaAstro = api;
})(typeof window !== 'undefined' ? window : globalThis);
