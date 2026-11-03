// Turns a stored order (+ its supplier) into what the PO PDF prints.
// Shared by the app and the server, so both PDFs say exactly the same thing.
import { getCompanyAddress } from './companyAddresses.js';

const DEFAULT_COMPANY = 'ALAGIRI PAPER MILLS';

const normalizeMultiline = (text) => String(text || '').replace(/\r\n?/g, '\n').trim();

// dd/mm/yyyy for any of: dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd(...), or a parseable date.
export const formatPoDate = (value) => {
  if (!value) return '';
  const str = String(value).trim();
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(str);
  if (dmy) return `${dmy[1].padStart(2, '0')}/${dmy[2].padStart(2, '0')}/${dmy[3]}`;
  const ymd = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(str);
  if (ymd) return `${ymd[3].padStart(2, '0')}/${ymd[2].padStart(2, '0')}/${ymd[1]}`;
  const d = new Date(str);
  return isNaN(d) ? str : d.toLocaleDateString('en-GB');
};

/**
 * @param {object} order      the order (request) record
 * @param {object} [supplier] the supplier record, if any
 * @param {string} signatory  name printed under "Authorized Signatory"
 */
export const poDataFromOrder = (order, supplier = {}, signatory = '') => {
  const req = order || {};
  const sup = supplier || {};
  const phone = sup.whatsappNumber || sup.phoneNumber || req.suggestedSupplierPhone || '';
  const items = (Array.isArray(req.items) && req.items.length > 0)
    ? req.items
    : [{ productName: req.productName, qty: req.qty, units: req.units, description: req.description }];
  const billTo = getCompanyAddress(req.billTo, 'billTo');
  const shipTo = getCompanyAddress(req.shipTo || req.billTo, 'shipTo');

  return {
    poNumber: req.poNumber || req.id || '',
    poDate: formatPoDate(req.poDate || req.createdAt || new Date().toISOString()),
    dueDate: formatPoDate(req.dueDate),
    billTo: billTo.length ? billTo : [req.billTo || DEFAULT_COMPANY],
    shipTo: shipTo.length ? shipTo : [req.shipTo || req.billTo || DEFAULT_COMPANY],
    supplier: [
      sup.companyName || req.suggestedSupplier || req.supplierName || 'N/A',
      sup.address,
      sup.contactPerson && `Contact: ${sup.contactPerson}`,
      phone && `Ph: ${phone}`
    ].filter(Boolean),
    transportMode: req.transportMode,
    urgent: String(req.priority || '').trim().toLowerCase() === 'urgent',
    items: items.map(it => ({ ...it, description: normalizeMultiline(it.description) })),
    signatory
  };
};
