// Company addresses printed on POs. Shared by the app (src/) and the server (server/),
// so keep this file free of imports and browser-only code.
export const COMPANY_ADDRESSES = {
  "Alagiri Duplex Factory": [
    "ALAGIRI DUPLEX",
    "106/3A EAST STREET.",
    "N. SUBBIAHPURAM",
    "PETHUREDDI PATTI",
    "SATTUR TALUK",
    "TAMILNADU"
  ],
  "Alagiri Duplex Office": [
    "ALAGIRI DUPLEX",
    "NO: 1/M-1 BHARATHI NAGAR",
    "NORTH 2nd Street",
    "KOVILPATTI - 628501",
    "TAMILNADU"
  ],
  "Alagiri Paper Mill Factory": [
    "ALAGIRI PAPER MILLS",
    "3/229 N. PULUMPATTI",
    "N. SUBBIAHPURAM POST.",
    "SATTUR TALUK.",
    "TAMILNADU. - 626205"
  ],
  "Alagiri Paper Mill Office": [
    "ALAGIRI PAPER MILLS",
    "NO: 1M BHARATHI NAGAR",
    "2nd Street.",
    "KOVILPATTI - 628501",
    "TAMILNADU"
  ]
};

export const getCompanyAddress = (companyName, type = 'billTo') => {
  if (!companyName) return [];
  
  // Exact match
  if (COMPANY_ADDRESSES[companyName]) {
    return COMPANY_ADDRESSES[companyName];
  }

  const normalized = String(companyName).toUpperCase().trim();
  
  if (normalized.includes("DUPLEX")) {
    if (normalized.includes("OFFICE") || (type === 'billTo' && !normalized.includes("FACTORY"))) {
      return COMPANY_ADDRESSES["Alagiri Duplex Office"];
    }
    return COMPANY_ADDRESSES["Alagiri Duplex Factory"];
  }

  if (normalized.includes("PAPER") || normalized.includes("MILL")) {
    if (normalized.includes("OFFICE") || (type === 'billTo' && !normalized.includes("FACTORY"))) {
      return COMPANY_ADDRESSES["Alagiri Paper Mill Office"];
    }
    return COMPANY_ADDRESSES["Alagiri Paper Mill Factory"];
  }

  return [companyName];
};
