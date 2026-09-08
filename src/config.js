// Configurable options and mock data for the React Procurement Management System
export const COMPANY_ADDRESSES = {
  "ALAGIRI PAPER MILLS": {
    name: "ALAGIRI PAPER MILLS",
    billTo: [
      "ALAGIRI PAPER MILLS",
      "NO: 1M BHARATHI NAGAR",
      "2nd Street.",
      "KOVILPATTI - 628501",
      "TAMILNADU"
    ],
    shipTo: [
      "ALAGIRI PAPER MILLS",
      "3/229 N. PULUMPATTI",
      "N. SUBBIAHPURAM POST.",
      "SATTUR TALUK.",
      "TAMILNADU. - 626205"
    ]
  },
  "ALAGIRI DUPLEX": {
    name: "ALAGIRI DUPLEX",
    billTo: [
      "ALAGIRI DUPLEX",
      "NO: 1/M-1 BHARATHI NAGAR",
      "NORTH 2nd Street",
      "KOVILPATTI - 628501",
      "TAMILNADU"
    ],
    shipTo: [
      "ALAGIRI DUPLEX",
      "106/3A EAST STREET.",
      "N. SUBBIAHPURAM",
      "PETHUREDDI PATTI",
      "SATTUR TALUK",
      "TAMILNADU"
    ]
  }
};

export const COMPANY_OPTIONS = [
  "ALAGIRI PAPER MILLS",
  "ALAGIRI DUPLEX"
];

export const getCompanyAddress = (companyName, type = 'billTo') => {
  if (!companyName) return [];
  const normalized = String(companyName).toUpperCase().trim();
  if (normalized.includes("PAPER") || normalized === "ALAGIRI PAPER MILLS") {
    return COMPANY_ADDRESSES["ALAGIRI PAPER MILLS"][type] || [];
  }
  if (normalized.includes("DUPLEX") || normalized === "ALAGIRI DUPLEX") {
    return COMPANY_ADDRESSES["ALAGIRI DUPLEX"][type] || [];
  }
  return [companyName];
};

