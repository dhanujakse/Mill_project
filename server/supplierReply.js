// Reads supplier WhatsApp replies: "is it available?" and "when can you deliver?".
//
// Suppliers answer in English, Tamil or Hindi, in Latin letters, and rarely use
// the exact word "available", so both readers accept the common short forms.
// Anything they can't read returns null, and the caller asks the supplier again
// or flags the order for the admin. A wrong guess here would silently set a
// wrong delivery date, so an unreadable reply is never treated as a yes or a date.

// Dates are read in India time: "tomorrow" means tomorrow in Chennai, not on a
// UTC server clock that is 5.5 hours behind.
const TIME_ZONE = 'Asia/Kolkata';

const NEGATIVE = [
  /\bnot\s+(?:available|avail|in\s+stock|possible|there)\b/,
  /\bunavailable\b/, /\bout\s+of\s+stock\b/, /\bno\s+stock\b/, /\bstock\s+(?:illa|illai|nahi|nahin|no)\b/,
  /\bno\b/, /\bnope\b/, /\bnah\b/, /\bnot\b/, /\bcan'?t\b/, /\bcannot\b/, /\bsorry\b/,
  /\billa\b/, /\billai\b/, /\billae\b/, /\billa[iy]?\b/, // Tamil
  /\bnahi\b/, /\bnahin\b/, /\bnai\b/, // Hindi (a bare "na" is left out: it is also a filler word)
  /👎/, /❌/
];
const POSITIVE = [
  /\bavailable\b/, /\bavail\b/, /\bin\s+stock\b/, /\bstock\s+(?:irukku|iruku|undu|hai|available)\b/,
  /\byes\b/, /\byeah\b/, /\byep\b/, /\byup\b/, /\bya\b/, /\bok\b/, /\bokay\b/, /\bokk+\b/, /\bsure\b/,
  /\bready\b/, /\bconfirm(?:ed)?\b/, /\bdone\b/, /\bcan\b/,
  /\birukku\b/, /\biruku\b/, /\bundu\b/, /\bseri\b/, /\bsari\b/, // Tamil
  /\bhaan\b/, /\bhan\b/, /\bha\b/, /\bji\b/, /\bhai\b/, /\btheek\b/, // Hindi
  /👍/, /✅/, /✔/
];

// 'available' | 'unavailable' | null (couldn't tell)
export const parseAvailability = (text) => {
  let t = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s'👍👎✅❌✔]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // "No problem" / "no issue" mean yes in Indian English; drop them before the
  // negative check so they don't read as "no".
  t = t.replace(/\bno\s+(?:problem|problems|issue|issues|worries|tension)\b/g, ' ').trim();
  if (!t) return 'available';
  // Negatives first: "not available" also contains "available".
  if (NEGATIVE.some(re => re.test(t))) return 'unavailable';
  if (POSITIVE.some(re => re.test(t))) return 'available';
  return null;
};

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};
const WEEKDAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };

// Today's calendar date in India, as a UTC-midnight Date (only Y/M/D matter).
export const todayInIndia = (now = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).map(p => [p.type, p.value]));
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
};
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const iso = (d) => d.toISOString().split('T')[0];
const valid = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
};
const fullYear = (y) => (y < 100 ? 2000 + y : y);

// A date without a year means the next time that date comes round.
const withoutYear = (m, d, today) => {
  const y = today.getUTCFullYear();
  const thisYear = valid(y, m, d);
  if (!thisYear) return null;
  return thisYear < today ? valid(y + 1, m, d) : thisYear;
};

// 'YYYY-MM-DD' | null. Accepts today up to one year ahead; dates in the past
// are rejected rather than guessed.
export const parseDeliveryDate = (text, now = new Date()) => {
  const today = todayInIndia(now);
  const t = String(text || '').toLowerCase().replace(/(\d+)(st|nd|rd|th)\b/g, '$1').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  let result = null;

  let m;
  if ((m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) {                       // 2026-10-25
    result = valid(Number(m[1]), Number(m[2]), Number(m[3]));
  } else if ((m = t.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/))) {     // 25/10/2026, 25-10-26 (Indian day-first)
    result = valid(fullYear(Number(m[3])), Number(m[2]), Number(m[1]));
  } else if ((m = t.match(/\b(\d{1,2})[/.\-](\d{1,2})\b/))) {                    // 25/10
    result = withoutYear(Number(m[2]), Number(m[1]), today);
  } else if ((m = t.match(/\b(\d{1,2})\s*(?:of\s+)?([a-z]{3,9})\.?(?:,?\s*(\d{4}))?\b/)) && MONTHS[m[2]]) { // 25 Oct (2026)
    result = m[3] ? valid(Number(m[3]), MONTHS[m[2]], Number(m[1])) : withoutYear(MONTHS[m[2]], Number(m[1]), today);
  } else if ((m = t.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?\b/)) && MONTHS[m[1]]) {    // Oct 25 (2026)
    result = m[3] ? valid(Number(m[3]), MONTHS[m[1]], Number(m[2])) : withoutYear(MONTHS[m[1]], Number(m[2]), today);
  } else if (/\bday after tomorrow\b|\bnaalai\s*marunaal\b|\bparso\b/.test(t)) {
    result = addDays(today, 2);
  } else if (/\btoday\b|\bindru\b|\binniki\b|\baaj\b/.test(t)) {
    result = today;
  } else if (/\btomorrow\b|\btmrw?\b|\btmr\b|\bnaalai\b|\bnalai\b|\bnaaliku\b|\bnaalaikku\b/.test(t)) {
    result = addDays(today, 1);
  } else if ((m = t.match(/\b(?:in|within|after)?\s*(\d{1,2})\s*(day|days|week|weeks)\b/))) { // in 3 days, 2 weeks
    const n = Number(m[1]) * (m[2].startsWith('week') ? 7 : 1);
    result = addDays(today, n);
  } else if (/\bnext week\b/.test(t)) {
    result = addDays(today, 7);
  } else if ((m = t.match(/\b(next\s+)?(sun|sunday|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\b/))) {
    const target = WEEKDAYS[m[2]];
    let diff = (target - today.getUTCDay() + 7) % 7;
    if (diff === 0 || m[1]) diff = diff === 0 ? 7 : diff; // "monday" on a Monday, or "next monday" -> the coming one
    result = addDays(today, diff);
  }

  if (!result) return null;
  if (result < today || result > addDays(today, 366)) return null;
  return iso(result);
};

// "25 Oct 2026" for messages to the supplier.
export const formatDateForMessage = (isoDate) => {
  const [y, mo, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
