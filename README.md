# Driftshare

Send files, photos and messages between your Windows PC and your phone over your own Wi-Fi. No internet, no account, no cable.

## How it works

- The **PC app** runs a small server on port 47820 and shows a QR code plus a 6-letter pairing code.
- A **phone** connects either by scanning the QR code (opens in the phone's browser, nothing to install) or with the **Android app** (type the PC address and code once; it reconnects by itself after that).
- Messages and files show up as a chat per device. Phones connected to the same PC also see each other and can send files and messages phone to phone (passed through the PC; the PC screen doesn't show those chats, and the files are kept in a private relay folder for 7 days, not in Downloads).
- Files from a phone to the PC are saved in `Downloads\Driftshare` on the PC. Files from the PC are sent straight from where they are, without copying.
- **Nearby phones (no PC):** in the Android app, phones on the same Wi-Fi find each other automatically (mDNS) and send messages and files directly. The receiver gets an Accept / Decline prompt for files, and they're saved in `Downloads/Driftshare`. Keep Driftshare open on the receiving phone.
- **Many files and whole folders:** the + button sends files or a whole folder. Several files or a folder arrive as one item showing what's inside, with "Download all (.zip)" on phones and "Open folder" on the PC. Folders keep their subfolders on the receiving side (`Downloads\Driftshare\<folder>` on the PC, `Downloads/Driftshare/<folder>` on Android).
- **Share menu (Android):** Driftshare shows up in Android's Share menu for any file, several files, or text. Pick it in Gallery, Files or any app, then choose a nearby phone or your PC.
- Only devices with the current pairing code can connect. "Make a new code" on the PC disconnects every phone. Wrong codes are throttled.

## Run it

```
npm install
npm start           # desktop app (Electron)
npm run hub         # server only, no window (prints the pairing code)
npm test
```

The first time it starts, Windows asks whether to allow Driftshare on networks: allow **Private networks** only.

## Build

- Windows installer: `npm run dist:win` (on Windows), or let GitHub Actions do it.
- Android app: `cd mobile && npm install && npx cap sync android && cd android && ./gradlew assembleDebug` (needs the Android SDK), or let GitHub Actions do it.
- Every push to `main` builds both and attaches them to the workflow run under "Artifacts".

## Layout

| Path | What |
|---|---|
| `src/hub.js` | The transfer engine: pairing, messages, uploads, downloads, live updates |
| `src/main.js`, `src/preload.js` | Electron desktop shell, tray icon, notifications |
| `ui/` | The screens. The same page runs on the PC and on the phone |
| `mobile/` | Capacitor Android app: home screen (Nearby phones / My PC), download handling |
| `mobile/android/.../DirectPlugin.java` | Direct phone-to-phone: small HTTP server, mDNS discovery, accept/decline handshake |
| `test/` | Engine tests |

## Not yet done

- Receiving nearby files while Driftshare is closed or in the background
- Picking a folder from inside the Android app's PC chat (the Android web view only picks files; use Nearby phones or a phone browser for folders)
- Automatic discovery without typing the address in the Android app
- Encryption (HTTPS). Traffic stays on your Wi-Fi but isn't encrypted yet
