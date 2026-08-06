# Water Well Manager — Android build guide

This project is now a fully-configured Capacitor Android app. Everything needed
to compile is in place; you just build it on your Mac (which has the Android SDK
and network access the cloud sandbox did not).

- **App name:** Water Well Manager
- **Package / application ID:** `com.jaguarsllc.drillpro`  *(permanent once published)*
- **Version:** versionCode 1, versionName 1.0
- **Min / Target / Compile SDK:** 24 / 36 / 36

---

## 1. One-time setup

You need **Android Studio** (recent version — it bundles the right JDK 21 and
Android SDK) and **Node.js**.

From the project root:

```bash
npm install          # picks up @capacitor/android that was added to package.json
npm run build        # builds the web app into dist/
npx cap sync android # copies dist/ into the native project + updates plugins
```

## 2. Build & run a debug build

Open the native project in Android Studio:

```bash
npx cap open android
```

Then press **Run ▶** with an emulator or a USB-connected phone selected.
Android Studio downloads any remaining Gradle/SDK bits on first run.

Or build a debug APK straight from the command line:

```bash
cd android
./gradlew assembleDebug
# APK at: android/app/build/outputs/apk/debug/WaterWellManager-v1.0-debug.apk
```

Build outputs are named `WaterWellManager-v<versionName>-<variant>` via `base.archivesName`
in `android/app/build.gradle` — the version tracks `versionName` automatically.

Copy that APK to a phone (enable "Install unknown apps") to sideload it.

## 3. Verify offline behavior

All data lives in the WebView's `localStorage`, so the app is offline by design.
To confirm: put the phone in airplane mode, create/edit boreholes, pipe records
and events, force-close the app, reopen it — the data should still be there.

## 4. What was already configured for you

- Capacitor initialized (`capacitor.config.ts`) with the app name and package ID.
- `android/` native project generated and synced with the current web build.
- **Permissions** (in `android/app/src/main/AndroidManifest.xml`):
  `INTERNET`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `VIBRATE`,
  plus a non-required `location.gps` feature flag.
- **Runtime location prompt:** `MainActivity.java` requests location permission
  on launch so the "Get GPS location" button in the New Borehole modal works.
- **Orientation:** locked to **portrait** (change `android:screenOrientation`
  in the manifest to `fullSensor` if you want rotation).
- **App icon + splash:** gold derrick + water-drop mark on black, generated for
  every density (adaptive icon + light/dark splash). Regenerate anytime with
  `python3 make_assets.py && npx @capacitor/assets generate --android`.
- Added `colors.xml` (the generated template was missing it, which would have
  failed the build).

## 5. Release build (for Play Store distribution)

1. Create an upload keystore (keep it safe — you need it for every update):
   ```bash
   keytool -genkey -v -keystore drillpro-release.keystore \
     -alias drillpro -keyalg RSA -keysize 2048 -validity 10000
   ```
2. In Android Studio: **Build → Generate Signed Bundle / APK → Android App
   Bundle (.aab)**, select your keystore, choose the `release` build variant.
3. Upload the resulting `.aab` to the Google Play Console (bump `versionCode`
   in `android/app/build.gradle` for each release).

## Notes / optional polish

- The UI font (JetBrains Mono) loads from Google Fonts over the network. Offline
  it falls back to the system monospace font — functionally fine. To make it
  fully offline, self-host the font file and reference it in `index.html`.
- `@google/genai` is listed as a dependency but is not used anywhere in the code
  (leftover from the AI Studio template). You can remove it to slim the bundle.
