const test = require('node:test');
const assert = require('node:assert');
const A = require('../app/js/astro.js');

const hm = (d, tz) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz, hourCycle: 'h23' }).format(d);
const mins = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const near = (actual, expected, tol, label) =>
  assert.ok(Math.abs(mins(actual) - mins(expected)) <= tol, `${label}: got ${actual}, expected about ${expected}`);

// Reference values cross-checked against the open-source "adhan" library (within 2 minutes).
test('Makkah, Umm al-Qura, 31 Oct 2026', () => {
  const t = A.prayerTimes(new Date(2026, 9, 31, 12), 21.4225, 39.8262, { method: 'Makkah' });
  const tz = 'Asia/Riyadh';
  near(hm(t.fajr, tz), '05:06', 2, 'fajr');
  near(hm(t.dhuhr, tz), '12:04', 2, 'dhuhr');
  near(hm(t.maghrib, tz), '17:45', 2, 'maghrib');
  assert.equal(Math.round((t.isha - t.maghrib) / 60000), 90, 'isha is 90 minutes after maghrib');
});

test('times are in order for many places and dates', () => {
  const places = [[51.5, -0.12], [40.7, -74], [-33.9, 151.2], [24.86, 67], [59.9, 10.75], [-6.2, 106.8]];
  for (const [lat, lng] of places) {
    for (let m = 0; m < 12; m++) {
      const t = A.prayerTimes(new Date(2026, m, 15, 12), lat, lng, { method: 'MWL' });
      const seq = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'].map((k) => t[k]);
      seq.forEach((d, i) => assert.ok(d instanceof Date && !isNaN(d), `${lat},${lng} m${m} #${i} invalid`));
      for (let i = 1; i < seq.length; i++) assert.ok(seq[i] > seq[i - 1], `${lat},${lng} month ${m}: order broken at ${i}`);
    }
  }
});

test('Hanafi Asr is later than standard Asr', () => {
  const d = new Date(2026, 9, 31, 12);
  const s = A.prayerTimes(d, 24.86, 67, { method: 'Karachi' });
  const h = A.prayerTimes(d, 24.86, 67, { method: 'Karachi', asr: 'hanafi' });
  assert.ok(h.asr - s.asr > 20 * 60000);
});

test('Qibla bearings', () => {
  assert.ok(Math.abs(A.qibla(51.5074, -0.1278) - 119) < 1, 'London about 119°');
  assert.ok(Math.abs(A.qibla(40.7128, -74.006) - 58.5) < 1, 'New York about 58°');
  assert.ok(Math.abs(A.qibla(-6.2088, 106.8456) - 295) < 1.5, 'Jakarta about 295°');
});
