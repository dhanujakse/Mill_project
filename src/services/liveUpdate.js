// Over-the-air updates for the Android/iOS app (see server/routes/appUpdate.js).
//
// The installed app carries its own copy of this web app. On start and on
// resume it asks the API for the newest published bundle; if it differs from
// the running one, the zip is downloaded in the background and switched in the
// next time the app goes to the background (or is reopened), so nobody loses
// what they are typing. Native changes (new plugins, permissions, icons) still
// need a new APK/IPA - deploy.ps1 stamps each bundle with the native build it
// needs, and older installs simply keep their current version.
//
// capacitor.config.json sets autoUpdate:false and statsUrl:"" so the plugin
// never talks to Capgo's cloud; our own API is the only update source.
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { getApiBaseUrl } from './api';

// Set by deploy.ps1 at build time (vite.config.js); 'dev' for local builds.
export const APP_BUILD = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'dev';

const isNative = () => Capacitor.isNativePlatform();
let checking = false;
let preparedVersion = null;

// Must run as soon as the bundle starts: if a freshly applied bundle never
// calls this, the plugin assumes it is broken and rolls back to the previous one.
export const confirmBundleWorks = () => {
  if (!isNative()) return;
  CapacitorUpdater.notifyAppReady().catch(err => console.warn('notifyAppReady failed:', err));
};

// Returns the version that was downloaded and queued, or null.
export const checkForAppUpdate = async () => {
  if (!isNative() || checking) return null;
  checking = true;
  try {
    const res = await fetch(`${getApiBaseUrl()}/app-update/latest`, { cache: 'no-store' });
    if (!res.ok) return null; // nothing published yet, or server unreachable
    const latest = await res.json();
    if (!latest?.version || !latest.url || !latest.checksum) return null;
    if (latest.version === APP_BUILD || latest.version === preparedVersion) return null;

    const { build } = await CapacitorApp.getInfo();
    if (Number(build) < Number(latest.minNativeBuild || 0)) return null; // needs a new APK first

    const bundle = await CapacitorUpdater.download({
      url: latest.url,
      version: latest.version,
      checksum: latest.checksum
    });
    await CapacitorUpdater.next({ id: bundle.id });
    preparedVersion = latest.version;
    return latest.version;
  } catch (err) {
    console.warn('App update check failed:', err);
    return null;
  } finally {
    checking = false;
  }
};
