/*
 * Platform layer: one API over Android (Capacitor plugins), Windows (Electron) and a plain browser.
 */
(function (root) {
  const cap = root.Capacitor;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const P = (cap && cap.Plugins) || {};
  const isDesktop = !!root.sakinaDesktop;
  const platform = isNative ? 'android' : isDesktop ? 'windows' : 'web';

  let desktopTimers = [];

  const Platform = {
    platform,

    tap() {
      try {
        if (isNative && P.Haptics) P.Haptics.impact({ style: 'LIGHT' });
        else if (navigator.vibrate) navigator.vibrate(12);
      } catch (_) { /* ignore */ }
    },
    done() {
      try {
        if (isNative && P.Haptics) P.Haptics.vibrate({ duration: 250 });
        else if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      } catch (_) { /* ignore */ }
    },

    async copy(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fall through */ }
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    },

    async share(title, text) {
      if (isNative && P.Share) {
        try { await P.Share.share({ title, text, dialogTitle: 'Share dua' }); return 'shared'; } catch (_) { return 'cancelled'; }
      }
      if (navigator.share) {
        try { await navigator.share({ title, text }); return 'shared'; } catch (_) { return 'cancelled'; }
      }
      return (await Platform.copy(text)) ? 'copied' : 'failed';
    },

    getPosition() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error('Location is not available on this device.'));
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
          (e) => reject(new Error(e.message || 'Could not get your location.')),
          { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 }
        );
      });
    },

    async askNotify() {
      if (isNative && P.LocalNotifications) {
        const r = await P.LocalNotifications.requestPermissions();
        return r.display === 'granted';
      }
      if (!('Notification' in root)) return false;
      if (Notification.permission === 'granted') return true;
      return (await Notification.requestPermission()) === 'granted';
    },

    /**
     * Replace all scheduled reminders.
     * items: [{ id, at: Date, title, body }] one-off alerts
     * daily: { hour, minute, title, body } | null
     */
    async schedule(items, daily) {
      if (isNative && P.LocalNotifications) {
        const LN = P.LocalNotifications;
        try {
          const pending = await LN.getPending();
          if (pending.notifications.length) await LN.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
          const list = items.filter((i) => i.at > new Date()).map((i) => ({
            id: i.id, title: i.title, body: i.body, schedule: { at: i.at, allowWhileIdle: true },
          }));
          if (daily) list.push({ id: 1, title: daily.title, body: daily.body, schedule: { on: { hour: daily.hour, minute: daily.minute }, allowWhileIdle: true } });
          if (list.length) await LN.schedule({ notifications: list });
        } catch (e) { console.warn('schedule failed', e); }
        return;
      }
      // desktop / browser: timers while the app is running
      desktopTimers.forEach(clearTimeout);
      desktopTimers = [];
      const now = Date.now();
      const show = (title, body) => {
        if ('Notification' in root && Notification.permission === 'granted') new Notification(title, { body, icon: 'img/icon.png' });
      };
      for (const i of items) {
        const ms = i.at - now;
        if (ms > 0 && ms < 2 ** 31 - 1) desktopTimers.push(setTimeout(() => show(i.title, i.body), ms));
      }
      if (daily) {
        const next = new Date();
        next.setHours(daily.hour, daily.minute, 0, 0);
        if (next <= new Date()) next.setDate(next.getDate() + 1);
        desktopTimers.push(setTimeout(() => show(daily.title, daily.body), next - now));
      }
    },

    onBack(handler) {
      if (isNative && P.App) P.App.addListener('backButton', handler);
    },
    exit() { if (isNative && P.App) P.App.exitApp(); },
  };

  root.Platform = Platform;
})(window);
