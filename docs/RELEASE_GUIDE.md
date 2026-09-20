# Mill Mate - Release Guide

Everything needed to put the app online and into the Play Store and App Store.
Sections 1 and 2 are the web deployment, 3 is Android, 4 is iOS, 5 is the store checklists.

---

## 1. Backend on Render - persistent storage (do this first)

The database is a SQLite **file**. Render's normal filesystem is temporary: every deploy or restart deletes it (this is why test orders kept vanishing). The fix is a **Disk**.

> Render does not offer Disks on the free plan. You need at least the **Starter** instance (about 7 USD/month) plus a small disk (about 0.25 USD/GB/month, 1 GB is plenty).

**On the existing `mill-project` service (Render dashboard):**

1. **Settings > Instance type**: choose **Starter** (or higher).
2. **Disks > Add Disk**: name `mill-data`, mount path `/var/data`, size 1 GB.
3. **Environment**, add or check:

| Key | Value |
|---|---|
| `DB_PATH` | `/var/data/alagiri.db` |
| `JWT_SECRET` | a long random string; set once and never change it (changing it logs everyone out) |
| `SEED_PASSWORD` | the password you want for the first `admin` and `employee` accounts (only used when the database is created) |
| `CORS_ORIGIN` | `https://alagiri-mill.vercel.app,https://localhost,capacitor://localhost` (no spaces; the last two are what the Android and iOS apps call from) |
| `NODE_VERSION` | `22.12.0` or newer (`node:sqlite` needs 22.5+) |
| `META_*` | only if you use the WhatsApp "Ask Supplier" feature (see `server/.env.example`) |

4. **Manual Deploy > Deploy latest commit.**
5. **Check the logs** for `Database file: /var/data/alagiri.db`. If you instead see `WARNING: running on Render without DB_PATH`, the disk is not in use.
6. **Prove it survives**: create a test user, trigger another deploy, confirm the user is still there.

Notes:
- The first boot with an empty disk seeds the users, suppliers and departments. Log in with `SEED_PASSWORD` and change both passwords in Settings.
- A disk is attached to one instance, so the service can't be scaled to multiple instances (fine for this app).
- Back up regularly: Render Disks support snapshots (Disks page). A read-only JSON export of production data was saved on 2026-09-20 in `C:\Users\sivas\MillMate_prod_backup_2026-09-20`.
- `render.yaml` in the repo root records these settings. Use it only to create the service from scratch, not on top of the existing one.

## 2. Frontend on Vercel

1. Push to `main`; Vercel builds automatically.
2. `.env.production` already points the build at `https://mill-project.onrender.com/api`. If the backend URL ever changes, update it there.
3. **After every deploy, confirm Vercel really is serving the new build** (an earlier bug report was caused by a stale deploy): open the site, view source, and check the script name `/assets/index-XXXX.js` changed compared with a local `npm run build`, or check the Vercel dashboard shows the latest commit as "Production - Ready".

## 3. Android - signed App Bundle (.aab) for Google Play

**Already set up:** release signing (`android/keystore.properties` and `android/keystore/alagiri-release.jks`, valid until 2053), targetSdk 36, application id `com.alagiri.procurement`, app name "Mill Mate".

### Build

```powershell
cd D:\Mill_project
npm run build                 # bundles the web app with the production API URL
npx cap sync android          # copies it into the Android project
cd android
.\gradlew.bat "-Dorg.gradle.java.home=C:\Program Files\Eclipse Adoptium\jdk-21.0.12.8-hotspot" bundleRelease
```

Output: `android\app\build\outputs\bundle\release\app-release.aab` - upload this file to Play Console.

(`android/gradle.properties` pins Java to `C:/Program Files/Android/Android Studio/jbr`, which only exists on machines with Android Studio installed; the `-Dorg.gradle.java.home` option above overrides it. Delete that line from `gradle.properties` if nobody needs it.)

### Every update
Increase `versionCode` (a whole number, must go up every upload) and `versionName` in `android/app/build.gradle`, then repeat the build.

### BACK UP THE SIGNING KEY NOW
Copy `android\keystore\alagiri-release.jks` **and** `android\keystore.properties` to a password manager or secure cloud storage, off this PC. If they are lost you can never publish an update under the same app. Also enrol in **Play App Signing** when you create the app: Google then holds the real signing key and yours becomes a replaceable upload key.

### Play Console checklist
- Developer account (one-time 25 USD). New personal accounts must run a **closed test with at least 12 testers for 14 days** before production access.
- Create app > upload the `.aab` to Internal testing first, then promote.
- Store listing: short and full description, 512x512 icon, 1024x500 feature graphic, at least 2 phone screenshots.
- **Privacy policy URL** (required: the app handles names, emails, phone numbers and camera photos).
- **Data safety** form: collects name, email, phone, photos/files, user IDs; data encrypted in transit; users can request deletion (say how).
- **App access**: the app needs a login, so give reviewers a working test account (create a dedicated Employee and Sub Admin, not the real admin).
- Content rating questionnaire, target audience (adults), ads: none.
- Permissions declared: `INTERNET`, `CAMERA` (used to photograph documents and proof of receipt).

## 4. iOS - App Store

**Reality check:** an iOS app can only be compiled and signed with Apple's tools on a **Mac with Xcode**. It can't be built on this Windows PC. The iOS project is already added to the repo (`ios/`); the final steps need a Mac, or a cloud Mac service.

### You need
- **Apple Developer Program**: 99 USD/year (developer.apple.com/programs).
- A Mac with Xcode 16 or newer, **or** a cloud build service (Codemagic, Xcode Cloud, GitHub Actions macOS runner, MacInCloud).

### Steps on the Mac
```bash
git clone https://github.com/ramya25-star/Mill_project.git && cd Mill_project
npm install
npm run build                 # production API URL comes from .env.production
npx cap sync ios
npx cap open ios              # opens Xcode
```
In Xcode:
1. Select the **App** target > **Signing & Capabilities**: choose your Team, keep "Automatically manage signing". Bundle identifier: `com.alagiri.procurement` (create the same ID in App Store Connect; it can't be changed after the first upload).
2. Set **Version** (marketing, e.g. 1.0) and **Build** (whole number, must increase every upload).
3. Add the app icon (1024x1024 PNG, no transparency) in `Assets.xcassets > AppIcon`.
4. **Product > Archive**, then **Distribute App > App Store Connect > Upload**.
5. In **App Store Connect**: create the app record, fill the listing, add the build, submit via **TestFlight** first, then submit for review.

### Already prepared in the iOS project
- Camera and photo library permission texts in `Info.plist` (Apple rejects apps that use the camera without them).
- Web assets and the production API URL are bundled by `cap sync`.

### App Store checklist
- Screenshots for 6.7" and 6.5" iPhones (and iPad if the app supports it).
- **Privacy policy URL** and the **App Privacy** questionnaire (same data as Play's Data safety form).
- **App Review information**: a working demo login (Apple always tests login-only apps).
- Apple may reject apps that are only a website in a wrapper (guideline 4.2). This app has native camera/file access and account-based workflows, which helps; describe those in the review notes.
- Backend must be HTTPS (it is).

## 5. Before you publish anything

1. Section 1 done and verified (data survives a redeploy).
2. Log in to production and **change the default passwords** for `admin` and `employee` (or set `SEED_PASSWORD` before the first boot). The default is public in the repository.
3. Create real user accounts; disable or delete the demo `employee` account.
4. Publish a **privacy policy** page (Play and App Store both require one).
5. Test the release build on a real phone: login, create a request, attach a photo, approve as admin, generate a PO.
