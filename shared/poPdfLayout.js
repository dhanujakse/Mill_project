// Purchase Order PDF layout (A4), shared by the app (src/services/poPdf.js) and the
// server (server/routes/files.js, the PDF suppliers get on WhatsApp).
//
// Drawn with jsPDF text/lines, not a screenshot, so text is sharp and lines up the
// same everywhere. No imports here: the caller passes in its own jsPDF class.

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 14;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_H = 14;

const DARK = [17, 24, 39];
const MUTED = [75, 85, 99];
const LIGHT = [156, 163, 175];
const LINE = [209, 213, 219];
const SOFT_BG = [243, 244, 246];
const RED = [220, 38, 38];

const DEFAULT_BRAND = [234, 88, 12];

// jsPDF's built-in font only covers Latin characters; swap common typographic
// ones so they don't print as junk.
const clean = (value) => String(value ?? '')
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/•/g, '-')
  .replace(/ /g, ' ')
  .replace(/\r\n?/g, '\n');

/**
 * @param {object} po
 * @param {string} po.poNumber
 * @param {string} po.poDate        display text, e.g. 31/10/2026
 * @param {string} [po.dueDate]     display text
 * @param {string[]} po.billTo      first line is the company name
 * @param {string[]} po.shipTo
 * @param {string[]} po.supplier    first line is the company name
 * @param {string} [po.transportMode]
 * @param {boolean} [po.urgent]
 * @param {{productName:string, description?:string, qty:any, units?:string}[]} po.items
 * @param {string} po.signatory
 * @param {{ jsPDF: Function, brand?: number[] }} deps  jsPDF class, and [r,g,b] brand colour
 */