export const CONFIG = {
  // App branding (Can be dynamically configured in settings and saved to localStorage)
  branding: {
    appName: "Mill Mate",
    logoText: "Mill Mate",
    companyName: "Alagiri Duplex Paper Mills",
    primaryColor: "#e67e35", // Deep orange accent
    primaryColorHover: "#c56422",
    backgroundColor: "#f5ede6", // Cream/Beige background
    darkCharcoal: "#232120", // Bottom nav/button dark background
    billingLocations: [
      "ALAGIRI PAPER MILLS",
      "ALAGIRI DUPLEX"
    ]
  },

  // Mock users
  users: {
    employee: {
      name: "John Doe",
      role: "Employee",
      department: "Maintenance",
      avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=John"
    },
    admin: {
      name: "Johnson",
      role: "Admin",
      department: "Procurement Manager",
      avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=Johnson"
    }
  },

  // Pre-configured suppliers database
  initialSuppliers: [
    {
      id: "sup-1",
      companyName: "AB Company",
      contactPerson: "Mr. Anand",
      whatsappNumber: "+919876543210",
      phoneNumber: "+919876543210",
      email: "orders@abcompany.com",
      address: "12, Industrial Estate, Phase II, Chennai - 600032",
      products: "chain wheel, bearings, conveyor belt, sprocket",
      rating: 5,
      remarks: "Preferred supplier for heavy mechanical transmission spares. Fast response."
    },
    {
      id: "sup-2",
      companyName: "Vel Automobiles",
      contactPerson: "Mr. Velu",
      whatsappNumber: "+919876543211",
      phoneNumber: "+919876543211",
      email: "sales@velauto.com",
      address: "87-A, Bypass Road, Madurai - 625016",
      products: "lubricant grease, V-belts, gear oil, sensor probe",
      rating: 4,
      remarks: "Reliable supplier for machinery consumables and electrical components."
    },
    {
      id: "sup-3",
      companyName: "Senthil Fitter",
      contactPerson: "Mr. Senthil",
      whatsappNumber: "+919876543212",
      phoneNumber: "+919876543212",
      email: "senthilfitter@gmail.com",
      address: "44, Mill Road, Coimbatore - 641002",
      products: "steam pipe valve, flange, coupling, custom piping fabrication",
      rating: 3,
      remarks: "Specialist for structural and custom piping fabrication. High quality, moderate lead time."
    },
    {
      id: "sup-4",
      companyName: "Green1 Materials LLC",
      contactPerson: "Mr. Green",
      whatsappNumber: "+15551234567",
      phoneNumber: "+15551234567",
      email: "contact@green1materials.com",
      address: "#34, Car Street, City Park, Honk Kong",
      products: "Desktop furniture, plumbing and electrical services, Water tank repair works",
      rating: 4,
      remarks: "International supplier for structural office equipment and maintenance services."
    }
  ],

  // Pre-configured requests showing different stages of the workflow
  initialRequests: [
    {
      id: "REQ-1001",
      employeeName: "John Doe",
      department: "Maintenance",
      date: "2026-06-25T09:30:00Z",
      productName: "chain wheel 10pcs",
      qty: 10,
      units: "pcs",
      suggestedSupplier: "AB company",
      billTo: "Alagiri Duplex (Unit 1)",
      description: "Conveyor line sprocket replacements for Main Pulp line. Heavy duty specification.",
      status: "Delivered",
      supplierId: "sup-1",
      poNumber: "PO-2026-001",
      poDate: "2026-06-25T11:00:00Z",
      lrCopy: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><rect width='200' height='200' fill='%23e0f2fe'/><text x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='sans-serif' font-size='14' fill='%230369a1'>AB company LR COPY</text></svg>",
      history: [
        { status: "Pending", updatedBy: "John Doe", role: "Employee", timestamp: "2026-06-25T09:30:00Z" },
        { status: "Approved", updatedBy: "Johnson", role: "Admin", timestamp: "2026-06-25T11:00:00Z" },
        { status: "Booked", updatedBy: "Johnson", role: "Admin", timestamp: "2026-06-25T11:15:00Z" },
        { status: "In Transit", updatedBy: "Johnson", role: "Admin", timestamp: "2026-06-25T14:00:00Z" },
        { status: "Reached Warehouse", updatedBy: "John Doe", role: "Employee", timestamp: "2026-06-26T10:00:00Z" },
        { status: "Delivered", updatedBy: "John Doe", role: "Employee", timestamp: "2026-06-26T12:30:00Z", remarks: "Physically verified and stacked in Store Room B." }
      ]
    },
    {
      id: "REQ-1002",
      employeeName: "Robert Smith",
      department: "Production",
      date: "2026-06-26T08:15:00Z",
      productName: "lubricant grease 5 drums",
      qty: 5,
      units: "drums",
      suggestedSupplier: "Vel Automobiles",
      billTo: "Alagiri Kraft Mill (Unit 2)",
      description: "High temperature grease for boiler bearing lubrication cycle. Urgent requirement.",
      status: "In Transit",
      supplierId: "sup-2",
      poNumber: "PO-2026-002",
      poDate: "2026-06-26T10:00:00Z",
      lrCopy: null,
      history: [
        { status: "Pending", updatedBy: "Robert Smith", role: "Employee", timestamp: "2026-06-26T08:15:00Z" },
        { status: "Approved", updatedBy: "Johnson", role: "Admin", timestamp: "2026-06-26T10:00:00Z" },
        { status: "Booked", updatedBy: "System (Webhook)", role: "Supplier", timestamp: "2026-06-26T10:15:00Z" },
        { status: "In Transit", updatedBy: "Robert Smith", role: "Employee", timestamp: "2026-06-27T09:00:00Z" }
      ]
    },
    {
      id: "REQ-1003",
      employeeName: "Alice Cooper",
      department: "Utility",
      date: "2026-06-27T10:00:00Z",
      productName: "steam pipe valve 2 units",
      qty: 2,
      units: "units",
      suggestedSupplier: "Senthil Fitter",
      billTo: "Alagiri Duplex (Unit 1)",
      description: "3-inch high pressure steam isolation gate valve. Essential for upcoming maintenance shutdown.",
      status: "Pending",
      supplierId: "",
      poNumber: "",
      poDate: "",
      lrCopy: null,
      history: [
        { status: "Pending", updatedBy: "Alice Cooper", role: "Employee", timestamp: "2026-06-27T10:00:00Z" }
      ]
    },
    {
      id: "REQ-1004",
      employeeName: "John Doe",
      department: "Maintenance",
      date: "2026-06-27T11:20:00Z",
      productName: "bearings 12 units",
      qty: 12,
      units: "units",
      suggestedSupplier: "AB company",
      billTo: "Alagiri Duplex (Unit 1)",
      description: "6204-ZZ deep groove ball bearings for utility fan assembly.",
      status: "Reached Warehouse",
      supplierId: "sup-1",
      poNumber: "PO-2026-003",
      poDate: "2026-06-27T12:00:00Z",
      lrCopy: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><rect width='200' height='200' fill='%23e0f2fe'/><text x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='sans-serif' font-size='14' fill='%230369a1'>AB company LR COPY</text></svg>",
      history: [
        { status: "Pending", updatedBy: "John Doe", role: "Employee", timestamp: "2026-06-27T11:20:00Z" },
        { status: "Approved", updatedBy: "Johnson", role: "Admin", timestamp: "2026-06-27T12:00:00Z" },
        { status: "Acknowledged", updatedBy: "System (WhatsApp)", role: "Supplier", timestamp: "2026-06-27T12:10:00Z" },
        { status: "In Transit", updatedBy: "Johnson", role: "Admin", timestamp: "2026-06-27T13:00:00Z" },
        { status: "Reached Warehouse", updatedBy: "System (Webhook)", role: "Supplier", timestamp: "2026-06-27T15:30:00Z" }
      ]
    },
    {
      id: "REQ-1005",
      employeeName: "Robert Smith",
      department: "Production",
      date: "2026-06-27T14:40:00Z",
      productName: "sensor probe E5C",
      qty: 1,
      units: "units",
      suggestedSupplier: "Vel Automobiles",
      billTo: "Alagiri Board Division",
      description: "Temperature sensor probe for Dryer Section drum thermostatic controller.",
      status: "Approved",
      supplierId: "sup-2",
      poNumber: "PO-2026-004",
      poDate: "2026-06-27T15:00:00Z",
      lrCopy: null,
      history: [
        { status: "Pending", updatedBy: "Robert Smith", role: "Employee", timestamp: "2026-06-27T14:40:00Z" },
        { status: "Approved", updatedBy: "Johnson", role: "Admin", timestamp: "2026-06-27T15:00:00Z" }
      ]
    }
  ],

  // Default logs representing system initialization
  initialLogs: [
    {
      timestamp: "2026-06-25T09:30:00Z",
      userName: "John Doe",
      role: "Employee",
      action: "Created Request",
      previousValue: "None",
      updatedValue: "Pending",
      details: "Created REQ-1001: chain wheel 10pcs."
    },
    {
      timestamp: "2026-06-25T11:00:00Z",
      userName: "Johnson",
      role: "Admin",
      action: "Approved Request & Generated PO",
      previousValue: "Pending",
      updatedValue: "Approved",
      details: "Approved REQ-1001. Generated PO-2026-001 for AB Company."
    },
    {
      timestamp: "2026-06-26T12:30:00Z",
      userName: "John Doe",
      role: "Employee",
      action: "Marked Delivered",
      previousValue: "Reached Warehouse",
      updatedValue: "Delivered",
      details: "Physically verified and completed REQ-1001."
    }
  ]
};
