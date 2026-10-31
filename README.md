# Sakina

Duas, dhikr and prayer times for Windows and Android. Works fully offline.

- **Duas**: 53 duas in 12 categories (morning and evening, sleep, prayer, Qur'anic duas, forgiveness, hardship, food and fasting, home and travel, illness, family, guidance, everyday). Arabic with vowels, transliteration, English meaning and source. Search, favourites, copy and share, and a tap counter for duas recited several times.
- **Tasbih**: digital counter for 8 common adhkar, with targets (33, 99, 100…), rounds, haptic feedback on Android and a daily total. On Windows, Space or Enter counts.
- **Prayer times**: calculated on the device for any location (GPS, a list of 90 cities, or coordinates), 14 calculation methods, standard or Hanafi Asr, Hijri date (Umm al-Qura) with ±2 day adjustment.
- **Qibla**: bearing and distance to the Kaaba, with a live compass on phones.
- **Reminders**: prayer time alerts and a daily dua reminder. Android schedules them with the system; on Windows Sakina keeps running in the tray so they still fire.
- Light and dark themes, adjustable Arabic text size (Amiri font).

## Layout

| Path | What |
| --- | --- |
| `app/` | The whole app UI (HTML, CSS, plain JS). Shared by both platforms. |
| `app/js/duas.js` | Dua and dhikr content. |
| `app/js/astro.js` | Prayer time and Qibla calculations. |
| `src/` | Electron shell for Windows (tray, single instance, notifications). |
| `mobile/` | Capacitor shell for Android. `npm run sync` copies `app/` into it. |

## Run and build

```bash
npm install
npm start          # run the desktop app
npm test           # data and prayer-time tests
npm run dist:win   # Windows installer (on Windows)

cd mobile && npm install && npm run sync
cd android && ./gradlew assembleDebug   # needs the Android SDK
```

GitHub Actions builds the Windows installer and an Android debug APK on every push; download them from the run's **Artifacts** section.

## Content

Arabic texts are from the Qur'an and the hadith collections cited on each dua. Transliterations and English meanings were written for Sakina; please report any mistake. Prayer times may differ by a minute or two from local mosque timetables.
