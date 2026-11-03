// Makes the Purchase Order PDF in the app and shares it (WhatsApp etc.).
// The page layout itself lives in shared/poPdfLayout.js (the server uses it too).
import { jsPDF } from 'jspdf';
import { Capacitor } from '@capacitor/core';
import { buildPoPdf as buildLayout } from '../../shared/poPdfLayout.js';

// The app's brand colour lives in a CSS variable; fall back to the default orange.
const brandColor = () => {
  try {
    const hex = getComputedStyle(document.documentElement).getPropertyValue('--primary-orange').trim();
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  } catch { /* not in a browser */ }
  return undefined;
};

export const buildPoPdf = (po) => buildLayout(po, { jsPDF, brand: brandColor() });

const isCancel = (err) => /cancel|abort/i.test(`${err?.name} ${err?.message}`);

/**
 * Shares the PDF through the phone's share sheet (pick WhatsApp, then the supplier).
 * On a computer without file sharing, downloads the PDF and opens the supplier's
 * WhatsApp chat so it can be attached.
 *
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
export async function sharePoPdf(doc, { fileName, text, phone }) {
  const title = fileName.replace(/\.pdf$/i, '');

  if (Capacitor.isNativePlatform()) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([
      import('@capacitor/filesystem'),
      import('@capacitor/share')
    ]);
    const base64 = doc.output('datauristring').split(',')[1];
    const { uri } = await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Cache });
    try {
      await Share.share({ title, text, files: [uri], dialogTitle: 'Send PO' });
      return 'shared';
    } catch (err) {
      if (isCancel(err)) return 'cancelled';
      throw err;
    }
  }

  const blob = doc.output('blob');
  const file = new File([blob], fileName, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
      return 'shared';
    } catch (err) {
      if (isCancel(err)) return 'cancelled';
      // fall through to download (e.g. share blocked by the browser)
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);

  const digits = String(phone || '').replace(/\D/g, '');
  window.open(`https://api.whatsapp.com/send?${digits ? `phone=${digits}&` : ''}text=${encodeURIComponent(text)}`, '_blank');
  return 'downloaded';
}