export function buildPoPdf(po, { jsPDF, brand } = {}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const BRAND = brand || DEFAULT_BRAND;
  let y = MARGIN;

  const setText = (size, color = DARK, style = 'normal') => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
  };
  const lineHeight = (size) => size * 0.3528 * 1.35; // pt -> mm, with spacing

  // ---- Header -------------------------------------------------------------
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, PAGE_W, 4, 'F');
  y = MARGIN + 2;

  const company = clean(po.billTo[0] || 'ALAGIRI PAPER MILLS');
  setText(15, DARK, 'bold');
  const companyLines = doc.splitTextToSize(company, CONTENT_W * 0.55);
  doc.text(companyLines, MARGIN, y + 4);

  setText(18, BRAND, 'bold');
  doc.text('PURCHASE ORDER', PAGE_W - MARGIN, y + 4, { align: 'right' });

  // PO meta, right aligned under the title
  let metaY = y + 11;
  const meta = [['PO No', po.poNumber], ['PO Date', po.poDate]];
  if (po.dueDate) meta.push(['Due Date', po.dueDate]);
  for (const [label, value] of meta) {
    setText(9.5, MUTED, 'normal');
    const valueText = clean(value);
    setText(9.5, DARK, 'bold');
    const valueW = doc.getTextWidth(valueText);
    doc.text(valueText, PAGE_W - MARGIN, metaY, { align: 'right' });
    setText(9.5, MUTED, 'normal');
    doc.text(`${label}:  `, PAGE_W - MARGIN - valueW, metaY, { align: 'right' });
    metaY += 5;
  }

  y = Math.max(y + 4 + companyLines.length * lineHeight(15), metaY) + 2;
  doc.setDrawColor(...LINE);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 6;

  // ---- Address boxes --------------------------------------------------------
  const GAP = 6;
  const BOX_W = (CONTENT_W - GAP) / 2;
  const PAD = 4;

  const boxHeight = (lines) => {
    const [first, ...rest] = lines.map(clean).filter(Boolean);
    setText(10.5, DARK, 'bold');
    let h = PAD + 4.5 + doc.splitTextToSize(first || '-', BOX_W - PAD * 2).length * lineHeight(10.5);
    setText(9, MUTED);
    for (const l of rest) h += doc.splitTextToSize(l, BOX_W - PAD * 2).length * lineHeight(9);
    return h + PAD;
  };
  const drawBox = (x, top, h, title, lines) => {
    doc.setDrawColor(...LINE);
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(x, top, BOX_W, h, 1.5, 1.5, 'S');
    let ty = top + PAD + 2.5;
    setText(8, BRAND, 'bold');
    doc.text(title, x + PAD, ty);
    ty += 5;
    const [first, ...rest] = lines.map(clean).filter(Boolean);
    setText(10.5, DARK, 'bold');
    const fl = doc.splitTextToSize(first || '-', BOX_W - PAD * 2);
    doc.text(fl, x + PAD, ty);
    ty += fl.length * lineHeight(10.5);
    setText(9, MUTED);
    for (const l of rest) {
      const wl = doc.splitTextToSize(l, BOX_W - PAD * 2);
      doc.text(wl, x + PAD, ty);
      ty += wl.length * lineHeight(9);
    }
  };
  const drawBoxRow = (left, right) => {
    const h = Math.max(boxHeight(left.lines), boxHeight(right.lines)) + 1;
    drawBox(MARGIN, y, h, left.title, left.lines);
    drawBox(MARGIN + BOX_W + GAP, y, h, right.title, right.lines);
    y += h + 5;
  };

  drawBoxRow({ title: 'SUPPLIER', lines: po.supplier }, { title: 'SHIP TO', lines: po.shipTo });
  drawBoxRow({ title: 'BILL TO', lines: po.billTo }, {
    title: 'ORDER DETAILS',
    lines: [
      clean(po.transportMode) ? `Transport: ${clean(po.transportMode)}` : 'Transport: -',
      po.urgent ? 'Priority: URGENT' : 'Priority: Normal',
      po.dueDate ? `Book on or before ${po.dueDate}` : 'Delivery: within 7 days of PO'
    ]
  });

  if (po.urgent) {
    doc.setFillColor(254, 242, 242);
    doc.setDrawColor(...RED);
    doc.roundedRect(MARGIN, y, CONTENT_W, 9, 1.5, 1.5, 'FD');
    setText(10, RED, 'bold');
    doc.text(`URGENT ORDER${po.dueDate ? `  -  BOOK ON OR BEFORE ${po.dueDate}` : ''}`, PAGE_W / 2, y + 6, { align: 'center' });
    y += 14;
  }

  // ---- Items table ----------------------------------------------------------
  const COL_NO = 12;
  const COL_QTY = 34;
  const COL_ITEM = CONTENT_W - COL_NO - COL_QTY;
  const CELL = 3;

  const drawTableHeader = () => {
    doc.setFillColor(...SOFT_BG);
    doc.setDrawColor(...LINE);
    doc.rect(MARGIN, y, CONTENT_W, 8, 'FD');
    setText(9, MUTED, 'bold');
    doc.text('#', MARGIN + COL_NO / 2, y + 5.3, { align: 'center' });
    doc.text('ITEM & DESCRIPTION', MARGIN + COL_NO + CELL, y + 5.3);
    doc.text('QUANTITY', PAGE_W - MARGIN - CELL, y + 5.3, { align: 'right' });
    y += 8;
  };
  const newPage = () => {
    doc.addPage();
    y = MARGIN;
    drawTableHeader();
  };

  drawTableHeader();
  po.items.forEach((item, idx) => {
    setText(10.5, DARK, 'bold');
    const nameLines = doc.splitTextToSize(clean(item.productName) || '-', COL_ITEM - CELL * 2);
    setText(9, MUTED);
    const descLines = clean(item.description).trim()
      ? doc.splitTextToSize(clean(item.description).trim(), COL_ITEM - CELL * 2)
      : [];
    const qtyText = `${clean(item.qty)} ${clean(item.units)}`.trim();

    const descLH = lineHeight(9);
    const nameH = nameLines.length * lineHeight(10.5);
    const bottomLimit = PAGE_H - MARGIN - FOOTER_H;

    // A row (or what's left of a long description) may need to continue on the next page.
    let rowTop = y;
    if (rowTop + CELL * 2 + nameH > bottomLimit) { newPage(); rowTop = y; }

    let ty = rowTop + CELL + 3.6;
    setText(10, MUTED, 'bold');
    doc.text(String(idx + 1), MARGIN + COL_NO / 2, ty, { align: 'center' });
    setText(10.5, DARK, 'bold');
    doc.text(nameLines, MARGIN + COL_NO + CELL, ty);
    setText(10.5, DARK, 'bold');
    doc.text(qtyText, PAGE_W - MARGIN - CELL, ty, { align: 'right' });
    ty += nameH;

    setText(9, MUTED);
    for (const line of descLines) {
      if (ty + descLH > bottomLimit) {
        // close this page's part of the row, then carry on
        doc.setDrawColor(...LINE);
        doc.rect(MARGIN, rowTop, CONTENT_W, ty - rowTop + CELL - 2);
        newPage();
        rowTop = y;
        ty = rowTop + CELL + 3;
        setText(9, MUTED);
      }
      doc.text(line, MARGIN + COL_NO + CELL, ty);
      ty += descLH;
    }

    const rowBottom = ty + CELL - 2;
    doc.setDrawColor(...LINE);
    doc.rect(MARGIN, rowTop, CONTENT_W, rowBottom - rowTop);
    y = rowBottom;
  });

  // ---- Instructions + signature ---------------------------------------------
  const closingH = 30;
  if (y + 6 + closingH > PAGE_H - MARGIN - FOOTER_H) { doc.addPage(); y = MARGIN; }
  y += 6;

  setText(9, DARK, 'bold');
  doc.text('Instructions', MARGIN, y);
  setText(9, MUTED);
  const instructions = doc.splitTextToSize(
    'Please acknowledge receipt of this PO. Upload the LR copy once the shipment is sent. Standard procurement terms apply.',
    CONTENT_W * 0.55
  );
  doc.text(instructions, MARGIN, y + 5);

  const sigX = PAGE_W - MARGIN;
  doc.setDrawColor(...LINE);
  doc.line(sigX - 60, y + 18, sigX, y + 18);
  setText(9, MUTED);
  doc.text('Authorized Signatory', sigX, y + 23, { align: 'right' });
  setText(10.5, BRAND, 'bold');
  doc.text(clean(po.signatory), sigX, y + 28.5, { align: 'right' });

  // ---- Footer on every page -------------------------------------------------
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...LINE);
    doc.line(MARGIN, PAGE_H - MARGIN, PAGE_W - MARGIN, PAGE_H - MARGIN);
    setText(8, LIGHT);
    doc.text(`PO ${clean(po.poNumber)}`, MARGIN, PAGE_H - MARGIN + 5);
    doc.text(`Page ${p} of ${pages}`, PAGE_W - MARGIN, PAGE_H - MARGIN + 5, { align: 'right' });
  }

  doc.setProperties({ title: `Purchase Order ${clean(po.poNumber)}`, subject: 'Purchase Order' });
  return doc;
}
