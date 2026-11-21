/**
 * ============================================================================
 * Shop Control System - Complete Application Core
 * Role-Based: Admin (Owner) & Employee (Seller)
 * Multi-branch, Multi-language (EN, RW, FR), System/Light/Dark Themes
 * ============================================================================
 */

/* ----------------------------------------------------------------------------
   1. Data Storage & Local Database
   ---------------------------------------------------------------------------- */
const DB_KEY = 'shop_control_v2_db';
const SESSION_KEY = 'shop_control_session';
const FIREBASE_CONFIG_KEY = 'shopctrl_firebase_cfg';

const storage = {
  get(key, defaultVal = null) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : defaultVal;
    } catch (e) {
      console.error('Storage get error:', e);
      return defaultVal;
    }
  },
  set(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.error('Storage set error:', e);
    }
  }
};

/* ----------------------------------------------------------------------------
   2. Clean Database Model (Zero Initial Data)
   ---------------------------------------------------------------------------- */
function getBlankDatabase(companyName = '', branchName = 'Main Branch', adminPassword = 'admin123', empPassword = 'seller123', empName = 'Staff 1') {
  return {
    settings: {
      isConfigured: !!companyName,
      adminPassword: adminPassword,
      companyName: companyName,
      activeBranchId: 'branch-1',
      branches: [
        {
          id: 'branch-1',
          name: branchName,
          employeePassword: empPassword,
          employees: [
            { id: 'emp-1', name: empName || 'Staff 1', pin: empPassword || '1234' }
          ],
          createdAt: getTodayStr()
        }
      ]
    },
    suppliers: [],
    purchases: [],
    supplierPayments: [],
    products: [],
    customers: [],
    sales: [],
    customerPayments: [],
    employeeExpenses: [],
    others: [],
    extensionRequests: [],
    deletedCustomersLog: [],
    returns: [],
    cashReconciliations: []
  };
}

let db = storage.get(DB_KEY);
if (!db || !db.settings) {
  db = getBlankDatabase();
  storage.set(DB_KEY, db);
} else {
  // Ensure array extensions exist
  if (!db.returns) db.returns = [];
  if (!db.cashReconciliations) db.cashReconciliations = [];
  if (db.settings && db.settings.branches) {
    db.settings.branches.forEach(b => {
      if (!b.employees || b.employees.length === 0) {
        b.employees = [{ id: 'emp-1', name: 'Cashier 1', pin: b.employeePassword || '1234' }];
      }
    });
  }
}

function saveDB() {
  storage.set(DB_KEY, db);
  if (typeof cloudSync !== 'undefined' && cloudSync.enabled) cloudSync.push();
}

/* ----------------------------------------------------------------------------
   Cloud Sync Module — Firebase Firestore (optional, offline-first)
   Each business gets their own Firebase project. Developer configures once.
   Owner can then access real-time data from any device or browser.

   FIRESTORE SECURITY RULES (set in Firebase Console → Firestore → Rules):
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /shops/{shopId} {
         allow read, write: if true; // tighten per business in production
       }
     }
   }
   ---------------------------------------------------------------------------- */
const cloudSync = {
  enabled: false,
  firestoreDb: null,
  companySlug: '',
  unsubscribe: null,
  _syncing: false,
  _pushTimer: null,

  getStoredConfig() {
    return storage.get(FIREBASE_CONFIG_KEY);
  },

  async init(firebaseConfig, companySlug) {
    try {
      if (typeof firebase === 'undefined' || !firebase.app) return false;
      let app;
      try { app = firebase.app(); } catch (e) { app = firebase.initializeApp(firebaseConfig); }
      this.firestoreDb = firebase.firestore(app);
      this.companySlug = (companySlug || db.settings.companyName || 'shop')
        .replace(/\s+/g, '-').toLowerCase().replace(/[^a-z0-9-]/g, '');
      this.enabled = true;
      storage.set(FIREBASE_CONFIG_KEY, { ...firebaseConfig, companySlug: this.companySlug });
      this._startRealtimeListener();
      await this.push();
      return true;
    } catch (err) {
      console.error('Firebase init failed:', err);
      this.enabled = false;
      this._setStatus('error');
      return false;
    }
  },

  // Debounced push — batches rapid saves into one write
  push() {
    if (!this.enabled || !this.firestoreDb) return;
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this._doPush(), 1500);
  },

  async _doPush() {
    if (!this.enabled || !this.firestoreDb || this._syncing) return;
    this._syncing = true;
    this._setStatus('syncing');
    try {
      await this.firestoreDb.collection('shops').doc(this.companySlug).set({
        db: JSON.parse(JSON.stringify(db)),
        lastUpdated: new Date().toISOString(),
        updatedBy: (typeof state !== 'undefined' ? (state.employeeName || state.role || 'system') : 'system')
      });
      this._setStatus('synced');
    } catch (err) {
      console.error('Cloud push error:', err);
      this._setStatus('error');
    } finally {
      this._syncing = false;
    }
  },

  async pull() {
    if (!this.enabled || !this.firestoreDb) return false;
    try {
      const doc = await this.firestoreDb.collection('shops').doc(this.companySlug).get();
      if (doc.exists && doc.data() && doc.data().db) {
        const remoteDb = doc.data().db;
        db = remoteDb;
        if (!db.returns) db.returns = [];
        if (!db.cashReconciliations) db.cashReconciliations = [];
        storage.set(DB_KEY, db);
        return true;
      }
      return false;
    } catch (err) {
      console.error('Cloud pull error:', err);
      return false;
    }
  },

  _startRealtimeListener() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = this.firestoreDb.collection('shops').doc(this.companySlug)
      .onSnapshot((doc) => {
        if (doc.exists && doc.data() && doc.data().db && !this._syncing) {
          const remoteDb = doc.data().db;
          // Only overwrite if remote is genuinely newer
          if (!remoteDb.lastUpdated || !db._lastSaved || remoteDb.lastUpdated > db._lastSaved) {
            db = remoteDb;
            if (!db.returns) db.returns = [];
            if (!db.cashReconciliations) db.cashReconciliations = [];
            storage.set(DB_KEY, db);
            if (typeof refreshUI === 'function') refreshUI();
          }
        }
      }, (err) => {
        console.error('Realtime listener error:', err);
        this._setStatus('error');
      });
  },

  _setStatus(status) {
    const dot = document.getElementById('online-indicator');
    const lbl = document.getElementById('sync-status-label');
    if (!dot) return;
    if (status === 'synced') {
      dot.className = 'dot green'; dot.title = '☁️ Cloud Synced';
      if (lbl) { lbl.textContent = '✓ Synced'; lbl.style.display = 'inline'; }
    } else if (status === 'syncing') {
      dot.className = 'dot yellow'; dot.title = '☁️ Syncing to Cloud...';
      if (lbl) { lbl.textContent = '↑ Syncing'; lbl.style.display = 'inline'; }
    } else if (status === 'offline') {
      dot.className = 'dot red'; dot.title = 'Offline (local storage only)';
      if (lbl) { lbl.style.display = 'none'; }
    } else if (status === 'error') {
      dot.className = 'dot red'; dot.title = '⚠️ Cloud Sync Error — check config';
      if (lbl) { lbl.textContent = '⚠ Sync Error'; lbl.style.display = 'inline'; }
    } else if (status === 'local') {
      dot.className = 'dot green'; dot.title = 'Online (local storage only)';
      if (lbl) { lbl.style.display = 'none'; }
    }
  },

  disconnect() {
    if (this.unsubscribe) this.unsubscribe();
    clearTimeout(this._pushTimer);
    this.enabled = false;
    this.firestoreDb = null;
    this.companySlug = '';
    storage.remove(FIREBASE_CONFIG_KEY);
    this._setStatus('local');
  }
};

/* ----------------------------------------------------------------------------
   3. Translation & Internationalization (EN, RW, FR)
   ---------------------------------------------------------------------------- */
const i18n = {
  en: {
    // General & Auth
    appName: 'Shop Control',
    admin: 'Admin',
    employee: 'Employee',
    login: 'Login',
    password: 'Password',
    enterPassword: 'Enter your password...',
    invalidCredentials: 'Invalid password. Please check your credentials.',
    role: 'Role',
    branch: 'Branch',
    branches: 'Branches',
    switchBranch: 'Switch Branch',
    settings: 'Settings',
    loginAsEmployee: 'Log in as Employee',
    loginAsAdmin: 'Log in as Admin',
    logout: 'Log out',
    theme: 'Theme',
    language: 'Language',
    close: 'Close',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    confirm: 'Confirm',
    decline: 'Decline',
    changeDate: 'Change Date',
    status: 'Status',
    actions: 'Actions',
    date: 'Date',
    time: 'Time',
    search: 'Search...',
    all: 'All',
    // Low Stock & Out-of-Stock
    lowStock: 'Low Stock',
    outOfStock: 'Out of Stock',
    minStockAlert: 'Low Stock Alert Threshold',
    restockAlerts: 'Restock & Inventory Alerts',
    inStock: 'In Stock',
    lowStockTab: 'Low Stock',
    outOfStockTab: 'Out of Stock',

    // Returns & Sale Cancellation
    voidSale: 'Return / Cancel Sale',
    voidReason: 'Reason for Return / Cancellation',
    voidConfirm: 'Confirm Return & Restore Stock',
    voidSuccess: 'Sale voided successfully and inventory restored.',
    voided: 'Voided / Returned',
    voidedBy: 'Voided By',
    saleVoidedNotification: 'Sale voided and stock restored',

    // Cash Drawer Reconciliation
    cashReconciliation: 'End-of-Day Cash Drawer Reconciliation',
    expectedCash: 'Expected Cash in Drawer',
    countedCash: 'Actual Counted Cash',
    difference: 'Difference',
    drawerBalanced: 'Drawer Balanced (0 RWF Difference)',
    drawerShortage: 'Cash Shortage (Missing)',
    drawerOverage: 'Cash Overage (Surplus)',
    saveReconciliation: 'Save & Lock Daily Balancing',
    reconciliationSaved: 'Cash drawer closing saved successfully!',
    reconciliationHistory: 'Cash Drawer Closing History',
    closingNotes: 'Closing Notes / Remarks',
    cashSales: 'Cash Sales',
    cashDebtCollected: 'Cash Debt Repayments',
    cashExpensesPaid: 'Cash Expenses Paid',
    cashRefundsPaid: 'Cash Refunds Paid',

    // P&L Statement
    plStatement: 'Profit & Loss (P&L) Performance',
    grossSales: 'Gross Sales Revenue',
    cogs: 'Cost of Goods Sold (COGS)',
    grossProfit: 'Gross Profit',
    grossMargin: 'Gross Margin',
    operatingExpenses: 'Operating Expenses',
    netProfit: 'Net Profit',
    netMargin: 'Net Margin',
    profitable: 'Profitable',
    netLoss: 'Net Loss',
    netCashFlow: 'Net Cash Flow',

    // Employee PINs & Staff
    sellerPIN: 'Seller PIN',
    selectSeller: 'Select Seller / Cashier',
    enterPIN: 'Enter 4-digit PIN',
    sellerName: 'Seller Name',
    branchEmployees: 'Branch Employees & Cashiers',
    addEmployee: 'Add Employee',
    employeeAdded: 'Employee added successfully!',
    employeeDeleted: 'Employee removed.',
    cannotDeleteLastEmployee: 'A branch must have at least one employee/PIN.',
    soldBy: 'Sold by',
    recordedBy: 'Recorded by',
    success: 'Success',
    error: 'Error',
    done: 'Done',

    // Menu
    menuProducts: 'Products',
    menuCustomers: 'Customers',
    menuShopControl: 'Shop Control',
    menuPurchases: 'Purchases',
    menuSuppliers: 'Suppliers',
    menuOthers: 'Others',
    menuNotifications: 'Notifications',
    menuSettings: 'Settings',
    menuSales: 'Sales (POS)',

    // Products
    registered: 'Registered',
    notYetRegistered: 'Not yet registered',
    addProduct: 'Add product',
    productName: 'Product Name',
    version: 'Version',
    versionHint: 'Required when product name already exists',
    batchChoice: 'Batch Choice',
    batchHint: 'Required when product name & version already exist',
    supplier: 'Supplier',
    stock: 'Stock',
    unit: 'Unit',
    quantity: 'Quantity',
    unitCost: 'Cost Price',
    sellingPrice: 'Selling Price',
    purchaseDate: 'Purchase Date',
    dateAdded: 'Date Added',
    costToSellPrice: 'Cost → Selling Price',
    choosePurchasedItem: 'Choose purchased item',
    selectPurchasedPlaceholder: '-- Select a purchased item to register --',
    productAddedSuccess: 'Product registered successfully and added to store inventory!',
    productDeletedSuccess: 'Product deleted successfully!',
    autoFilledLocked: 'Auto-filled & Locked',

    // Customers
    partiallyPaid: 'Partially Paid',
    fullyPaid: 'Fully Paid',
    overdue: 'Overdue',
    totalDebt: 'Total Debt',
    paid: 'Paid',
    remaining: 'Remaining',
    firstPromisedDate: 'First Promised Date',
    newPromisedDate: 'New Promised Date',
    purchasesHistory: 'Purchases History',
    paymentsHistory: 'Payments History',
    recordPayment: 'Record Payment',
    paymentAmount: 'Payment Amount',
    paymentChannel: 'Payment Channel',
    requestExtension: 'Request Extension',
    requestedDate: 'Requested Future Date',
    extensionReason: 'Reason for Extension',
    cannotDeleteCustomerDebt: 'Cannot delete customer: Outstanding credit remaining!',
    customerDeletedSuccess: 'Customer deleted successfully. Admin has been notified.',
    viewOnly: 'View Only (Admin)',
    extensionOnlyWhenReached: 'Extension request enabled only when promised date is reached and credit is unpaid.',

    // Shop Control
    daily: 'Daily (Today)',
    weekly: 'Weekly (Last 7 Days)',
    monthly: 'Monthly (Last 30 Days)',
    specificDay: 'Specific Past Day',
    totalReceived: 'Total Received',
    totalSales: 'Total Sales',
    creditGiven: 'Credit Given',
    moneyUsedByEmployees: 'Money Used by Employees',
    netCash: 'Net Cash',
    creditPaymentsVsSale: 'Credit Payments vs Paid at Sale',
    paidAtSale: 'Paid at Sale',
    creditPayments: 'Credit Payments',
    paymentModesBreakdown: 'Payment Modes & Totals',
    productsSoldByPrice: 'Products Sold Grouped by Price',
    employeeExpensesTitle: 'Employee Purchases (Expenses)',
    actionDone: 'Action Done',
    amount: 'Amount',

    // Purchases (Admin)
    newPurchase: 'New Purchase Entry',
    selectOrCreateSupplier: 'Select or Register Supplier',
    registerSupplier: '+ Register New Supplier',
    supplierName: 'Supplier Name',
    supplierPhone: 'Supplier Phone (up to 10 digits)',
    supplierBank: 'Bank Account (digits only)',
    promisedPaymentDate: 'Promised Payment Date',
    paidNow: 'Paid Now',
    paymentMethod: 'Payment Method',
    accountPaidTo: 'Account Paid To',
    recentPurchases: 'Recent Purchases',
    cannotDeleteRegisteredPurchase: 'Cannot delete: Item is already registered in Products inventory!',
    purchaseDeletedSuccess: 'Purchase record deleted successfully.',
    totalCost: 'Total Cost',

    // Suppliers (Admin)
    supplierList: 'Suppliers Overview',
    bankAccountsUsed: 'Bank Accounts Used',
    totalCreditOwed: 'Total Credit Owed',
    cannotDeleteSupplierOwed: 'Cannot delete supplier: Outstanding balance is owed!',
    supplierDeletedSuccess: 'Supplier deleted successfully.',
    recordSupplierPayment: 'Pay Supplier Credit',

    // Others (Admin)
    othersTitle: 'Others (Special Purchases & Stock)',
    tinNumber: 'TIN (9 digits)',
    sellPriceLater: 'Selling Price (Later)',
    entryDate: 'Entry Date',
    soldOutDate: 'Sold-out Date',
    tinInvalid: 'TIN must be exactly 9 digits.',

    // Notifications
    extensionRequests: 'Promised-Date Extension Requests',
    deletedCustomersLogTitle: 'Customers Deleted by Employees',
    remindersDueNow: 'Reminders Due Now (at 10:00) & Upcoming',
    requestConfirmedSuccess: 'Extension request approved! Customer promised date updated.',
    requestDeclinedSuccess: 'Extension request declined.',
    historyFilter: 'Filter History',
    byWeek: 'By Week',
    bySpecificDay: 'By Specific Day',

    // Sales (Employee)
    customer: 'Customer',
    registerCustomer: '+ Register New Customer',
    customerName: 'Customer Name (letters only)',
    customerPhone: 'Phone (up to 10 digits)',
    containerSize: 'Container Size (Litres)',
    containerCount: 'Container Count',
    addToCart: 'Add to Cart',
    cart: 'Cart',
    emptyCart: 'Cart is empty',
    lineTotal: 'Line Total',
    grandTotal: 'Grand Total',
    finalizeSale: 'Finalize Sale',
    notEnoughStock: 'Not enough stock available!',
    promisedDateRequired: 'Promised payment date is required and must be in the future when credit is given.',
    saleSuccess: 'Sale completed successfully!',
    editablePrice: 'Price per Unit (Editable)',

    // Employee Purchases (Expenses)
    recordEmployeePurchase: 'Record Daily Expense / Petty Cash',
    expenseReason: 'Action Done (e.g. transport, cleaning, packaging)',
    totalUsedToday: 'Total Used Today',
    expenseSavedSuccess: 'Expense recorded. Net cash has been updated.',

    // Settings
    adminSettings: 'Shop & Security Settings',
    currentBranchName: 'Branch Name',
    adminPasswordLabel: 'New Admin Password',
    branchEmployeePassword: 'Employee Password for this Branch',
    addNewBranch: 'Add New Branch',
    newBranchName: 'New Branch Name',
    newBranchEmpPassword: 'Employee Password for New Branch',
    settingsSavedSuccess: 'Settings updated successfully!',

    // Onboarding & Backup
    welcomeTitle: 'Welcome to Shop Control',
    setupSubtitle: 'Set up your business to get started. All data is kept 100% private on your device.',
    setupBusinessName: 'Business / Company Name',
    setupBranchName: 'Main Branch Name',
    setupAdminPassword: 'Create Owner (Admin) Password',
    setupEmployeePassword: 'Create Seller (Employee) Password',
    setupSubmit: 'Initialize My Shop & Start',
    backupExport: 'Export Backup',
    backupImport: 'Import Backup',
    resetShop: 'Factory Reset Shop'
  },

  rw: {
    // General & Auth
    appName: 'Ubugenzuzi bw’Iduka',
    admin: 'Umuyobozi (Admin)',
    employee: 'Umukozi (Seller)',
    login: 'Kwinjira',
    password: 'Ijambobanga',
    enterPassword: 'Andika ijambobanga...',
    invalidCredentials: 'Ijambobanga si ryo. Ongera ugerageze.',
    role: 'Urwego',
    branch: 'Ishami',
    branches: 'Amashami',
    switchBranch: 'Hindura Ishami',
    settings: 'Igenamiterere',
    loginAsEmployee: 'Injira nk’Umukozi',
    loginAsAdmin: 'Injira nk’Umuyobozi',
    logout: 'Gusohoka',
    theme: 'Imiterere',
    language: 'Ururimi',
    close: 'Funga',
    save: 'Bika',
    cancel: 'Kureka',
    delete: 'Siba',
    confirm: 'Emeza',
    decline: 'Wange',
    changeDate: 'Hindura Itariki',
    status: 'Imiterere',
    actions: 'Ibikorwa',
    date: 'Itariki',
    time: 'Isaha',
    search: 'Shakisha...',
    all: 'Byose',
    // Low Stock & Out-of-Stock
    lowStock: 'Ibicuruzwa Biri Hafi Gushira',
    outOfStock: 'Ibicuruzwa Byashize',
    minStockAlert: 'Integuza y\'Ibicuruzwa Biri Hafi Gushira',
    restockAlerts: 'Integuza zo Kongera Ibicuruzwa',
    inStock: 'Biri mu Bubiko',
    lowStockTab: 'Ibigiye gushira',
    outOfStockTab: 'Ibyashize',

    // Returns & Sale Cancellation
    voidSale: 'Gusubiza / Guhagarika Igurisha',
    voidReason: 'Impamvu yo gusubiza cyangwa guhagarika',
    voidConfirm: 'Emeza Gusubiza & Garura mu Bubiko',
    voidSuccess: 'Igurisha ryasubijwe neza n\'ibicuruzwa byasubijwe mu bubiko.',
    voided: 'Yasubijwe / Yahagaritswe',
    voidedBy: 'Yasubijwe na',
    saleVoidedNotification: 'Igurisha ryasubijwe ibicuruzwa bigarurwa mu bubiko',

    // Cash Drawer Reconciliation
    cashReconciliation: 'Ibaruramari ryo Gusoza Umunsi (Ikeshi)',
    expectedCash: 'Amafaranga ateganyijwe mu ikeshi',
    countedCash: 'Amafaranga yabaruwe mu ntoki',
    difference: 'Itandukaniro',
    drawerBalanced: 'Ikeshi ryuzuye neza (Nta kinyuranyo)',
    drawerShortage: 'Habuze amafaranga (Ikeshi ryabuze)',
    drawerOverage: 'Amafaranga yarenzeho mu ikeshi',
    saveReconciliation: 'Bika Ibaruramari ry\'Umunsi',
    reconciliationSaved: 'Ibaruramari ry\'ikeshi ryabitswe neza!',
    reconciliationHistory: 'Amateka y\'ibaruramari ry\'ikeshi',
    closingNotes: 'Ibisobanuro by\'inyongera',
    cashSales: 'Ibyagurishijwe mu Ntoki',
    cashDebtCollected: 'Imyenda yishyuwe mu Ntoki',
    cashExpensesPaid: 'Amafaranga yakoreshejwe mu ntoki',
    cashRefundsPaid: 'Amafaranga yasubijwe mu ntoki',

    // P&L Statement
    plStatement: 'Inyungu n\'Igihombo (P&L)',
    grossSales: 'Amafaranga yose yinjiye mu bucuruzi',
    cogs: 'Igiciro cy\'Ibicuruzwa Byagurishijwe (COGS)',
    grossProfit: 'Inyungu Mbumbe',
    grossMargin: 'Ijanisha ry\'Inyungu Mbumbe',
    operatingExpenses: 'Amafaranga yakoreshejwe',
    netProfit: 'Inyungu Nyayo',
    netMargin: 'Ijanisha ry\'Inyungu Nyayo',
    profitable: 'Hari Inyungu',
    netLoss: 'Igihombo',
    netCashFlow: 'Amafaranga asigaye mu ntoki',

    // Employee PINs & Staff
    sellerPIN: 'PIN y\'Umukozi',
    selectSeller: 'Hitamo Umukozi / Umucuruzi',
    enterPIN: 'Injiza PIN y\'imibare 4',
    sellerName: 'Izina ry\'Umukozi',
    branchEmployees: 'Abakozi b\'Ishami & PIN',
    addEmployee: 'Ongeraho Umukozi',
    employeeAdded: 'Umukozi yongeweho neza!',
    employeeDeleted: 'Umukozi yakuwemo.',
    cannotDeleteLastEmployee: 'Ishami rigomba kugira byibuze umukozi umwe.',
    soldBy: 'Yagurishijwe na',
    recordedBy: 'Yanditswe na',
    success: 'Byagenze neza',
    error: 'Ikosa',
    done: 'Byarangiye',

    // Menu
    menuProducts: 'Ibicuruzwa',
    menuCustomers: 'Abakiriya',
    menuShopControl: 'Ubugenzuzi bw’Iduka',
    menuPurchases: 'Ibyaguzwe (Stock)',
    menuSuppliers: 'Abarangura',
    menuOthers: 'Ibindi',
    menuNotifications: 'Ubutumwa',
    menuSettings: 'Igenamiterere',
    menuSales: 'Kugurisha (POS)',

    // Products
    registered: 'Byanditswe',
    notYetRegistered: 'Bitarandikwa',
    addProduct: 'Ongeramo Igicuruzwa',
    productName: 'Izina ry’Igicuruzwa',
    version: 'Verisiyo',
    versionHint: 'Ikenewe iyo izina ry’igicuruzwa risanzwe rihari',
    batchChoice: 'Icyiciro (Batch)',
    batchHint: 'Ikenewe iyo izina na verisiyo bisanzwe bihari',
    supplier: 'Uwamuritse',
    stock: 'Stock ihari',
    unit: 'Igipimo',
    quantity: 'Ingano',
    unitCost: 'Igiciro cyaranguriweho',
    sellingPrice: 'Igiciro cyo kugurisha',
    purchaseDate: 'Itariki byaguriweho',
    dateAdded: 'Itariki byongereweho',
    costToSellPrice: 'Kurangura → Kugurisha',
    choosePurchasedItem: 'Hitamo icyarangarijwe',
    selectPurchasedPlaceholder: '-- Hitamo ibyarangarijwe bishyirwe muri stock --',
    productAddedSuccess: 'Igicuruzwa cyanditswe neza muri stock!',
    productDeletedSuccess: 'Igicuruzwa cyasibwe!',
    autoFilledLocked: 'Byujuje ku buryo budahinduka',

    // Customers
    partiallyPaid: 'Bishyuye igice',
    fullyPaid: 'Bishyuye byose',
    overdue: 'Barengeje igihe',
    totalDebt: 'Umwenda wose',
    paid: 'Ayishyuwe',
    remaining: 'Asigaye',
    firstPromisedDate: 'Itariki y’isezerano ya mbere',
    newPromisedDate: 'Itariki nshya y’isezerano',
    purchasesHistory: 'Amateka y’Ibyo yaguze',
    paymentsHistory: 'Amateka y’Ubwishyu',
    recordPayment: 'Kwakira Ubwishyu',
    paymentAmount: 'Amafaranga yishyuwe',
    paymentChannel: 'Uburyo bwo kwishyura',
    requestExtension: 'Saba Kongera Igihe',
    requestedDate: 'Itariki Nshya Isabwa',
    extensionReason: 'Impamvu yo kwimura itariki',
    cannotDeleteCustomerDebt: 'Ntushobora gusiba umukiriya ufite umwenda!',
    customerDeletedSuccess: 'Umukiriya yasibwe neza. Umuyobozi yabimenyeshejwe.',
    viewOnly: 'Kureba gusa (Umuyobozi)',
    extensionOnlyWhenReached: 'Gusaba kongera igihe byemerwa gusa iyo itariki yageze umwenda utarishyurwa.',

    // Shop Control
    daily: 'Uyu Munsi',
    weekly: 'Icyumweru Gishize',
    monthly: 'Ukwezi Gushize',
    specificDay: 'Umunsi Wihariye',
    totalReceived: 'Amafaranga Yinjiye Yose',
    totalSales: 'Ibicurujwe Byose',
    creditGiven: 'Ideni Ryatanzwe',
    moneyUsedByEmployees: 'Amafaranga Umukozi Yakoresheje',
    netCash: 'Amafaranga Asigaye (Net Cash)',
    creditPaymentsVsSale: 'Kwishyura Ideni vs Kwishyurira rimwe',
    paidAtSale: 'Yishyuriwe rimwe',
    creditPayments: 'Ubwishyu bw’amadini',
    paymentModesBreakdown: 'Uburyo bwo Kwishyura & Igiteranyo',
    productsSoldByPrice: 'Ibicuruzwa Byagurishijwe Hakurikijwe Igiciro',
    employeeExpensesTitle: 'Amafaranga Yakoreshejwe n’Umukozi',
    actionDone: 'Igikorwa Cyakozwe',
    amount: 'Amafaranga',

    // Purchases (Admin)
    newPurchase: 'Kwandika Ibiranguriwe Iduka',
    selectOrCreateSupplier: 'Hitamo cyangwa Wandike Uwurangura',
    registerSupplier: '+ Andika Uwurangura Mushya',
    supplierName: 'Izina ry’Uwamuritse',
    supplierPhone: 'Telefoni (imibare igera ku 10)',
    supplierBank: 'Konti ya Banki (imibare gusa)',
    promisedPaymentDate: 'Itariki yo Kwishyura',
    paidNow: 'Ayishyuwe ako kanya',
    paymentMethod: 'Uburyo bwo kwishyura',
    accountPaidTo: 'Konti yishyuweho',
    recentPurchases: 'Ibyarangarijwe vuba',
    cannotDeleteRegisteredPurchase: 'Ntushobora gusiba: Ibi bicuruzwa byamaze gushyirwa muri stock yo kugurisha!',
    purchaseDeletedSuccess: 'Ibyarangarijwe byasibwe neza.',
    totalCost: 'Igiciro Cyose hamwe',

    // Suppliers (Admin)
    supplierList: 'Urutonde rw’Abaranguza',
    bankAccountsUsed: 'Konti za Banki Zakoreshejwe',
    totalCreditOwed: 'Ideni Tubereyemo Abaranguza',
    cannotDeleteSupplierOwed: 'Ntushobora gusiba umuranguza tukimurimo ideni!',
    supplierDeletedSuccess: 'Umuranguza yasibwe neza.',
    recordSupplierPayment: 'Kwishyura Umuranguza',

    // Others (Admin)
    othersTitle: 'Ibindi Byaguzwe & TIN',
    tinNumber: 'TIN (imibare 9)',
    sellPriceLater: 'Igiciro cyo kugurisha (nyuma)',
    entryDate: 'Itariki byinjiriyeho',
    soldOutDate: 'Itariki byashiriyeho',
    tinInvalid: 'TIN igomba kuba igizwe n’imibare 9 gusa.',

    // Notifications
    extensionRequests: 'Ibyifuzo byo Kongera Igihe cy’Ideni',
    deletedCustomersLogTitle: 'Abakiriya Basibwe n’Abakozi',
    remindersDueNow: 'Ibibutsa by’Uyu Munsi (Saa 10:00) & Ibiri hafi',
    requestConfirmedSuccess: 'Icyifuzo cyo kongera igihe cyemejwe neza!',
    requestDeclinedSuccess: 'Icyifuzo cyo kongera igihe cyanzwe.',
    historyFilter: 'Gushungura Amateka',
    byWeek: 'Ku Cyumweru',
    bySpecificDay: 'Ku Munsi Wihariye',

    // Sales (Employee)
    customer: 'Umukiriya',
    registerCustomer: '+ Andika Umukiriya Mushya',
    customerName: 'Izina ry’Umukiriya (inyuguti gusa)',
    customerPhone: 'Telefoni (imibare igera ku 10)',
    containerSize: 'Ingano y’Ijerikani (Litiro)',
    containerCount: 'Umubare w’amajerikani',
    addToCart: 'Ongeraho mu Gikapu',
    cart: 'Igikapu',
    emptyCart: 'Nta kiri mu gikapu',
    lineTotal: 'Igiteranyo',
    grandTotal: 'Igiteranyo Cyose hamwe',
    finalizeSale: 'Emeza Igurisha',
    notEnoughStock: 'Stock ihari ntihagije!',
    promisedDateRequired: 'Itariki yo kwishyura irakenewe kandi igomba kuba itariki yo mu minsi iri imbere.',
    saleSuccess: 'Igurisha ryemejwe neza!',
    editablePrice: 'Igiciro cya buri kimwe (Gishobora guhinduka)',

    // Employee Purchases (Expenses)
    recordEmployeePurchase: 'Andika Amafaranga Akoreshejwe n’Umukozi',
    expenseReason: 'Igikorwa Cyakozwe (urugero: transport, isuku, amapaki)',
    totalUsedToday: 'Ayakoreshejwe Uyu Munsi',
    expenseSavedSuccess: 'Byabitswe neza. Net cash yahindutse.',

    // Settings
    adminSettings: 'Igenamiterere ry’Iduka n’Umutekano',
    currentBranchName: 'Izina ry’Ishami',
    adminPasswordLabel: 'Ijambobanga Rishya ry’Umuyobozi',
    branchEmployeePassword: 'Ijambobanga ry’Umukozi w’iri Shami',
    addNewBranch: 'Ongeraho Ishami Rishya',
    newBranchName: 'Izina ry’Ishami Rishya',
    newBranchEmpPassword: 'Ijambobanga ry’Umukozi w’Ishami Rishya',
    settingsSavedSuccess: 'Igenamiterere ryabitswe neza!',

    // Onboarding & Backup
    welcomeTitle: 'Murakaza neza mu Bugenzuzi bw’Iduka',
    setupSubtitle: 'Tunganya ubucuruzi bwawe utangire. Amakuru yose abikwa ku buryo bwizewe kuri iki gikoresho.',
    setupBusinessName: 'Izina ry’Ubucuruzi / Sosiyete',
    setupBranchName: 'Izina ry’Ishami Rikuru',
    setupAdminPassword: 'Ijambobanga ry’Umuyobozi (Admin)',
    setupEmployeePassword: 'Ijambobanga ry’Umukozi (Seller)',
    setupSubmit: 'Tangiza Iduka Ryanjye',
    backupExport: 'Kubika Amakuru (Backup)',
    backupImport: 'Kugarura Amakuru (Restore)',
    resetShop: 'Gusiba Byose Ukongera Gutangira'
  },

  fr: {
    // General & Auth
    appName: 'Contrôle du Magasin',
    admin: 'Administrateur',
    employee: 'Vendeur / Employé',
    login: 'Connexion',
    password: 'Mot de passe',
    enterPassword: 'Entrez votre mot de passe...',
    invalidCredentials: 'Mot de passe invalide. Veuillez vérifier vos accès.',
    role: 'Rôle',
    branch: 'Succursale',
    branches: 'Succursales',
    switchBranch: 'Changer de succursale',
    settings: 'Paramètres',
    loginAsEmployee: 'Se connecter comme Employé',
    loginAsAdmin: 'Se connecter comme Administrateur',
    logout: 'Déconnexion',
    theme: 'Thème',
    language: 'Langue',
    close: 'Fermer',
    save: 'Enregistrer',
    cancel: 'Annuler',
    delete: 'Supprimer',
    confirm: 'Confirmer',
    decline: 'Refuser',
    changeDate: 'Changer la date',
    status: 'Statut',
    actions: 'Actions',
    date: 'Date',
    time: 'Heure',
    search: 'Rechercher...',
    all: 'Tous',
    // Low Stock & Out-of-Stock
    lowStock: 'Stock Faible',
    outOfStock: 'Rupture de Stock',
    minStockAlert: 'Seuil d\'alerte stock faible',
    restockAlerts: 'Alertes de Réapprovisionnement',
    inStock: 'En Stock',
    lowStockTab: 'Stock Faible',
    outOfStockTab: 'Épuisé',

    // Returns & Sale Cancellation
    voidSale: 'Retourner / Annuler la Vente',
    voidReason: 'Motif du retour ou de l\'annulation',
    voidConfirm: 'Confirmer le Retour & Restaurer le Stock',
    voidSuccess: 'Vente annulée avec succès et stock restauré.',
    voided: 'Annulée / Retournée',
    voidedBy: 'Annulée Par',
    saleVoidedNotification: 'Vente annulée et stock restauré',

    // Cash Drawer Reconciliation
    cashReconciliation: 'Rapprochement de Caisse de Fin de Journée',
    expectedCash: 'Espèces attendues en caisse',
    countedCash: 'Espèces réellement comptées',
    difference: 'Différence',
    drawerBalanced: 'Caisse Équilibrée (0 RWF de différence)',
    drawerShortage: 'Déficit de caisse (Manquant)',
    drawerOverage: 'Excédent de caisse (Surplus)',
    saveReconciliation: 'Enregistrer & Clôturer la Caisse',
    reconciliationSaved: 'Clôture de caisse enregistrée avec succès!',
    reconciliationHistory: 'Historique des clôtures de caisse',
    closingNotes: 'Remarques de clôture',
    cashSales: 'Ventes en Espèces',
    cashDebtCollected: 'Remboursements de dettes en espèces',
    cashExpensesPaid: 'Dépenses payées en espèces',
    cashRefundsPaid: 'Remboursements clients payés',

    // P&L Statement
    plStatement: 'Compte de Résultat (P&L)',
    grossSales: 'Chiffre d\'Affaires Brut',
    cogs: 'Coût des Marchandises Vendues (COGS)',
    grossProfit: 'Bénéfice Brut',
    grossMargin: 'Marge Brute',
    operatingExpenses: 'Dépenses d\'Exploitation',
    netProfit: 'Bénéfice Net',
    netMargin: 'Marge Nette',
    profitable: 'Bénéficiaire',
    netLoss: 'Perte Nette',
    netCashFlow: 'Flux Net de Trésorerie',

    // Employee PINs & Staff
    sellerPIN: 'Code PIN du Vendeur',
    selectSeller: 'Sélectionner le Vendeur / Caissier',
    enterPIN: 'Entrez le PIN à 4 chiffres',
    sellerName: 'Nom du Vendeur',
    branchEmployees: 'Employés de la Branche & PINs',
    addEmployee: 'Ajouter un Employé',
    employeeAdded: 'Employé ajouté avec succès!',
    employeeDeleted: 'Employé supprimé.',
    cannotDeleteLastEmployee: 'Une branche doit avoir au moins un employé/PIN.',
    soldBy: 'Vendu par',
    recordedBy: 'Enregistré par',
    success: 'Succès',
    error: 'Erreur',
    done: 'Terminé',

    // Menu
    menuProducts: 'Produits',
    menuCustomers: 'Clients',
    menuShopControl: 'Contrôle & Finances',
    menuPurchases: 'Achats Fournisseurs',
    menuSuppliers: 'Fournisseurs',
    menuOthers: 'Autres (TIN)',
    menuNotifications: 'Notifications',
    menuSettings: 'Paramètres',
    menuSales: 'Point de Vente (POS)',

    // Products
    registered: 'Enregistrés',
    notYetRegistered: 'Non encore enregistrés',
    addProduct: 'Ajouter un produit',
    productName: 'Nom du produit',
    version: 'Version',
    versionHint: 'Requis lorsque le nom existe déjà',
    batchChoice: 'Choix du Lot (Batch)',
    batchHint: 'Requis lorsque le nom et la version existent déjà',
    supplier: 'Fournisseur',
    stock: 'Stock disponible',
    unit: 'Unité',
    quantity: 'Quantité',
    unitCost: 'Prix de revient (Coût)',
    sellingPrice: 'Prix de vente',
    purchaseDate: "Date d'achat",
    dateAdded: "Date d'ajout",
    costToSellPrice: 'Coût → Prix de vente',
    choosePurchasedItem: 'Choisir un article acheté',
    selectPurchasedPlaceholder: '-- Choisir un achat à mettre en vente --',
    productAddedSuccess: 'Produit mis en vente avec succès !',
    productDeletedSuccess: 'Produit supprimé !',
    autoFilledLocked: 'Auto-rempli & Verrouillé',

    // Customers
    partiallyPaid: 'Partiellement payé',
    fullyPaid: 'Totalement payé',
    overdue: 'En retard',
    totalDebt: 'Dette totale',
    paid: 'Payé',
    remaining: 'Restant dû',
    firstPromisedDate: 'Première date promise',
    newPromisedDate: 'Nouvelle date promise',
    purchasesHistory: 'Historique des Achats',
    paymentsHistory: 'Historique des Règlements',
    recordPayment: 'Encaisser un paiement',
    paymentAmount: 'Montant versé',
    paymentChannel: 'Mode de paiement',
    requestExtension: 'Demander une prolongation',
    requestedDate: 'Nouvelle date demandée',
    extensionReason: 'Motif du report',
    cannotDeleteCustomerDebt: 'Impossible de supprimer un client ayant une dette impayée !',
    customerDeletedSuccess: 'Client supprimé. L’administrateur a été notifié.',
    viewOnly: 'Lecture seule (Admin)',
    extensionOnlyWhenReached: "La prolongation n'est disponible que lorsque la date promise est échue et la dette impayée.",

    // Shop Control
    daily: "Aujourd'hui",
    weekly: '7 derniers jours',
    monthly: '30 derniers jours',
    specificDay: 'Jour spécifique',
    totalReceived: 'Total Encaissé',
    totalSales: 'Ventes Totales',
    creditGiven: 'Crédit Accordé',
    moneyUsedByEmployees: 'Dépenses Employés',
    netCash: 'Trésorerie Nette',
    creditPaymentsVsSale: 'Paiements Crédits vs Ventes Comptant',
    paidAtSale: 'Payé à la vente',
    creditPayments: 'Règlements de créances',
    paymentModesBreakdown: 'Modes de Paiement & Totaux',
    productsSoldByPrice: 'Produits Vendus Groupés par Prix',
    employeeExpensesTitle: 'Dépenses Journalières des Employés',
    actionDone: 'Dépense effectuée',
    amount: 'Montant',

    // Purchases (Admin)
    newPurchase: 'Nouvel Achat Fournisseur',
    selectOrCreateSupplier: 'Sélectionner ou Créer un Fournisseur',
    registerSupplier: '+ Enregistrer un Fournisseur',
    supplierName: 'Nom du Fournisseur',
    supplierPhone: 'Téléphone (jusqu’à 10 chiffres)',
    supplierBank: 'Numéro de Compte (chiffres uniquement)',
    promisedPaymentDate: 'Date promise de paiement',
    paidNow: 'Payé immédiatement',
    paymentMethod: 'Moyen de paiement',
    accountPaidTo: 'Compte de destination',
    recentPurchases: 'Achats Récents',
    cannotDeleteRegisteredPurchase: 'Suppression impossible : cet article est déjà mis en vente dans les Produits !',
    purchaseDeletedSuccess: 'Achat supprimé avec succès.',
    totalCost: 'Coût Total',

    // Suppliers (Admin)
    supplierList: 'Gestion des Fournisseurs',
    bankAccountsUsed: 'Comptes Bancaires Utilisés',
    totalCreditOwed: 'Dette Fournisseur Restante',
    cannotDeleteSupplierOwed: 'Suppression impossible : une dette est encore due à ce fournisseur !',
    supplierDeletedSuccess: 'Fournisseur supprimé avec succès.',
    recordSupplierPayment: 'Régler le Fournisseur',

    // Others (Admin)
    othersTitle: 'Autres Achats & TIN',
    tinNumber: 'TIN (9 chiffres)',
    sellPriceLater: 'Prix de vente (ultérieur)',
    entryDate: "Date d'entrée",
    soldOutDate: 'Date d’épuisement',
    tinInvalid: 'Le numéro TIN doit comporter exactement 9 chiffres.',

    // Notifications
    extensionRequests: 'Demandes de Prolongation de Date',
    deletedCustomersLogTitle: 'Clients Supprimés par les Employés',
    remindersDueNow: 'Rappels Échus (à 10:00) & À venir',
    requestConfirmedSuccess: 'Prolongation approuvée ! Date promise mise à jour.',
    requestDeclinedSuccess: 'Prolongation refusée.',
    historyFilter: 'Filtrer l’Historique',
    byWeek: 'Par Semaine',
    bySpecificDay: 'Par Jour Spécifique',

    // Sales (Employee)
    customer: 'Client',
    registerCustomer: '+ Nouveau Client',
    customerName: 'Nom du client (lettres uniquement)',
    customerPhone: 'Téléphone (jusqu’à 10 chiffres)',
    containerSize: 'Taille du bidon (Litres)',
    containerCount: 'Nombre de bidons',
    addToCart: 'Ajouter au Panier',
    cart: 'Panier',
    emptyCart: 'Le panier est vide',
    lineTotal: 'Total Ligne',
    grandTotal: 'Total Général',
    finalizeSale: 'Valider la Vente',
    notEnoughStock: 'Stock insuffisant !',
    promisedDateRequired: 'La date promise de paiement est requise et doit être future en cas de vente à crédit.',
    saleSuccess: 'Vente effectuée avec succès !',
    editablePrice: 'Prix unitaire (Modifiable)',

    // Employee Purchases (Expenses)
    recordEmployeePurchase: 'Enregistrer une Dépense / Menue Dépense',
    expenseReason: 'Action effectuée (transport, nettoyage, etc.)',
    totalUsedToday: 'Total Dépensé Aujourd’hui',
    expenseSavedSuccess: 'Dépense enregistrée. La trésorerie nette a été actualisée.',

    // Settings
    adminSettings: 'Paramètres du Magasin & Sécurité',
    currentBranchName: 'Nom de la Succursale',
    adminPasswordLabel: 'Nouveau mot de passe Admin',
    branchEmployeePassword: 'Mot de passe Employé de cette succursale',
    addNewBranch: 'Ajouter une nouvelle succursale',
    newBranchName: 'Nom de la succursale',
    newBranchEmpPassword: 'Mot de passe Employé',
    settingsSavedSuccess: 'Paramètres mis à jour avec succès !',

    // Onboarding & Backup
    welcomeTitle: 'Bienvenue dans Contrôle du Magasin',
    setupSubtitle: 'Configurez votre entreprise pour commencer. Vos données restent 100% privées sur votre appareil.',
    setupBusinessName: 'Nom de l’Entreprise / Magasin',
    setupBranchName: 'Nom de la Succursale Principale',
    setupAdminPassword: 'Mot de passe Propriétaire (Admin)',
    setupEmployeePassword: 'Mot de passe Vendeur (Employé)',
    setupSubmit: 'Initialiser et Démarrer',
    backupExport: 'Exporter une Sauvegarde',
    backupImport: 'Importer une Sauvegarde',
    resetShop: 'Réinitialiser le Magasin'
  }
};

let currentLang = storage.get('lang', 'en');
let currentTheme = storage.get('theme', 'system');

function t(key) {
  return (i18n[currentLang] && i18n[currentLang][key]) || (i18n.en && i18n.en[key]) || key;
}

function applyTheme(theme = currentTheme) {
  currentTheme = theme;
  storage.set('theme', theme);
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

function applyLang(lang = currentLang) {
  currentLang = lang;
  storage.set('lang', lang);
  document.documentElement.setAttribute('lang', lang);
  refreshUI();
}

/* ----------------------------------------------------------------------------
   4. Application State & Session
   ---------------------------------------------------------------------------- */
let state = {
  role: null,           // 'admin' | 'employee'
  branchId: 'branch-1',
  branchName: 'Kigali Main Branch',
  activePage: 'products',
  loggedIn: false,
  employeeId: '',
  employeeName: ''
};

const savedSession = storage.get(SESSION_KEY);
if (savedSession && savedSession.loggedIn) {
  state = savedSession;
}

// Global active branch helper
function getActiveBranch() {
  const branch = db.settings.branches.find(b => b.id === state.branchId);
  return branch || db.settings.branches[0];
}

/* ----------------------------------------------------------------------------
   5. Utility Helpers & Validators
   ---------------------------------------------------------------------------- */
function fmtMoney(amount) {
  return Number(amount || 0).toLocaleString() + ' RWF';
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getCurrentTimeStr() {
  return new Date().toTimeString().split(' ')[0];
}

function isFutureDate(dateStr) {
  if (!dateStr) return false;
  return dateStr > getTodayStr();
}

function validateName(str) {
  return /^[a-zA-Z\s]+$/.test(str.trim()) && str.trim().length > 0;
}

function validatePhone(str) {
  return /^\d{1,10}$/.test(str.trim());
}

function validateDigitsOnly(str) {
  return /^\d+$/.test(str.trim());
}

function validateTIN(str) {
  return /^\d{9}$/.test(str.trim());
}

function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Toast Messages */
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

/* Modal Helper */
const actionModal = document.getElementById('action-modal');
const actionModalTitle = document.getElementById('action-modal-title');
const actionModalBody = document.getElementById('action-modal-body');
const actionModalFooter = document.getElementById('action-modal-footer');
const closeActionModalBtn = document.getElementById('close-action-modal-btn');

if (closeActionModalBtn) {
  closeActionModalBtn.addEventListener('click', () => actionModal.close());
}

function openModal(title, bodyHtml, footerHtml = '') {
  actionModalTitle.textContent = title;
  actionModalBody.innerHTML = bodyHtml;
  actionModalFooter.innerHTML = footerHtml;
  actionModal.showModal();
}

function closeModal() {
  actionModal.close();
}

/* ----------------------------------------------------------------------------
   6. UI Elements & Event Listeners
   ---------------------------------------------------------------------------- */
const menuBtn = document.getElementById('menu-btn');
const drawer = document.getElementById('drawer');
const drawerBackdrop = document.getElementById('drawer-backdrop');
const closeDrawerBtn = document.getElementById('close-drawer-btn');
const menuList = document.getElementById('menu-list');
const drawerFooter = document.getElementById('drawer-footer');
const mainContent = document.getElementById('main-content');
const pageTitleEl = document.getElementById('page-title');
const headerMeta = document.getElementById('header-meta');
const headerBranch = document.getElementById('header-branch');
const headerRole = document.getElementById('header-role');
const profileBtn = document.getElementById('profile-btn');
const profileModal = document.getElementById('profile-modal');
const closeProfileBtn = document.getElementById('close-profile-btn');
const saveProfileBtn = document.getElementById('save-profile-btn');
const langSelect = document.getElementById('lang-select');
const themeSelect = document.getElementById('theme-select');
const branchSelect = document.getElementById('branch-select');
const branchSwitcherGroup = document.getElementById('branch-switcher-group');
const profileAdminActions = document.getElementById('profile-admin-actions');
const logoutBtn = document.getElementById('logout-btn');

function toggleDrawer(open) {
  if (open) {
    drawer.classList.add('visible');
    drawerBackdrop.classList.add('active');
  } else {
    drawer.classList.remove('visible');
    drawerBackdrop.classList.remove('active');
  }
}

if (menuBtn) menuBtn.addEventListener('click', () => toggleDrawer(true));
if (closeDrawerBtn) closeDrawerBtn.addEventListener('click', () => toggleDrawer(false));
if (drawerBackdrop) drawerBackdrop.addEventListener('click', () => toggleDrawer(false));

if (profileBtn) {
  profileBtn.addEventListener('click', () => {
    openProfileModal();
  });
}

if (closeProfileBtn) closeProfileBtn.addEventListener('click', () => profileModal.close());
if (saveProfileBtn) profileModal.addEventListener('close', () => refreshUI());

if (langSelect) {
  langSelect.addEventListener('change', e => {
    applyLang(e.target.value);
  });
}

if (themeSelect) {
  themeSelect.addEventListener('change', e => {
    applyTheme(e.target.value);
  });
}

if (branchSelect) {
  branchSelect.addEventListener('change', e => {
    const chosen = db.settings.branches.find(b => b.id === e.target.value);
    if (chosen) {
      state.branchId = chosen.id;
      state.branchName = chosen.name;
      storage.set(SESSION_KEY, state);
      showToast(`${t('switchBranch')}: ${chosen.name}`, 'info');
      refreshUI();
    }
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', () => {
    state.loggedIn = false;
    storage.set(SESSION_KEY, state);
    profileModal.close();
    renderLogin();
  });
}

/* ----------------------------------------------------------------------------
   7. Profile Menu Logic (Admin vs Employee specifics)
   ---------------------------------------------------------------------------- */
function openProfileModal() {
  const currentBranch = getActiveBranch();
  document.getElementById('profile-branch-name').textContent = state.role === 'admin' ? currentBranch.name : (db.settings.companyName || 'Shop Control');
  document.getElementById('profile-role-display').textContent = state.role === 'admin' ? 
    `${t('role')}: ${t('admin')}` : 
    `${t('role')}: ${t('employee')} (${state.employeeName || 'Staff'})`;
  
  langSelect.value = currentLang;
  themeSelect.value = currentTheme;

  // Branch switcher: strictly for Admin, only when several branches exist!
  if (state.role === 'admin' && db.settings.branches.length > 1) {
    branchSwitcherGroup.style.display = 'block';
    branchSelect.innerHTML = db.settings.branches.map(b => 
      `<option value="${b.id}" ${b.id === state.branchId ? 'selected' : ''}>${escapeHtml(b.name)}</option>`
    ).join('');
  } else {
    branchSwitcherGroup.style.display = 'none';
  }

  // Profile Admin actions: "Settings" & "Log in as Employee"
  // Employee side: Shows: company name, role, language, theme, Log out. No admin option and no other branches.
  profileAdminActions.innerHTML = '';
  if (state.role === 'admin') {
    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'btn btn-secondary btn-sm';
    settingsBtn.textContent = `⚙️ ${t('settings')}`;
    settingsBtn.onclick = () => {
      profileModal.close();
      loadPage('settings');
    };

    const switchEmpBtn = document.createElement('button');
    switchEmpBtn.className = 'btn btn-secondary btn-sm';
    switchEmpBtn.textContent = `🔄 ${t('loginAsEmployee')}`;
    switchEmpBtn.onclick = () => {
      state.role = 'employee';
      state.activePage = 'sales';
      storage.set(SESSION_KEY, state);
      profileModal.close();
      showToast(`${t('loginAsEmployee')} (${getActiveBranch().name})`, 'info');
      refreshUI();
    };

    profileAdminActions.appendChild(settingsBtn);
    profileAdminActions.appendChild(switchEmpBtn);
  } else {
    // Employee side: strictly NO admin option and NO other branches.
    profileAdminActions.innerHTML = '';
  }

  profileModal.showModal();
}

function promptAdminPasswordSwitch() {
  openModal(
    t('loginAsAdmin'),
    `
      <div class="form-group">
        <label>${t('password')}</label>
        <input type="password" id="admin-switch-pwd" placeholder="${t('enterPassword')}" autofocus />
      </div>
    `,
    `
      <button class="btn btn-secondary btn-sm" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-primary btn-sm" id="confirm-admin-switch-btn">${t('login')}</button>
    `
  );

  document.getElementById('confirm-admin-switch-btn').onclick = () => {
    const pwd = document.getElementById('admin-switch-pwd').value;
    if (pwd === db.settings.adminPassword) {
      state.role = 'admin';
      state.activePage = 'products';
      storage.set(SESSION_KEY, state);
      closeModal();
      showToast(t('loginAsAdmin'), 'success');
      refreshUI();
    } else {
      showToast(t('invalidCredentials'), 'error');
    }
  };
}

/* ----------------------------------------------------------------------------
   8. First-Time Setup & Authentication
   ---------------------------------------------------------------------------- */
function renderFirstTimeSetup() {
  headerMeta.style.display = 'none';
  menuBtn.style.display = 'none';
  drawer.classList.remove('visible');
  drawerBackdrop.classList.remove('active');
  pageTitleEl.textContent = t('appName');

  mainContent.innerHTML = `
    <div class="login-container" style="max-width: 500px;">
      <div class="login-card" style="text-align: left;">
        <div style="text-align: center; margin-bottom: 1.25rem;">
          <div style="font-size: 2.8rem; margin-bottom: 0.35rem;">🏪</div>
          <h2 class="login-title">${t('welcomeTitle')}</h2>
          <p style="color: var(--text-muted); font-size: 0.88rem; margin: 0;">
            ${t('setupSubtitle')}
          </p>
        </div>

        <form id="onboarding-setup-form">
          <div class="form-group">
            <label>${t('setupBusinessName')} *</label>
            <input type="text" id="setup-company-name" required placeholder="e.g. Kigali Fresh Supplies Ltd" autofocus />
          </div>

          <div class="form-group">
            <label>${t('setupBranchName')} *</label>
            <input type="text" id="setup-branch-name" required value="Main Branch" placeholder="e.g. Main Branch, Downtown Outlet" />
          </div>

          <div class="form-grid">
            <div class="form-group">
              <label>${t('setupAdminPassword')} *</label>
              <input type="password" id="setup-admin-pwd" required placeholder="Enter password" autocomplete="new-password" />
            </div>

            <div class="form-group">
              <label>${t('setupEmployeePassword')} *</label>
              <input type="password" id="setup-emp-pwd" required placeholder="Enter password" autocomplete="new-password" />
            </div>
          </div>

          <div class="form-group">
            <label>${t('language')}</label>
            <select id="setup-lang-select">
              <option value="en" ${currentLang === 'en' ? 'selected' : ''}>English</option>
              <option value="rw" ${currentLang === 'rw' ? 'selected' : ''}>Kinyarwanda</option>
              <option value="fr" ${currentLang === 'fr' ? 'selected' : ''}>Français</option>
            </select>
          </div>

          <button type="submit" class="btn btn-primary" style="width: 100%; padding: 0.85rem; font-size: 1rem; margin-top: 0.75rem;">
            🚀 ${t('setupSubmit')}
          </button>
        </form>

        <div style="margin-top: 1.25rem; text-align: center; font-size: 0.8rem; color: var(--text-muted); border-top: 1px solid var(--border-light); padding-top: 0.75rem;">
          🔒 Private & Offline: All business records stay 100% on this device.
        </div>
      </div>
    </div>
  `;

  document.getElementById('setup-lang-select').onchange = (e) => {
    applyLang(e.target.value);
    renderFirstTimeSetup();
  };

  document.getElementById('onboarding-setup-form').onsubmit = (e) => {
    e.preventDefault();
    const company = document.getElementById('setup-company-name').value.trim();
    const branch = document.getElementById('setup-branch-name').value.trim();
    const adminPwd = document.getElementById('setup-admin-pwd').value.trim();
    const empPwd = document.getElementById('setup-emp-pwd').value.trim();

    if (!company || !branch || !adminPwd || !empPwd) {
      showToast('Please fill in all setup fields', 'error');
      return;
    }

    db = getBlankDatabase(company, branch, adminPwd, empPwd);
    saveDB();
    showToast(`${company} initialized successfully!`, 'success');
    setTimeout(() => showToast('💡 Tip: Enable Cloud Sync in Settings so the owner can access data from any device.', 'info'), 2500);
    renderLogin('admin');
  };
}

function renderLogin(selectedRole = 'admin') {
  headerMeta.style.display = 'none';
  menuBtn.style.display = 'none';
  drawer.classList.remove('visible');
  drawerBackdrop.classList.remove('active');
  pageTitleEl.textContent = t('appName');

  let currentBranch = getActiveBranch();

  function renderLoginFormContent() {
    currentBranch = getActiveBranch();
    const branchEmployees = currentBranch.employees && currentBranch.employees.length > 0 ? 
      currentBranch.employees : 
      [{ id: 'emp-1', name: 'Cashier 1', pin: currentBranch.employeePassword || '1234' }];

    mainContent.innerHTML = `
      <div class="login-container">
        <div class="login-card">
          <div class="login-logo">🏪</div>
          <h2 class="login-title">${escapeHtml(db.settings.companyName || 'Shop Control')}</h2>
          <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 1.25rem;">
            ${escapeHtml(currentBranch.name)}
          </p>

          <!-- Role Selector / Label display -->
          <div class="login-role-selector">
            <button type="button" class="login-role-btn ${selectedRole === 'admin' ? 'active' : ''}" id="login-role-admin">
              👑 ${t('admin')}
            </button>
            <button type="button" class="login-role-btn ${selectedRole === 'employee' ? 'active' : ''}" id="login-role-emp">
              💼 ${t('employee')}
            </button>
          </div>

          <form id="login-form">
            <div class="form-group" style="text-align: left;">
              <label>${t('role')}: <strong>${selectedRole === 'admin' ? t('admin') : t('employee')}</strong></label>
            </div>

            <!-- Branch Selector if multiple branches exist -->
            ${db.settings.branches.length > 1 ? `
              <div class="form-group" style="text-align: left;">
                <label>${t('branch')}</label>
                <select id="login-branch-select">
                  ${db.settings.branches.map(b => `
                    <option value="${b.id}" ${b.id === state.branchId ? 'selected' : ''}>${escapeHtml(b.name)}</option>
                  `).join('')}
                </select>
              </div>
            ` : ''}

            <!-- Employee selection when role is Employee -->
            ${selectedRole === 'employee' ? `
              <div class="form-group" style="text-align: left;">
                <label>${t('selectSeller')}</label>
                <select id="login-seller-select" required>
                  ${branchEmployees.map(emp => `
                    <option value="${emp.id}">${escapeHtml(emp.name)}</option>
                  `).join('')}
                </select>
              </div>
            ` : ''}

            <!-- Language Selector right on Login page -->
            <div class="form-group" style="text-align: left;">
              <label>${t('language')}</label>
              <select id="login-lang-select">
                <option value="en" ${currentLang === 'en' ? 'selected' : ''}>English</option>
                <option value="rw" ${currentLang === 'rw' ? 'selected' : ''}>Kinyarwanda</option>
                <option value="fr" ${currentLang === 'fr' ? 'selected' : ''}>Français</option>
              </select>
            </div>

            <div class="form-group" style="text-align: left;">
              <label>${selectedRole === 'admin' ? t('password') : t('sellerPIN')}</label>
              <input type="password" id="login-pwd" required placeholder="${selectedRole === 'admin' ? t('enterPassword') : t('enterPIN')}" autocomplete="current-password" autofocus ${selectedRole === 'employee' ? 'inputmode="numeric"' : ''} />
            </div>

            <button type="submit" class="btn btn-primary" style="width: 100%; margin-top: 0.5rem;">
              ${t('login')}
            </button>
          </form>
        </div>
      </div>
    `;

    document.getElementById('login-role-admin').onclick = () => {
      selectedRole = 'admin';
      renderLoginFormContent();
    };
    document.getElementById('login-role-emp').onclick = () => {
      selectedRole = 'employee';
      renderLoginFormContent();
    };

    const branchSel = document.getElementById('login-branch-select');
    if (branchSel) {
      branchSel.onchange = (e) => {
        state.branchId = e.target.value;
        const b = db.settings.branches.find(x => x.id === state.branchId);
        if (b) state.branchName = b.name;
        renderLoginFormContent();
      };
    }

    document.getElementById('login-lang-select').onchange = (e) => {
      applyLang(e.target.value);
    };

    document.getElementById('login-form').onsubmit = (e) => {
      e.preventDefault();
      const pwd = document.getElementById('login-pwd').value.trim();

      if (selectedRole === 'admin') {
        if (pwd === db.settings.adminPassword) {
          state.role = 'admin';
          state.employeeId = 'admin';
          state.employeeName = 'Admin';
          state.loggedIn = true;
          state.activePage = 'products';
          storage.set(SESSION_KEY, state);
          showToast(`${t('login')}: ${t('admin')}`, 'success');
          refreshUI();
        } else {
          showToast(t('invalidCredentials'), 'error');
        }
      } else {
        // Employee login: match against selected employee PIN or branch employee password
        const sellerSel = document.getElementById('login-seller-select');
        const selectedEmpId = sellerSel ? sellerSel.value : '';
        const selectedEmp = branchEmployees.find(x => x.id === selectedEmpId) || branchEmployees[0];

        if (pwd === selectedEmp.pin || pwd === currentBranch.employeePassword) {
          state.role = 'employee';
          state.employeeId = selectedEmp.id;
          state.employeeName = selectedEmp.name;
          state.loggedIn = true;
          state.activePage = 'sales';
          storage.set(SESSION_KEY, state);
          showToast(`${t('login')}: ${selectedEmp.name}`, 'success');
          refreshUI();
        } else {
          showToast(t('invalidCredentials'), 'error');
        }
      }
    };
  }

  renderLoginFormContent();
}

/* ----------------------------------------------------------------------------
   9. Navigation Menu Setup
   ---------------------------------------------------------------------------- */
function setupDrawerMenu() {
  menuBtn.style.display = 'inline-flex';
  headerMeta.style.display = 'flex';
  
  const currentBranch = getActiveBranch();
  headerBranch.textContent = currentBranch.name;
  headerRole.textContent = state.role === 'admin' ? t('admin') : `${t('employee')} • ${state.employeeName || 'Staff'}`;
  headerRole.className = `badge-role ${state.role}`;

  document.getElementById('drawer-company').textContent = db.settings.companyName;
  document.getElementById('drawer-branch-info').textContent = state.role === 'admin' ? 
    `${currentBranch.name} • ${t('admin')}` : 
    `${currentBranch.name} • ${state.employeeName || 'Staff'}`;

  menuList.innerHTML = '';

  const adminMenu = [
    { id: 'products', icon: '📦', label: t('menuProducts') },
    { id: 'customers', icon: '👥', label: t('menuCustomers') },
    { id: 'shop-control', icon: '📊', label: t('menuShopControl') },
    { id: 'purchases', icon: '🛒', label: t('menuPurchases') },
    { id: 'suppliers', icon: '🚚', label: t('menuSuppliers') },
    { id: 'others', icon: '📑', label: t('menuOthers') },
    { id: 'notifications', icon: '🔔', label: t('menuNotifications'), badge: getAdminNotificationsCount() },
    { id: 'settings', icon: '⚙️', label: t('menuSettings') }
  ];

  const employeeMenu = [
    { id: 'products', icon: '📦', label: t('menuProducts') },
    { id: 'sales', icon: '🏷️', label: t('menuSales') },
    { id: 'customers', icon: '👥', label: t('menuCustomers') },
    { id: 'purchases', icon: '💸', label: t('menuPurchases') }, // employee expenses
    { id: 'notifications', icon: '🔔', label: t('menuNotifications'), badge: getEmployeeNotificationsCount() }
  ];

  const activeMenuList = state.role === 'admin' ? adminMenu : employeeMenu;

  activeMenuList.forEach(item => {
    const li = document.createElement('li');
    li.className = `menu-item ${state.activePage === item.id ? 'active' : ''}`;
    li.innerHTML = `
      <div class="menu-item-left">
        <span class="menu-icon">${item.icon}</span>
        <span>${escapeHtml(item.label)}</span>
      </div>
      ${item.badge > 0 ? `<span class="tab-badge" style="background: var(--danger); color: #fff;">${item.badge}</span>` : ''}
    `;
    li.onclick = () => {
      loadPage(item.id);
      toggleDrawer(false);
    };
    menuList.appendChild(li);
  });

  // Drawer Footer
  drawerFooter.innerHTML = '';
  if (state.role === 'admin') {
    const switchEmpBtn = document.createElement('button');
    switchEmpBtn.className = 'btn btn-secondary btn-sm';
    switchEmpBtn.innerHTML = `🔄 ${t('loginAsEmployee')}`;
    switchEmpBtn.onclick = () => {
      state.role = 'employee';
      state.activePage = 'sales';
      storage.set(SESSION_KEY, state);
      toggleDrawer(false);
      showToast(`${t('loginAsEmployee')} (${currentBranch.name})`, 'info');
      refreshUI();
    };
    drawerFooter.appendChild(switchEmpBtn);
  }

  const logoutActionBtn = document.createElement('button');
  logoutActionBtn.className = 'btn btn-danger btn-sm';
  logoutActionBtn.innerHTML = `🚪 ${t('logout')}`;
  logoutActionBtn.onclick = () => {
    state.loggedIn = false;
    storage.set(SESSION_KEY, state);
    toggleDrawer(false);
    renderLogin();
  };
  drawerFooter.appendChild(logoutActionBtn);
}

function getAdminNotificationsCount() {
  const pendingRequests = (db.extensionRequests || []).filter(r => r.branchId === state.branchId && r.status === 'Waiting').length;
  const lowStockCount = (db.products || []).filter(p => p.branchId === state.branchId && p.stock <= (p.minStockAlert !== undefined ? p.minStockAlert : 5)).length;
  return pendingRequests + lowStockCount;
}

function getEmployeeNotificationsCount() {
  const today = getTodayStr();
  // Reminders due today
  const dueToday = db.customers.filter(c => {
    if (c.branchId !== state.branchId) return false;
    const debt = getCustomerDebt(c.id);
    return debt.remaining > 0 && c.newPromisedDate <= today;
  }).length;
  return dueToday;
}

function loadPage(pageId) {
  state.activePage = pageId;
  storage.set(SESSION_KEY, state);
  setupDrawerMenu();

  if (state.role === 'admin') {
    switch (pageId) {
      case 'products': renderAdminProducts(); break;
      case 'customers': renderAdminCustomers(); break;
      case 'shop-control': renderAdminShopControl(); break;
      case 'purchases': renderAdminPurchases(); break;
      case 'suppliers': renderAdminSuppliers(); break;
      case 'others': renderAdminOthers(); break;
      case 'notifications': renderAdminNotifications(); break;
      case 'settings': renderAdminSettings(); break;
      default: renderAdminProducts(); break;
    }
  } else {
    switch (pageId) {
      case 'products': renderEmployeeProducts(); break;
      case 'sales': renderEmployeeSales(); break;
      case 'customers': renderEmployeeCustomers(); break;
      case 'purchases': renderEmployeePurchases(); break;
      case 'notifications': renderEmployeeNotifications(); break;
      default: renderEmployeeSales(); break;
    }
  }
}

function refreshUI() {
  if (!state.loggedIn) {
    renderLogin();
  } else {
    loadPage(state.activePage);
  }
}

/* ============================================================================
   ADMIN SIDE IMPLEMENTATION
   ============================================================================ */

/* ----------------------------------------------------------------------------
   Admin 3. Products
   Registered: name, version, purchase date, supplier, stock with unit, cost -> selling price, Action: Delete.
   Not yet registered: name, purchase date, supplier, quantity, unit cost. Action: open in Add product, Delete.
   Add product: choose one purchased item, selling price, version (only if name already exists), batch (if name & version exist).
   Auto-filled & locked: name, unit, quantity, cost price.
   ---------------------------------------------------------------------------- */
function renderAdminProducts(activeTab = 'registered') {
  pageTitleEl.textContent = t('menuProducts');

  const allProducts = db.products.filter(p => p.branchId === state.branchId);
  const lowStockProducts = allProducts.filter(p => p.stock > 0 && p.stock <= (p.minStockAlert !== undefined ? p.minStockAlert : 5));
  const outOfStockProducts = allProducts.filter(p => p.stock <= 0);
  const unregisteredPurchases = db.purchases.filter(p => p.branchId === state.branchId && !p.registered);

  let displayedProducts = allProducts;
  if (activeTab === 'low_stock') {
    displayedProducts = lowStockProducts;
  } else if (activeTab === 'out_of_stock') {
    displayedProducts = outOfStockProducts;
  }

  mainContent.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">📦 ${t('menuProducts')}</h2>
        <div class="page-subtitle">${escapeHtml(getActiveBranch().name)}</div>
      </div>
      <div>
        <button class="btn btn-primary" id="btn-open-add-product">
          + ${t('addProduct')}
        </button>
      </div>
    </div>

    <!-- Tabs: Registered / Low Stock / Out of Stock / Not yet registered -->
    <div class="tabs">
      <button class="tab-btn ${activeTab === 'registered' ? 'active' : ''}" id="tab-registered">
        ${t('registeredTab')} <span class="tab-badge">${allProducts.length}</span>
      </button>
      <button class="tab-btn ${activeTab === 'low_stock' ? 'active' : ''}" id="tab-low-stock">
        ⚠️ ${t('lowStockTab')} <span class="tab-badge" style="background: var(--accent); color: #fff;">${lowStockProducts.length}</span>
      </button>
      <button class="tab-btn ${activeTab === 'out_of_stock' ? 'active' : ''}" id="tab-out-of-stock">
        ❌ ${t('outOfStockTab')} <span class="tab-badge" style="background: var(--danger); color: #fff;">${outOfStockProducts.length}</span>
      </button>
      <button class="tab-btn ${activeTab === 'unregistered' ? 'active' : ''}" id="tab-unregistered">
        ${t('notYetRegisteredTab')} <span class="tab-badge">${unregisteredPurchases.length}</span>
      </button>
    </div>

    <div id="products-content-area">
      ${activeTab === 'unregistered' ? 
        getAdminUnregisteredPurchasesHtml(unregisteredPurchases) : 
        getAdminRegisteredProductsHtml(displayedProducts)
      }
    </div>
  `;

  document.getElementById('tab-registered').onclick = () => renderAdminProducts('registered');
  document.getElementById('tab-low-stock').onclick = () => renderAdminProducts('low_stock');
  document.getElementById('tab-out-of-stock').onclick = () => renderAdminProducts('out_of_stock');
  document.getElementById('tab-unregistered').onclick = () => renderAdminProducts('unregistered');
  document.getElementById('btn-open-add-product').onclick = () => openAddProductModal();

  attachAdminProductActions();
}

function getAdminRegisteredProductsHtml(products) {
  if (products.length === 0) {
    return `<div class="card"><p style="color: var(--text-muted); text-align: center; margin: 1.5rem 0;">No products match the selected view.</p></div>`;
  }

  return `
    <div class="card">
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('productName')}</th>
              <th>${t('purchaseDate')}</th>
              <th>${t('supplier')}</th>
              <th>${t('stock')}</th>
              <th>${t('costToSellPrice')}</th>
              <th style="text-align: right;">${t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            ${products.map(p => {
              const displayName = p.name + (p.version ? ` (${p.version})` : '') + (p.batch ? ` [${p.batch}]` : '');
              const minAlert = p.minStockAlert !== undefined ? p.minStockAlert : 5;
              let stockBadge = '';
              if (p.stock <= 0) {
                stockBadge = `<span class="status-pill status-out-of-stock">❌ ${t('outOfStock')} (0 ${escapeHtml(p.unit)})</span>`;
              } else if (p.stock <= minAlert) {
                stockBadge = `<span class="status-pill status-low-stock">⚠️ ${t('lowStock')} (${p.stock} ${escapeHtml(p.unit)})</span>`;
              } else {
                stockBadge = `<span class="status-pill status-paid">✅ ${p.stock} ${escapeHtml(p.unit)}</span>`;
              }

              return `
                <tr>
                  <td><strong>${escapeHtml(displayName)}</strong></td>
                  <td>${escapeHtml(p.purchaseDate || '-')}</td>
                  <td>${escapeHtml(p.supplierName || '-')}</td>
                  <td>${stockBadge}</td>
                  <td>
                    <span style="color: var(--text-muted);">${fmtMoney(p.costPrice)}</span>
                    <strong style="color: var(--primary);"> → ${fmtMoney(p.sellingPrice)}</strong>
                  </td>
                  <td style="text-align: right;">
                    <button class="btn btn-danger btn-sm btn-delete-product" data-id="${p.id}" title="${t('delete')}">
                      🗑️ ${t('delete')}
                    </button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function getAdminUnregisteredPurchasesHtml(purchases) {
  if (purchases.length === 0) {
    return `<div class="card"><p style="color: var(--text-muted); text-align: center; margin: 1.5rem 0;">All purchases have been registered into inventory.</p></div>`;
  }

  return `
    <div class="card">
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('productName')}</th>
              <th>${t('purchaseDate')}</th>
              <th>${t('supplier')}</th>
              <th>${t('quantity')}</th>
              <th>${t('unitCost')}</th>
              <th style="text-align: right;">${t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            ${purchases.map(p => `
              <tr>
                <td><strong>${escapeHtml(p.itemName)}</strong></td>
                <td>${escapeHtml(p.purchaseDate || '-')}</td>
                <td>${escapeHtml(p.supplierName || '-')}</td>
                <td><strong>${p.quantity} ${escapeHtml(p.unit)}</strong></td>
                <td>${fmtMoney(p.unitCost)}</td>
                <td style="text-align: right;">
                  <div class="actions-cell" style="justify-content: flex-end;">
                    <button class="btn btn-primary btn-sm btn-register-purchase" data-id="${p.id}">
                      ➕ ${t('addProduct')}
                    </button>
                    <button class="btn btn-danger btn-sm btn-delete-unreg-purchase" data-id="${p.id}">
                      🗑️ ${t('delete')}
                    </button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function attachAdminProductActions() {
  document.querySelectorAll('.btn-register-purchase').forEach(btn => {
    btn.onclick = () => openAddProductModal(btn.dataset.id);
  });

  document.querySelectorAll('.btn-delete-unreg-purchase').forEach(btn => {
    btn.onclick = () => {
      const pid = btn.dataset.id;
      if (confirm('Delete this unregistered purchase record?')) {
        db.purchases = db.purchases.filter(p => p.id !== pid);
        saveDB();
        showToast('Purchase deleted', 'info');
        renderAdminProducts('unregistered');
      }
    };
  });

  document.querySelectorAll('.btn-delete-product').forEach(btn => {
    btn.onclick = () => {
      const pid = btn.dataset.id;
      const prod = db.products.find(p => p.id === pid);
      if (!prod) return;

      if (confirm(`Delete registered product "${prod.name}" from inventory?`)) {
        db.products = db.products.filter(p => p.id !== pid);
        const originalPur = db.purchases.find(p => p.id === prod.purchaseId);
        if (originalPur) {
          originalPur.registered = false;
          delete originalPur.registeredProductId;
        }
        saveDB();
        showToast('Product deleted from inventory', 'info');
        renderAdminProducts('registered');
      }
    };
  });
}

function openAddProductModal(selectedPurchaseId = '') {
  const unregisteredPurchases = db.purchases.filter(p => p.branchId === state.branchId && !p.registered);

  if (unregisteredPurchases.length === 0) {
    showToast('No unregistered purchases available. Record a purchase first!', 'warning');
    return;
  }

  const selectedPurchase = unregisteredPurchases.find(p => p.id === selectedPurchaseId) || unregisteredPurchases[0];

  const modalHtml = `
    <form id="add-product-form">
      <!-- 1. Choose purchased item -->
      <div class="form-group">
        <label>${t('choosePurchasedItem')}</label>
        <select id="modal-purchase-select" required>
          ${unregisteredPurchases.map(p => `
            <option value="${p.id}" ${p.id === selectedPurchase.id ? 'selected' : ''}>
              ${escapeHtml(p.itemName)} (${p.quantity} ${escapeHtml(p.unit)} @ ${fmtMoney(p.unitCost)}) - ${escapeHtml(p.supplierName)}
            </option>
          `).join('')}
        </select>
      </div>

      <!-- Auto-filled and locked fields -->
      <div class="form-grid">
        <div class="form-group">
          <label>${t('productName')} <span class="hint">(${t('autoFilledLocked')})</span></label>
          <input type="text" id="modal-p-name" value="${escapeHtml(selectedPurchase.itemName)}" readonly />
        </div>
        <div class="form-group">
          <label>${t('unit')} <span class="hint">(${t('autoFilledLocked')})</span></label>
          <input type="text" id="modal-p-unit" value="${escapeHtml(selectedPurchase.unit)}" readonly />
        </div>
        <div class="form-group">
          <label>${t('quantity')} <span class="hint">(${t('autoFilledLocked')})</span></label>
          <input type="number" id="modal-p-qty" value="${selectedPurchase.quantity}" readonly />
        </div>
        <div class="form-group">
          <label>${t('unitCost')} <span class="hint">(${t('autoFilledLocked')})</span></label>
          <input type="text" id="modal-p-cost" value="${selectedPurchase.unitCost}" readonly />
        </div>
      </div>

      <!-- Dynamic Version & Batch Choice -->
      <div id="dynamic-version-batch-container">
        <!-- Injected dynamically based on existing products -->
      </div>

      <!-- Selling Price & Low Stock Threshold Alert -->
      <div class="form-grid">
        <div class="form-group">
          <label>${t('sellingPrice')} (RWF) *</label>
          <input type="number" id="modal-p-selling-price" min="1" required placeholder="e.g. 3500" />
        </div>
        <div class="form-group">
          <label>${t('minStockAlert')} *</label>
          <input type="number" id="modal-p-min-alert" min="0" value="5" required placeholder="5" />
        </div>
      </div>
    </form>
  `;

  const footerHtml = `
    <button type="button" class="btn btn-secondary btn-sm" onclick="closeModal()">${t('cancel')}</button>
    <button type="submit" form="add-product-form" class="btn btn-primary btn-sm">${t('save')}</button>
  `;

  openModal(t('addProduct'), modalHtml, footerHtml);

  const purchaseSelect = document.getElementById('modal-purchase-select');
  const nameInput = document.getElementById('modal-p-name');
  const unitInput = document.getElementById('modal-p-unit');
  const qtyInput = document.getElementById('modal-p-qty');
  const costInput = document.getElementById('modal-p-cost');

  function updateDynamicFields() {
    const pur = unregisteredPurchases.find(p => p.id === purchaseSelect.value);
    if (!pur) return;

    nameInput.value = pur.itemName;
    unitInput.value = pur.unit;
    qtyInput.value = pur.quantity;
    costInput.value = pur.unitCost;

    const container = document.getElementById('dynamic-version-batch-container');
    const existingSameName = db.products.filter(p => p.branchId === state.branchId && p.name.toLowerCase() === pur.itemName.toLowerCase());

    if (existingSameName.length > 0) {
      container.innerHTML = `
        <div class="form-group">
          <label>${t('version')} * <span class="hint">(${t('versionHint')})</span></label>
          <input type="text" id="modal-p-version" required placeholder="e.g. Grade 1, 1L Bottle, Special..." />
        </div>
        <div id="dynamic-batch-container"></div>
      `;

      const versionInput = document.getElementById('modal-p-version');
      versionInput.oninput = () => {
        const vVal = versionInput.value.trim().toLowerCase();
        const batchContainer = document.getElementById('dynamic-batch-container');
        const existingSameNameAndVer = existingSameName.filter(p => (p.version || '').toLowerCase() === vVal && vVal.length > 0);

        if (existingSameNameAndVer.length > 0) {
          batchContainer.innerHTML = `
            <div class="form-group">
              <label>${t('batchChoice')} * <span class="hint">(${t('batchHint')})</span></label>
              <input type="text" id="modal-p-batch" required placeholder="e.g. Batch 2026-B, Lot 3..." />
            </div>
          `;
        } else {
          batchContainer.innerHTML = '';
        }
      };
    } else {
      container.innerHTML = '';
    }
  }

  purchaseSelect.onchange = updateDynamicFields;
  updateDynamicFields();

  document.getElementById('add-product-form').onsubmit = (e) => {
    e.preventDefault();
    const pur = unregisteredPurchases.find(p => p.id === purchaseSelect.value);
    if (!pur) return;

    const sellingPrice = parseFloat(document.getElementById('modal-p-selling-price').value);
    if (isNaN(sellingPrice) || sellingPrice <= 0) {
      showToast('Please enter a valid selling price!', 'error');
      return;
    }

    const minStockAlert = parseFloat(document.getElementById('modal-p-min-alert').value) || 5;
    const versionInput = document.getElementById('modal-p-version');
    const batchInput = document.getElementById('modal-p-batch');

    const version = versionInput ? versionInput.value.trim() : '';
    const batch = batchInput ? batchInput.value.trim() : '';

    const newProd = {
      id: 'prod-' + Date.now(),
      branchId: state.branchId,
      purchaseId: pur.id,
      name: pur.itemName,
      version: version,
      batch: batch,
      unit: pur.unit,
      stock: pur.quantity,
      initialStock: pur.quantity,
      costPrice: pur.unitCost,
      sellingPrice: sellingPrice,
      minStockAlert: minStockAlert,
      purchaseDate: pur.purchaseDate,
      supplierName: pur.supplierName,
      dateAdded: getTodayStr()
    };

    db.products.push(newProd);

    // Mark purchase as registered
    pur.registered = true;
    pur.registeredProductId = newProd.id;

    saveDB();
    closeModal();
    showToast(t('productAddedSuccess'), 'success');
    renderAdminProducts('registered');
  };
}

/* ----------------------------------------------------------------------------
   Admin 4. Customers
   Search by name or phone.
   Tabs: All, Partially paid, Fully paid, Overdue (with counts).
   Per customer: total debt, paid, remaining, status, first & new promised date, Purchases and Payments history with date and time.
   View only.
   ---------------------------------------------------------------------------- */
function getCustomerDebt(customerId) {
  const customerSales = db.sales.filter(s => s.customerId === customerId);
  const customerPayments = db.customerPayments.filter(p => p.customerId === customerId);

  let totalDebt = 0;
  let paid = 0;

  customerSales.forEach(s => {
    totalDebt += (s.total || 0);
    paid += (s.paidNow || 0);
  });

  customerPayments.forEach(p => {
    paid += (p.amount || 0);
  });

  const remaining = Math.max(0, totalDebt - paid);
  const today = getTodayStr();

  const customer = db.customers.find(c => c.id === customerId);
  const promised = (customer && customer.newPromisedDate) || '';

  let status = 'paid';
  if (remaining > 0) {
    if (promised && promised < today) {
      status = 'overdue';
    } else {
      status = 'partial';
    }
  }

  return { totalDebt, paid, remaining, status };
}

function renderAdminCustomers(activeTab = 'all', searchQuery = '') {
  pageTitleEl.textContent = t('menuCustomers');

  const branchCustomers = db.customers.filter(c => c.branchId === state.branchId);

  // Tab counts
  let counts = { all: branchCustomers.length, partial: 0, paid: 0, overdue: 0 };
  const customerDebtMap = {};

  branchCustomers.forEach(c => {
    const debt = getCustomerDebt(c.id);
    customerDebtMap[c.id] = debt;
    if (debt.status === 'paid') counts.paid++;
    else if (debt.status === 'overdue') counts.overdue++;
    else if (debt.status === 'partial') counts.partial++;
  });

  // Filter by Tab & Search
  const filteredCustomers = branchCustomers.filter(c => {
    const debt = customerDebtMap[c.id];
    if (activeTab === 'partial' && debt.status !== 'partial') return false;
    if (activeTab === 'paid' && debt.status !== 'paid') return false;
    if (activeTab === 'overdue' && debt.status !== 'overdue') return false;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchName = c.name.toLowerCase().includes(q);
      const matchPhone = (c.phone || '').includes(q);
      return matchName || matchPhone;
    }
    return true;
  });

  mainContent.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">👥 ${t('menuCustomers')}</h2>
        <div class="page-subtitle">${t('viewOnly')}</div>
      </div>
    </div>

    <!-- Search bar -->
    <div class="search-bar">
      <div class="search-input-wrapper">
        <span class="search-icon">🔍</span>
        <input type="text" id="cust-search-input" value="${escapeHtml(searchQuery)}" placeholder="${t('search')} (name, phone)" />
      </div>
    </div>

    <!-- Tabs with counts -->
    <div class="tabs">
      <button class="tab-btn ${activeTab === 'all' ? 'active' : ''}" id="tab-cust-all">
        ${t('all')} <span class="tab-badge">${counts.all}</span>
      </button>
      <button class="tab-btn ${activeTab === 'partial' ? 'active' : ''}" id="tab-cust-partial">
        ${t('partiallyPaid')} <span class="tab-badge">${counts.partial}</span>
      </button>
      <button class="tab-btn ${activeTab === 'paid' ? 'active' : ''}" id="tab-cust-paid">
        ${t('fullyPaid')} <span class="tab-badge">${counts.paid}</span>
      </button>
      <button class="tab-btn ${activeTab === 'overdue' ? 'active' : ''}" id="tab-cust-overdue">
        ${t('overdue')} <span class="tab-badge">${counts.overdue}</span>
      </button>
    </div>

    <!-- Customers List & Details -->
    <div class="card">
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('customer')}</th>
              <th>${t('status')}</th>
              <th>${t('totalDebt')}</th>
              <th>${t('paid')}</th>
              <th>${t('remaining')}</th>
              <th>${t('firstPromisedDate')}</th>
              <th>${t('newPromisedDate')}</th>
              <th style="text-align: right;">${t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            ${filteredCustomers.length === 0 ? `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">${t('search')} - No customers found.</td></tr>` : ''}
            ${filteredCustomers.map(c => {
              const d = customerDebtMap[c.id];
              let statusClass = 'status-paid';
              let statusLabel = t('fullyPaid');
              if (d.status === 'overdue') {
                statusClass = 'status-overdue';
                statusLabel = t('overdue');
              } else if (d.status === 'partial') {
                statusClass = 'status-partial';
                statusLabel = t('partiallyPaid');
              }

              return `
                <tr>
                  <td>
                    <strong>${escapeHtml(c.name)}</strong>
                    <div style="font-size: 0.78rem; color: var(--text-muted);">${escapeHtml(c.phone || '-')}</div>
                  </td>
                  <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
                  <td>${fmtMoney(d.totalDebt)}</td>
                  <td><span style="color: var(--success);">${fmtMoney(d.paid)}</span></td>
                  <td><strong style="color: ${d.remaining > 0 ? 'var(--danger)' : 'inherit'};">${fmtMoney(d.remaining)}</strong></td>
                  <td>${escapeHtml(c.firstPromisedDate || '-')}</td>
                  <td><strong>${escapeHtml(c.newPromisedDate || '-')}</strong></td>
                  <td style="text-align: right;">
                    <button class="btn btn-secondary btn-sm btn-view-cust-history" data-id="${c.id}">
                      👁️ History
                    </button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('tab-cust-all').onclick = () => renderAdminCustomers('all', searchQuery);
  document.getElementById('tab-cust-partial').onclick = () => renderAdminCustomers('partial', searchQuery);
  document.getElementById('tab-cust-paid').onclick = () => renderAdminCustomers('paid', searchQuery);
  document.getElementById('tab-cust-overdue').onclick = () => renderAdminCustomers('overdue', searchQuery);

  const searchInput = document.getElementById('cust-search-input');
  searchInput.oninput = (e) => {
    renderAdminCustomers(activeTab, e.target.value);
  };

  document.querySelectorAll('.btn-view-cust-history').forEach(btn => {
    btn.onclick = () => {
      openCustomerHistoryModal(btn.dataset.id);
    };
  });
}

function openCustomerHistoryModal(customerId) {
  const customer = db.customers.find(c => c.id === customerId);
  if (!customer) return;

  const sales = db.sales.filter(s => s.customerId === customerId);
  const payments = db.customerPayments.filter(p => p.customerId === customerId);
  const debt = getCustomerDebt(customerId);

  const bodyHtml = `
    <div style="margin-bottom: 1rem; padding: 0.75rem; background: var(--bg-subtle); border-radius: var(--radius-md);">
      <h4 style="margin: 0 0 0.35rem 0;">${escapeHtml(customer.name)} (${escapeHtml(customer.phone)})</h4>
      <div style="display: flex; gap: 1rem; font-size: 0.85rem; flex-wrap: wrap;">
        <div>${t('totalDebt')}: <strong>${fmtMoney(debt.totalDebt)}</strong></div>
        <div>${t('paid')}: <strong style="color: var(--success);">${fmtMoney(debt.paid)}</strong></div>
        <div>${t('remaining')}: <strong style="color: var(--danger);">${fmtMoney(debt.remaining)}</strong></div>
        <div>${t('firstPromisedDate')}: <strong>${escapeHtml(customer.firstPromisedDate || '-')}</strong></div>
        <div>${t('newPromisedDate')}: <strong>${escapeHtml(customer.newPromisedDate || '-')}</strong></div>
      </div>
    </div>

    <!-- Purchases History with date and time -->
    <h5 style="margin: 1rem 0 0.5rem 0;">🛒 ${t('purchasesHistory')}</h5>
    <div class="table-responsive" style="margin-bottom: 1.25rem;">
      <table class="table">
        <thead>
          <tr>
            <th>${t('date')} & ${t('time')}</th>
            <th>Items</th>
            <th>${t('grandTotal')}</th>
            <th>${t('paidNow')}</th>
            <th>${t('remaining')}</th>
            <th>Status / Action</th>
          </tr>
        </thead>
        <tbody>
          ${sales.length === 0 ? `<tr><td colspan="6" style="color: var(--text-muted); text-align: center;">No purchases</td></tr>` : ''}
          ${sales.map(s => `
            <tr style="${s.isVoided ? 'opacity: 0.65; background: var(--bg-subtle);' : ''}">
              <td>
                <div>${escapeHtml(s.saleDate)}</div>
                <small style="color: var(--text-muted);">${escapeHtml(s.saleTime || '')}</small>
              </td>
              <td>
                <small>${(s.items || []).map(i => `${escapeHtml(i.productName)} (${i.quantity} ${escapeHtml(i.unit || '')})`).join(', ')}</small>
              </td>
              <td>${fmtMoney(s.total)}</td>
              <td><span style="color: var(--success); font-weight: 700;">${fmtMoney(s.paidNow)}</span></td>
              <td><span style="color: ${s.remainingDebt > 0 ? 'var(--danger)' : 'inherit'};">${fmtMoney(s.remainingDebt)}</span></td>
              <td>
                ${s.isVoided ? 
                  `<span class="status-pill status-voided">${t('voided')}</span>` : 
                  `<button class="btn btn-danger btn-sm btn-void-sale-modal" data-id="${s.id}">🔄 ${t('voidSale')}</button>`
                }
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <!-- Payments History with date and time -->
    <h5 style="margin: 1rem 0 0.5rem 0;">💳 ${t('paymentsHistory')}</h5>
    <div class="table-responsive">
      <table class="table">
        <thead>
          <tr>
            <th>${t('date')} & ${t('time')}</th>
            <th>${t('amount')}</th>
            <th>${t('paymentChannel')}</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${payments.length === 0 ? `<tr><td colspan="4" style="color: var(--text-muted); text-align: center;">No payments recorded</td></tr>` : ''}
          ${payments.map(p => `
            <tr>
              <td>
                <div>${escapeHtml(p.date)}</div>
                <small style="color: var(--text-muted);">${escapeHtml(p.time || '')}</small>
              </td>
              <td><strong style="color: var(--success);">${fmtMoney(p.amount)}</strong></td>
              <td><span class="status-pill status-waiting">${escapeHtml(p.channel || 'Cash')}</span></td>
              <td><small>${escapeHtml(p.notes || '-')}</small></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  openModal(`${t('customer')}: ${escapeHtml(customer.name)}`, bodyHtml, `<button class="btn btn-secondary btn-sm" onclick="closeModal()">${t('close')}</button>`);
}

/* ----------------------------------------------------------------------------
   Admin 5. Shop Control (Analytics & Finances)
   Enter: Daily, Weekly or Monthly tab, or one specific past day from the calendar.
   Shows: total received, total sales, credit given, money used by employees, net cash,
   credit payments versus paid at sale, every payment mode with its amount and total,
   products sold grouped by price, expenses.
   ---------------------------------------------------------------------------- */
function openVoidSaleModal(saleId) {
  const sale = db.sales.find(s => s.id === saleId);
  if (!sale) {
    showToast('Sale record not found.', 'error');
    return;
  }
  if (sale.isVoided) {
    showToast('This sale is already cancelled/voided.', 'warning');
    return;
  }

  const modalHtml = `
    <div style="margin-bottom: 1rem;">
      <div style="background: var(--bg-subtle); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 0.85rem; margin-bottom: 1rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
          <strong>Sale #${sale.id.slice(-6)}</strong>
          <span class="status-pill status-paid">${escapeHtml(sale.saleDate)} ${escapeHtml(sale.saleTime || '')}</span>
        </div>
        <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.35rem;">
          Customer: <strong>${escapeHtml(sale.customerName || 'Walk-in')}</strong> | Sold by: <strong>${escapeHtml(sale.soldBy || 'Staff')}</strong>
        </div>
        <div style="font-size: 0.85rem; margin-bottom: 0.35rem;">
          Total: <strong>${fmtMoney(sale.total)}</strong> | Paid: <strong style="color: var(--success);">${fmtMoney(sale.paidNow)}</strong> | Credit: <strong style="color: var(--danger);">${fmtMoney(sale.remainingDebt || 0)}</strong>
        </div>
        <div style="font-size: 0.85rem; color: var(--text-muted);">
          Items: ${(sale.items || []).map(i => `${i.quantity} ${escapeHtml(i.unit || '')} ${escapeHtml(i.productName)}`).join(', ')}
        </div>
      </div>

      <div style="background: var(--accent-light); color: var(--accent-text); border-radius: var(--radius-sm); padding: 0.75rem; margin-bottom: 1rem; font-size: 0.85rem;">
        ⚠️ <strong>Notice:</strong> Cancelling this sale will immediately restore all quantities back into inventory stock, reverse any remaining credit from customer debt, exclude revenue from financial reports, and record an audit log.
      </div>

      <form id="void-sale-form">
        <div class="form-group">
          <label>${t('voidReason')} *</label>
          <select id="void-reason-select" required>
            <option value="">-- Choose Reason --</option>
            <option value="Customer returned item (Defective / Damaged)">Customer returned item (Defective / Damaged)</option>
            <option value="Customer returned item (Wrong product / Changed mind)">Customer returned item (Wrong product / Changed mind)</option>
            <option value="Cashier clerical / pricing error">Cashier clerical / pricing error</option>
            <option value="Order cancelled before dispatch">Order cancelled before dispatch</option>
            <option value="Other">Other reason (specify below)</option>
          </select>
        </div>

        <div class="form-group">
          <label>Additional Notes / Details</label>
          <textarea id="void-notes-input" rows="2" placeholder="Explain details of return or cancellation..."></textarea>
        </div>

        <div class="form-group">
          <label>${t('voidedBy')}</label>
          <input type="text" id="void-authorizer-input" value="${escapeHtml(state.employeeName || (state.role === 'admin' ? 'Admin' : 'Cashier'))}" readonly />
        </div>
      </form>
    </div>
  `;

  const footerHtml = `
    <button type="button" class="btn btn-secondary btn-sm" onclick="closeModal()">${t('cancel')}</button>
    <button type="submit" form="void-sale-form" class="btn btn-danger btn-sm">${t('voidConfirm')}</button>
  `;

  openModal(t('voidSale'), modalHtml, footerHtml);

  document.getElementById('void-sale-form').onsubmit = (e) => {
    e.preventDefault();
    const reasonSelect = document.getElementById('void-reason-select').value;
    const notes = document.getElementById('void-notes-input').value.trim();
    const finalReason = notes ? `${reasonSelect}: ${notes}` : reasonSelect;
    const authorizer = document.getElementById('void-authorizer-input').value || 'Staff';

    // 1. Mark sale as voided
    sale.isVoided = true;
    sale.voidReason = finalReason;
    sale.voidedAt = `${getTodayStr()} ${getCurrentTimeStr()}`;
    sale.voidedBy = authorizer;

    // 2. Restore stock for each item in inventory
    (sale.items || []).forEach(item => {
      const prod = db.products.find(p => p.id === item.productId);
      if (prod) {
        prod.stock = Number(prod.stock) + Number(item.quantity);
      }
    });

    // 3. Reverse customer debt if sale had unpaid credit
    if (sale.customerId && Number(sale.remainingDebt) > 0) {
      const cust = db.customers.find(c => c.id === sale.customerId);
      if (cust) {
        cust.remaining = Math.max(0, (cust.remaining || 0) - Number(sale.remainingDebt));
        cust.totalDebt = Math.max(0, (cust.totalDebt || 0) - Number(sale.remainingDebt));
        if (cust.remaining <= 0) {
          cust.status = 'paid';
        } else if (cust.paid > 0) {
          cust.status = 'partially_paid';
        }
      }
    }

    // 4. Record return audit entry in db.returns
    if (!db.returns) db.returns = [];
    db.returns.unshift({
      id: 'ret-' + Date.now(),
      saleId: sale.id,
      branchId: sale.branchId,
      date: getTodayStr(),
      time: getCurrentTimeStr(),
      items: sale.items,
      totalRefund: sale.paidNow || 0,
      paymentMethod: sale.paymentChannel || 'cash',
      reason: finalReason,
      voidedBy: authorizer,
      customerName: sale.customerName || 'Walk-in'
    });

    saveDB();
    closeModal();
    showToast(t('voidSuccess'), 'success');
    refreshUI();
  };
}

function renderAdminShopControl(activePeriod = 'daily', specificDate = '') {
  pageTitleEl.textContent = t('menuShopControl');

  const today = getTodayStr();
  let startDate = today;
  let endDate = today;

  if (activePeriod === 'daily') {
    startDate = today;
    endDate = today;
  } else if (activePeriod === 'weekly') {
    const d = new Date(Date.now() - 7 * 86400000);
    startDate = d.toISOString().split('T')[0];
    endDate = today;
  } else if (activePeriod === 'monthly') {
    const d = new Date(Date.now() - 30 * 86400000);
    startDate = d.toISOString().split('T')[0];
    endDate = today;
  } else if (activePeriod === 'specific') {
    startDate = specificDate || today;
    endDate = specificDate || today;
  }

  // Filter Sales in Period for current branch
  const branchSales = db.sales.filter(s => {
    if (s.branchId !== state.branchId) return false;
    return s.saleDate >= startDate && s.saleDate <= endDate;
  });

  const validSales = branchSales.filter(s => !s.isVoided);
  const voidedSales = branchSales.filter(s => s.isVoided);

  // Filter Customer Payments in Period
  const branchCustomerPayments = db.customerPayments.filter(p => {
    if (p.branchId !== state.branchId) return false;
    return p.date >= startDate && p.date <= endDate;
  });

  // Filter Employee Expenses in Period
  const branchExpenses = db.employeeExpenses.filter(e => {
    if (e.branchId !== state.branchId) return false;
    return e.date >= startDate && e.date <= endDate;
  });

  // 1. P&L Financial Metrics Calculation
  let grossSalesRevenue = 0;
  let cogs = 0;
  let paidAtSale = 0;
  let creditGiven = 0;

  const paymentModes = { Cash: 0, MoMo: 0, 'Bank Transfer': 0, Card: 0 };
  const groupedProducts = {};

  validSales.forEach(s => {
    grossSalesRevenue += (s.total || 0);
    paidAtSale += (s.paidNow || 0);
    creditGiven += (s.remainingDebt || 0);

    const ch = s.paymentChannel || 'Cash';
    paymentModes[ch] = (paymentModes[ch] || 0) + (s.paidNow || 0);

    (s.items || []).forEach(item => {
      // Calculate Cost of Goods Sold (COGS)
      const cost = item.costPrice !== undefined ? item.costPrice : (db.products.find(p => p.id === item.productId)?.costPrice || 0);
      cogs += (item.quantity || 0) * cost;

      const groupKey = `${item.productName}___${item.unitPrice}`;
      if (!groupedProducts[groupKey]) {
        groupedProducts[groupKey] = {
          productName: item.productName,
          unitPrice: item.unitPrice,
          unit: item.unit || '',
          totalQuantity: 0,
          totalRevenue: 0
        };
      }
      groupedProducts[groupKey].totalQuantity += (item.quantity || 0);
      groupedProducts[groupKey].totalRevenue += (item.lineTotal || (item.quantity * item.unitPrice));
    });
  });

  let creditPayments = 0;
  branchCustomerPayments.forEach(p => {
    creditPayments += (p.amount || 0);
    const ch = p.channel || 'Cash';
    paymentModes[ch] = (paymentModes[ch] || 0) + (p.amount || 0);
  });

  const totalReceived = paidAtSale + creditPayments;

  let operatingExpenses = 0;
  branchExpenses.forEach(e => {
    operatingExpenses += (e.amount || 0);
  });

  const grossProfit = grossSalesRevenue - cogs;
  const grossMarginPct = grossSalesRevenue > 0 ? ((grossProfit / grossSalesRevenue) * 100).toFixed(1) : '0.0';

  const netProfit = grossProfit - operatingExpenses;
  const netMarginPct = grossSalesRevenue > 0 ? ((netProfit / grossSalesRevenue) * 100).toFixed(1) : '0.0';

  const netCash = totalReceived - operatingExpenses;

  // Comparison Percentages
  const compTotal = (paidAtSale + creditPayments) || 1;
  const pctPaidSale = Math.round((paidAtSale / compTotal) * 100);
  const pctCreditPay = Math.round((creditPayments / compTotal) * 100);

  // 2. Cash Drawer Reconciliation Calculations
  const cashSales = validSales.filter(s => (s.paymentChannel || '').toLowerCase() === 'cash' || !s.paymentChannel).reduce((acc, s) => acc + (s.paidNow || 0), 0);
  const cashDebtCollected = branchCustomerPayments.filter(p => (p.channel || '').toLowerCase() === 'cash' || !p.channel).reduce((acc, p) => acc + (p.amount || 0), 0);
  const cashExpensesPaid = branchExpenses.reduce((acc, e) => acc + (e.amount || 0), 0);
  const cashRefundsPaid = voidedSales.filter(s => (s.paymentChannel || '').toLowerCase() === 'cash' || !s.paymentChannel).reduce((acc, s) => acc + (s.paidNow || 0), 0);
  const expectedCash = cashSales + cashDebtCollected - cashExpensesPaid - cashRefundsPaid;

  mainContent.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">📊 ${t('menuShopControl')}</h2>
        <div class="page-subtitle">${escapeHtml(getActiveBranch().name)} (${startDate} ~ ${endDate})</div>
      </div>
    </div>

    <!-- Time Period Filter Tabs & Calendar Picker -->
    <div class="card" style="padding: 0.75rem 1rem; margin-bottom: 1.25rem;">
      <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem;">
        <div class="tabs" style="margin-bottom: 0; border-bottom: none;">
          <button class="tab-btn ${activePeriod === 'daily' ? 'active' : ''}" id="tab-period-daily">
            📅 ${t('daily')}
          </button>
          <button class="tab-btn ${activePeriod === 'weekly' ? 'active' : ''}" id="tab-period-weekly">
            📆 ${t('weekly')}
          </button>
          <button class="tab-btn ${activePeriod === 'monthly' ? 'active' : ''}" id="tab-period-monthly">
            🗓️ ${t('monthly')}
          </button>
        </div>

        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <label for="calendar-day-picker" style="margin: 0; font-size: 0.85rem; white-space: nowrap;">
            📍 ${t('specificDay')}:
          </label>
          <input type="date" id="calendar-day-picker" value="${specificDate || today}" max="${today}" style="width: auto; padding: 0.4rem 0.6rem;" />
        </div>
      </div>
    </div>

    <!-- P&L Financial Key Metrics Grid -->
    <div class="metrics-grid">
      <!-- 1. Gross Sales Revenue -->
      <div class="metric-card sales">
        <span class="metric-label">${t('grossSales')}</span>
        <span class="metric-value">${fmtMoney(grossSalesRevenue)}</span>
        <span class="metric-sub">${validSales.length} valid sales ${voidedSales.length > 0 ? `(${voidedSales.length} voided)` : ''}</span>
      </div>

      <!-- 2. Cost of Goods Sold (COGS) -->
      <div class="metric-card expenses">
        <span class="metric-label">${t('cogs')}</span>
        <span class="metric-value" style="color: var(--danger);">${fmtMoney(cogs)}</span>
        <span class="metric-sub">Inventory cost of sold goods</span>
      </div>

      <!-- 3. Gross Profit & Margin -->
      <div class="metric-card received">
        <span class="metric-label">${t('grossProfit')}</span>
        <span class="metric-value" style="color: var(--success);">${fmtMoney(grossProfit)}</span>
        <span class="metric-sub"><span class="margin-pill">${grossMarginPct}% ${t('grossMargin')}</span></span>
      </div>

      <!-- 4. Operating Expenses -->
      <div class="metric-card expenses">
        <span class="metric-label">${t('operatingExpenses')}</span>
        <span class="metric-value" style="color: var(--danger);">${fmtMoney(operatingExpenses)}</span>
        <span class="metric-sub">Daily employee expenses</span>
      </div>

      <!-- 5. Net Profit (P&L) -->
      <div class="metric-card net">
        <span class="metric-label">${t('netProfit')}</span>
        <span class="metric-value ${netProfit >= 0 ? 'profit-positive' : 'profit-negative'}">${fmtMoney(netProfit)}</span>
        <span class="metric-sub"><span class="margin-pill ${netProfit >= 0 ? 'profit-positive' : 'profit-negative'}">${netMarginPct}% ${t('netMargin')}</span></span>
      </div>

      <!-- 6. Net Cash Flow -->
      <div class="metric-card credit">
        <span class="metric-label">${t('netCashFlow')}</span>
        <span class="metric-value" style="color: #7c3aed;">${fmtMoney(netCash)}</span>
        <span class="metric-sub">${fmtMoney(totalReceived)} in - ${fmtMoney(operatingExpenses)} out</span>
      </div>
    </div>

    <!-- P&L Financial Statement Card -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">📈 ${t('plStatement')}</h3>
        <span class="status-pill ${netProfit >= 0 ? 'status-paid' : 'status-overdue'}">
          ${netProfit >= 0 ? `✅ ${t('profitable')}` : `❌ ${t('netLoss')}`}
        </span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <tbody>
            <tr>
              <td><strong>1. ${t('grossSales')} (+)</strong></td>
              <td style="text-align: right; font-weight: 700;">${fmtMoney(grossSalesRevenue)}</td>
              <td style="text-align: right;"><span class="margin-pill">100.0%</span></td>
            </tr>
            <tr>
              <td><span style="padding-left: 1rem; color: var(--text-muted);">2. ${t('cogs')} (-)</span></td>
              <td style="text-align: right; color: var(--danger); font-weight: 700;">-${fmtMoney(cogs)}</td>
              <td style="text-align: right;"><span class="margin-pill">${grossSalesRevenue > 0 ? ((cogs / grossSalesRevenue) * 100).toFixed(1) : 0}%</span></td>
            </tr>
            <tr style="background: var(--bg-subtle);">
              <td><strong>3. = ${t('grossProfit')}</strong></td>
              <td style="text-align: right; color: var(--success); font-weight: 800;">${fmtMoney(grossProfit)}</td>
              <td style="text-align: right;"><span class="margin-pill" style="background: var(--success-light); color: var(--success-text);">${grossMarginPct}%</span></td>
            </tr>
            <tr>
              <td><span style="padding-left: 1rem; color: var(--text-muted);">4. ${t('operatingExpenses')} (-)</span></td>
              <td style="text-align: right; color: var(--danger); font-weight: 700;">-${fmtMoney(operatingExpenses)}</td>
              <td style="text-align: right;"><span class="margin-pill">${grossSalesRevenue > 0 ? ((operatingExpenses / grossSalesRevenue) * 100).toFixed(1) : 0}%</span></td>
            </tr>
            <tr style="background: var(--bg-card); border-top: 2px solid var(--border-color);">
              <td><strong style="font-size: 1.05rem;">5. = ${t('netProfit')} / (${t('netLoss')})</strong></td>
              <td style="text-align: right; font-size: 1.15rem; font-weight: 800;" class="${netProfit >= 0 ? 'profit-positive' : 'profit-negative'}">
                ${fmtMoney(netProfit)}
              </td>
              <td style="text-align: right;"><span class="margin-pill ${netProfit >= 0 ? 'reconcile-balanced' : 'reconcile-shortage'}">${netMarginPct}%</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- End-of-Day Cash Drawer Reconciliation (Balancing) Card -->
    <div class="card reconciliation-card">
      <div class="card-header">
        <h3 class="card-title">💰 ${t('cashReconciliation')}</h3>
        <span class="status-pill status-paid">${startDate} ~ ${endDate}</span>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1rem;">
        <div style="background: var(--bg-card); padding: 0.75rem; border-radius: var(--radius-sm); border: 1px solid var(--border-color);">
          <small style="color: var(--text-muted);">${t('cashSales')}</small>
          <div style="font-weight: 700; color: var(--success); font-size: 1.05rem;">+${fmtMoney(cashSales)}</div>
        </div>
        <div style="background: var(--bg-card); padding: 0.75rem; border-radius: var(--radius-sm); border: 1px solid var(--border-color);">
          <small style="color: var(--text-muted);">${t('cashDebtCollected')}</small>
          <div style="font-weight: 700; color: var(--primary); font-size: 1.05rem;">+${fmtMoney(cashDebtCollected)}</div>
        </div>
        <div style="background: var(--bg-card); padding: 0.75rem; border-radius: var(--radius-sm); border: 1px solid var(--border-color);">
          <small style="color: var(--text-muted);">${t('cashExpensesPaid')}</small>
          <div style="font-weight: 700; color: var(--danger); font-size: 1.05rem;">-${fmtMoney(cashExpensesPaid)}</div>
        </div>
        <div style="background: var(--bg-card); padding: 0.75rem; border-radius: var(--radius-sm); border: 1px solid var(--border-color);">
          <small style="color: var(--text-muted);">${t('cashRefundsPaid')}</small>
          <div style="font-weight: 700; color: var(--accent); font-size: 1.05rem;">-${fmtMoney(cashRefundsPaid)}</div>
        </div>
      </div>

      <div style="background: var(--bg-card); padding: 1rem; border-radius: var(--radius-md); border: 2px solid var(--primary-light); margin-bottom: 1rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
          <span style="font-size: 1rem; font-weight: 700;">${t('expectedCash')}:</span>
          <span style="font-size: 1.35rem; font-weight: 800; color: var(--primary);" id="expected-cash-display">${fmtMoney(expectedCash)}</span>
        </div>

        <div class="form-grid">
          <div class="form-group" style="margin-bottom: 0;">
            <label>${t('countedCash')} (RWF) *</label>
            <input type="number" id="drawer-counted-input" placeholder="Enter counted physical cash..." style="font-size: 1.1rem; font-weight: 700;" />
          </div>
          <div class="form-group" style="margin-bottom: 0;">
            <label>${t('closingNotes')}</label>
            <input type="text" id="drawer-notes-input" placeholder="e.g. 50,000 kept as float for tomorrow" />
          </div>
        </div>

        <div id="drawer-diff-banner-container" style="margin-top: 0.75rem;">
          <!-- Dynamically filled: Balanced / Shortage / Overage banner -->
        </div>

        <div style="margin-top: 1rem; display: flex; justify-content: flex-end;">
          <button type="button" class="btn btn-primary" id="btn-save-drawer-closing">
            🔒 ${t('saveReconciliation')}
          </button>
        </div>
      </div>

      <!-- Historical Closings in this branch -->
      <div style="margin-top: 1rem;">
        <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem;">📋 ${t('reconciliationHistory')}</h4>
        <div class="table-responsive">
          <table class="table">
            <thead>
              <tr>
                <th>${t('date')}</th>
                <th>Expected</th>
                <th>Counted</th>
                <th>${t('difference')}</th>
                <th>${t('status')}</th>
                <th>Closed By</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              ${(db.cashReconciliations || []).filter(r => r.branchId === state.branchId).slice(0, 5).map(r => `
                <tr>
                  <td><strong>${escapeHtml(r.date)}</strong> <small style="color:var(--text-muted);">${escapeHtml(r.time || '')}</small></td>
                  <td>${fmtMoney(r.expectedCash)}</td>
                  <td><strong>${fmtMoney(r.countedCash)}</strong></td>
                  <td style="color: ${r.difference === 0 ? 'var(--success)' : (r.difference < 0 ? 'var(--danger)' : 'var(--info)')}; font-weight: 700;">
                    ${r.difference > 0 ? '+' : ''}${fmtMoney(r.difference)}
                  </td>
                  <td>
                    <span class="status-pill ${r.status === 'balanced' ? 'status-paid' : (r.status === 'shortage' ? 'status-overdue' : 'status-waiting')}">
                      ${r.status === 'balanced' ? 'Balanced' : (r.status === 'shortage' ? 'Shortage' : 'Overage')}
                    </span>
                  </td>
                  <td><small>${escapeHtml(r.closedBy || 'Admin')}</small></td>
                  <td><small>${escapeHtml(r.notes || '-')}</small></td>
                </tr>
              `).join('') || `<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No drawer closings recorded yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Credit Payments vs Paid at Sale Comparison Bar -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">⚖️ ${t('creditPaymentsVsSale')}</h3>
      </div>
      <div class="comparison-container">
        <div class="comparison-bar">
          <div class="bar-segment-sale" style="width: ${pctPaidSale}%;" title="${t('paidAtSale')}: ${fmtMoney(paidAtSale)} (${pctPaidSale}%)"></div>
          <div class="bar-segment-credit" style="width: ${pctCreditPay}%;" title="${t('creditPayments')}: ${fmtMoney(creditPayments)} (${pctCreditPay}%)"></div>
        </div>
        <div class="comparison-legend">
          <div class="legend-item">
            <span class="legend-color" style="background: #10b981;"></span>
            <span>${t('paidAtSale')}: <strong>${fmtMoney(paidAtSale)}</strong> (${pctPaidSale}%)</span>
          </div>
          <div class="legend-item">
            <span class="legend-color" style="background: #3b82f6;"></span>
            <span>${t('creditPayments')}: <strong>${fmtMoney(creditPayments)}</strong> (${pctCreditPay}%)</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Payment Modes Breakdown & Totals -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">💳 ${t('paymentModesBreakdown')}</h3>
        <span class="badge-branch">Total: ${fmtMoney(totalReceived)}</span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>Payment Mode</th>
              <th>Amount Collected</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            ${Object.keys(paymentModes).map(mode => {
              const amt = paymentModes[mode];
              const pct = totalReceived > 0 ? Math.round((amt / totalReceived) * 100) : 0;
              return `
                <tr>
                  <td><strong>${escapeHtml(mode)}</strong></td>
                  <td><strong style="color: var(--success);">${fmtMoney(amt)}</strong></td>
                  <td>
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                      <div style="flex: 1; height: 8px; background: var(--bg-subtle); border-radius: var(--radius-full); overflow: hidden;">
                        <div style="height: 100%; width: ${pct}%; background: var(--primary);"></div>
                      </div>
                      <span style="font-size: 0.8rem; color: var(--text-muted);">${pct}%</span>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Products Sold Grouped by Price -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">🏷️ ${t('productsSoldByPrice')}</h3>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>Product Name</th>
              <th>Unit Selling Price</th>
              <th>Quantity Sold</th>
              <th>Total Revenue</th>
            </tr>
          </thead>
          <tbody>
            ${Object.keys(groupedProducts).length === 0 ? `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No sales in this period.</td></tr>` : ''}
            ${Object.values(groupedProducts).map(p => `
              <tr>
                <td><strong>${escapeHtml(p.productName)}</strong></td>
                <td>${fmtMoney(p.unitPrice)}</td>
                <td><span class="status-pill status-waiting">${p.totalQuantity} ${escapeHtml(p.unit)}</span></td>
                <td><strong style="color: var(--primary);">${fmtMoney(p.totalRevenue)}</strong></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Recent Sales Transactions with Return / Void Action -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">🧾 Recent Sales Transactions (${branchSales.length})</h3>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>Date & Time</th>
              <th>Customer</th>
              <th>Items</th>
              <th>Total</th>
              <th>Paid</th>
              <th>Status / Sold By</th>
              <th style="text-align: right;">Action</th>
            </tr>
          </thead>
          <tbody>
            ${branchSales.length === 0 ? `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No sales recorded in this period.</td></tr>` : ''}
            ${branchSales.map(s => `
              <tr style="${s.isVoided ? 'opacity: 0.65; background: var(--bg-subtle);' : ''}">
                <td>
                  <div><strong>${escapeHtml(s.saleDate)}</strong></div>
                  <small style="color: var(--text-muted);">${escapeHtml(s.saleTime || '')}</small>
                </td>
                <td>
                  <strong>${escapeHtml(s.customerName || 'Walk-in')}</strong>
                  ${s.customerPhone ? `<br><small style="color:var(--text-muted);">${escapeHtml(s.customerPhone)}</small>` : ''}
                </td>
                <td>
                  <small>${(s.items || []).map(i => `${i.quantity} ${escapeHtml(i.unit || '')} ${escapeHtml(i.productName)}`).join(', ')}</small>
                </td>
                <td><strong>${fmtMoney(s.total)}</strong></td>
                <td><span style="color: var(--success); font-weight: 700;">${fmtMoney(s.paidNow)}</span></td>
                <td>
                  ${s.isVoided ? 
                    `<span class="status-pill status-voided">Voided</span><br><small style="color:var(--danger);">${escapeHtml(s.voidReason || '')}</small>` : 
                    `<span class="status-pill status-paid">Valid</span><br><small style="color:var(--text-muted);">By: ${escapeHtml(s.soldBy || 'Staff')}</small>`
                  }
                </td>
                <td style="text-align: right;">
                  ${!s.isVoided ? `
                    <button class="btn btn-danger btn-sm btn-void-sale" data-id="${s.id}">
                      🔄 ${t('voidSale')}
                    </button>
                  ` : `
                    <small style="color: var(--text-muted);">Voided at ${escapeHtml(s.voidedAt || '')}</small>
                  `}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Expenses (Employee Purchases) -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">💸 ${t('employeeExpensesTitle')}</h3>
        <span class="status-pill status-overdue">Total: ${fmtMoney(operatingExpenses)}</span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('date')} & ${t('time')}</th>
              <th>${t('actionDone')}</th>
              <th style="text-align: right;">${t('amount')}</th>
            </tr>
          </thead>
          <tbody>
            ${branchExpenses.length === 0 ? `<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">No expenses recorded in this period.</td></tr>` : ''}
            ${branchExpenses.map(e => `
              <tr>
                <td>
                  <div>${escapeHtml(e.date)}</div>
                  <small style="color: var(--text-muted);">${escapeHtml(e.time || '')}</small>
                </td>
                <td><strong>${escapeHtml(e.actionDone)}</strong></td>
                <td style="text-align: right; color: var(--danger); font-weight: 700;">-${fmtMoney(e.amount)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Attach Period switchers
  document.getElementById('tab-period-daily').onclick = () => renderAdminShopControl('daily');
  document.getElementById('tab-period-weekly').onclick = () => renderAdminShopControl('weekly');
  document.getElementById('tab-period-monthly').onclick = () => renderAdminShopControl('monthly');

  const picker = document.getElementById('calendar-day-picker');
  picker.onchange = (e) => {
    if (e.target.value) {
      renderAdminShopControl('specific', e.target.value);
    }
  };

  // Attach Cash Drawer Counted Input Live Calculation
  const countedInput = document.getElementById('drawer-counted-input');
  const diffContainer = document.getElementById('drawer-diff-banner-container');
  const notesInput = document.getElementById('drawer-notes-input');

  function updateDrawerDiff() {
    const val = countedInput.value.trim();
    if (val === '') {
      diffContainer.innerHTML = '';
      return;
    }
    const counted = parseFloat(val) || 0;
    const diff = counted - expectedCash;
    if (diff === 0) {
      diffContainer.innerHTML = `
        <div class="reconcile-diff-banner reconcile-balanced">
          <span>✅ ${t('drawerBalanced')}</span>
          <span>0 RWF Diff</span>
        </div>
      `;
    } else if (diff < 0) {
      diffContainer.innerHTML = `
        <div class="reconcile-diff-banner reconcile-shortage">
          <span>⚠️ ${t('drawerShortage')}</span>
          <span>-${fmtMoney(Math.abs(diff))}</span>
        </div>
      `;
    } else {
      diffContainer.innerHTML = `
        <div class="reconcile-diff-banner reconcile-overage">
          <span>ℹ️ ${t('drawerOverage')}</span>
          <span>+${fmtMoney(diff)}</span>
        </div>
      `;
    }
  }
  countedInput.oninput = updateDrawerDiff;

  document.getElementById('btn-save-drawer-closing').onclick = () => {
    const val = countedInput.value.trim();
    if (val === '') {
      showToast('Please enter the actual counted cash in drawer.', 'warning');
      return;
    }
    const counted = parseFloat(val) || 0;
    const diff = counted - expectedCash;
    const status = diff === 0 ? 'balanced' : (diff < 0 ? 'shortage' : 'overage');

    if (!db.cashReconciliations) db.cashReconciliations = [];
    db.cashReconciliations.unshift({
      id: 'rec-' + Date.now(),
      branchId: state.branchId,
      date: getTodayStr(),
      time: getCurrentTimeStr(),
      expectedCash,
      countedCash: counted,
      difference: diff,
      status,
      notes: notesInput.value.trim(),
      closedBy: state.employeeName || 'Admin'
    });

    saveDB();
    showToast(t('reconciliationSaved'), 'success');
    renderAdminShopControl(activePeriod, specificDate);
  };

  // Attach Void buttons
  document.querySelectorAll('.btn-void-sale').forEach(btn => {
    btn.onclick = () => openVoidSaleModal(btn.dataset.id);
  });
}

function renderAdminPurchases() {
  pageTitleEl.textContent = t('menuPurchases');

  const branchPurchases = db.purchases.filter(p => p.branchId === state.branchId);
  const branchSuppliers = db.suppliers.filter(s => s.branchId === state.branchId);

  mainContent.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">🛒 ${t('menuPurchases')}</h2>
        <div class="page-subtitle">${t('newPurchase')}</div>
      </div>
      <div>
        <button class="btn btn-secondary btn-sm" id="btn-register-supplier-modal">
          ${t('registerSupplier')}
        </button>
      </div>
    </div>

    <!-- Purchase Entry Form Card -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">📝 ${t('newPurchase')}</h3>
      </div>
      <form id="purchase-form">
        <div class="form-grid">
          <!-- Supplier selection -->
          <div class="form-group">
            <label>${t('supplier')} *</label>
            <select id="pur-supplier-select" required>
              <option value="">-- Choose Supplier --</option>
              ${branchSuppliers.map(s => `
                <option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.phone)})</option>
              `).join('')}
            </select>
          </div>

          <!-- Item Name -->
          <div class="form-group">
            <label>${t('productName')} *</label>
            <input type="text" id="pur-item-name" required placeholder="e.g. Sugar, Maize Flour, Cooking Oil" />
          </div>

          <!-- Unit -->
          <div class="form-group">
            <label>${t('unit')} *</label>
            <select id="pur-unit" required>
              <option value="kg">kg (Kilogram)</option>
              <option value="Litre">Litre</option>
              <option value="pcs">pcs (Pieces)</option>
              <option value="bag">bag</option>
              <option value="box">box</option>
            </select>
          </div>

          <!-- Quantity -->
          <div class="form-group">
            <label>${t('quantity')} *</label>
            <input type="number" id="pur-qty" min="1" step="any" required placeholder="Quantity" />
          </div>

          <!-- Unit Cost -->
          <div class="form-group">
            <label>${t('unitCost')} (RWF) *</label>
            <input type="number" id="pur-unit-cost" min="1" required placeholder="Cost per unit" />
          </div>

          <!-- Purchase Date -->
          <div class="form-group">
            <label>${t('purchaseDate')} *</label>
            <input type="date" id="pur-date" value="${getTodayStr()}" required />
          </div>

          <!-- Total Cost (Auto-calculated) -->
          <div class="form-group">
            <label>${t('totalCost')} (Auto)</label>
            <input type="text" id="pur-total-cost" readonly value="0 RWF" style="font-weight: 700; color: var(--primary);" />
          </div>

          <!-- Paid Now -->
          <div class="form-group">
            <label>${t('paidNow')} (RWF) *</label>
            <input type="number" id="pur-paid-now" min="0" value="0" required />
          </div>

          <!-- Promised Payment Date (Required if unpaid) -->
          <div class="form-group">
            <label>${t('promisedPaymentDate')}</label>
            <input type="date" id="pur-promised-date" />
          </div>

          <!-- Payment Method -->
          <div class="form-group">
            <label>${t('paymentMethod')}</label>
            <select id="pur-method">
              <option value="Cash">Cash</option>
              <option value="MoMo">Mobile Money (MoMo)</option>
              <option value="Bank Transfer">Bank Transfer</option>
              <option value="Cheque">Cheque</option>
            </select>
          </div>

          <!-- Account Paid To -->
          <div class="form-group">
            <label>${t('accountPaidTo')}</label>
            <input type="text" id="pur-account" placeholder="e.g. Bank account digits or MoMo number" />
          </div>
        </div>

        <div style="margin-top: 1rem; display: flex; justify-content: flex-end;">
          <button type="submit" class="btn btn-primary">
            💾 ${t('save')} Purchase
          </button>
        </div>
      </form>
    </div>

    <!-- Recent Purchases Table with status & Action Delete -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">📜 ${t('recentPurchases')}</h3>
        <span class="badge-branch">${branchPurchases.length} total</span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('date')}</th>
              <th>${t('supplier')}</th>
              <th>${t('productName')}</th>
              <th>${t('quantity')}</th>
              <th>${t('totalCost')}</th>
              <th>${t('paidNow')}</th>
              <th>${t('status')}</th>
              <th>Registered?</th>
              <th style="text-align: right;">${t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            ${branchPurchases.length === 0 ? `<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">No purchases recorded.</td></tr>` : ''}
            ${branchPurchases.slice().reverse().map(p => {
              const remaining = Math.max(0, (p.totalCost || 0) - (p.paidNow || 0));
              let statusPill = `<span class="status-pill status-paid">${t('fullyPaid')}</span>`;
              if (remaining > 0) {
                if (p.paidNow > 0) {
                  statusPill = `<span class="status-pill status-partial">${t('partiallyPaid')} (${fmtMoney(remaining)})</span>`;
                } else {
                  statusPill = `<span class="status-pill status-overdue">${t('all')} Credit (${fmtMoney(remaining)})</span>`;
                }
              }

              return `
                <tr>
                  <td>${escapeHtml(p.purchaseDate || '')}</td>
                  <td><strong>${escapeHtml(p.supplierName || '')}</strong></td>
                  <td><strong>${escapeHtml(p.itemName)}</strong></td>
                  <td>${p.quantity} ${escapeHtml(p.unit)}</td>
                  <td>${fmtMoney(p.totalCost)}</td>
                  <td><span style="color: var(--success);">${fmtMoney(p.paidNow)}</span></td>
                  <td>${statusPill}</td>
                  <td>
                    ${p.registered ? 
                      `<span class="status-pill status-registered">Registered</span>` : 
                      `<span class="status-pill status-waiting">Not Registered</span>`
                    }
                  </td>
                  <td style="text-align: right;">
                    <button class="btn btn-danger btn-sm btn-delete-purchase" data-id="${p.id}" ${p.registered ? 'disabled title="Cannot delete: already registered"' : ''}>
                      🗑️ ${t('delete')}
                    </button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Auto-calculation of total cost
  const qtyInput = document.getElementById('pur-qty');
  const costInput = document.getElementById('pur-unit-cost');
  const totalDisplay = document.getElementById('pur-total-cost');
  const paidNowInput = document.getElementById('pur-paid-now');

  function recalcTotal() {
    const q = parseFloat(qtyInput.value) || 0;
    const c = parseFloat(costInput.value) || 0;
    const tot = q * c;
    totalDisplay.value = fmtMoney(tot);
  }

  qtyInput.oninput = recalcTotal;
  costInput.oninput = recalcTotal;

  document.getElementById('btn-register-supplier-modal').onclick = () => openRegisterSupplierModal();

  // Submit Purchase
  document.getElementById('purchase-form').onsubmit = (e) => {
    e.preventDefault();
    const supId = document.getElementById('pur-supplier-select').value;
    const supplier = db.suppliers.find(s => s.id === supId);
    if (!supplier) {
      showToast('Please select or register a supplier first.', 'error');
      return;
    }

    const itemName = document.getElementById('pur-item-name').value.trim();
    const unit = document.getElementById('pur-unit').value;
    const qty = parseFloat(qtyInput.value);
    const unitCost = parseFloat(costInput.value);
    const date = document.getElementById('pur-date').value;
    const paidNow = parseFloat(paidNowInput.value) || 0;
    const promised = document.getElementById('pur-promised-date').value;
    const method = document.getElementById('pur-method').value;
    const account = document.getElementById('pur-account').value.trim();

    const totalCost = qty * unitCost;

    if (paidNow < totalCost && !promised) {
      showToast('Please enter promised payment date for remaining supplier balance.', 'warning');
      return;
    }

    const newPurchase = {
      id: 'pur-' + Date.now(),
      branchId: state.branchId,
      supplierId: supplier.id,
      supplierName: supplier.name,
      itemName,
      unit,
      quantity: qty,
      unitCost,
      totalCost,
      purchaseDate: date,
      promisedPaymentDate: promised,
      paidNow,
      paymentMethod: method,
      accountPaidTo: account || supplier.bankAccount,
      registered: false,
      registeredProductId: null,
      createdAt: getTodayStr()
    };

    db.purchases.push(newPurchase);
    saveDB();
    showToast('Purchase recorded successfully! You can register it in Products.', 'success');
    renderAdminPurchases();
  };

  // Delete Purchase Handler (Strict check: ONLY if nothing in it is registered)
  document.querySelectorAll('.btn-delete-purchase').forEach(btn => {
    btn.onclick = () => {
      const purId = btn.dataset.id;
      const pur = db.purchases.find(p => p.id === purId);
      if (!pur) return;

      if (pur.registered) {
        showToast(t('cannotDeleteRegisteredPurchase'), 'error');
        return;
      }

      if (confirm('Are you sure you want to delete this purchase record?')) {
        db.purchases = db.purchases.filter(p => p.id !== purId);
        saveDB();
        showToast(t('purchaseDeletedSuccess'), 'success');
        renderAdminPurchases();
      }
    };
  });
}

function openRegisterSupplierModal() {
  const modalHtml = `
    <form id="register-supplier-form">
      <div class="form-group">
        <label>${t('supplierName')} * <span class="hint">(letters only)</span></label>
        <input type="text" id="sup-reg-name" required placeholder="e.g. Sulfo Rwanda" />
      </div>
      <div class="form-group">
        <label>${t('supplierPhone')} * <span class="hint">(digits up to 10)</span></label>
        <input type="text" id="sup-reg-phone" maxlength="10" required placeholder="e.g. 0788123456" />
      </div>
      <div class="form-group">
        <label>${t('supplierBank')} * <span class="hint">(digits only)</span></label>
        <input type="text" id="sup-reg-bank" required placeholder="e.g. 10002345678" />
      </div>
    </form>
  `;

  const footerHtml = `
    <button type="button" class="btn btn-secondary btn-sm" onclick="closeModal()">${t('cancel')}</button>
    <button type="submit" form="register-supplier-form" class="btn btn-primary btn-sm">${t('save')}</button>
  `;

  openModal(t('registerSupplier'), modalHtml, footerHtml);

  document.getElementById('register-supplier-form').onsubmit = (e) => {
    e.preventDefault();
    const name = document.getElementById('sup-reg-name').value.trim();
    const phone = document.getElementById('sup-reg-phone').value.trim();
    const bank = document.getElementById('sup-reg-bank').value.trim();

    if (!validateName(name)) {
      showToast('Supplier name must contain letters only!', 'error');
      return;
    }
    if (!validatePhone(phone)) {
      showToast('Supplier phone must be digits only up to 10 characters!', 'error');
      return;
    }
    if (!validateDigitsOnly(bank)) {
      showToast('Bank account must be digits only!', 'error');
      return;
    }

    const newSupplier = {
      id: 'sup-' + Date.now(),
      branchId: state.branchId,
      name,
      phone,
      bankAccount: bank,
      createdAt: getTodayStr()
    };

    db.suppliers.push(newSupplier);
    saveDB();
    closeModal();
    showToast('Supplier registered successfully!', 'success');
    renderAdminPurchases();
  };
}

/* ----------------------------------------------------------------------------
   Admin 7. Suppliers
   Enter: search; payment amount, date, method, account paid to.
   Shows: tabs All, Partially paid, Fully paid (with counts); bank accounts used,
   total credit, paid, remaining, Purchases and Payments history.
   Action: Delete supplier (only if nothing is owed).
   ---------------------------------------------------------------------------- */
function getSupplierDebt(supplierId) {
  const purchases = db.purchases.filter(p => p.supplierId === supplierId);
  const payments = db.supplierPayments.filter(sp => sp.supplierId === supplierId);

  let totalCredit = 0;
  let paid = 0;

  purchases.forEach(p => {
    totalCredit += (p.totalCost || 0);
    paid += (p.paidNow || 0);
  });

  payments.forEach(sp => {
    paid += (sp.amount || 0);
  });

  const remaining = Math.max(0, totalCredit - paid);
  let status = 'paid';
  if (remaining > 0) {
    status = paid > 0 ? 'partial' : 'unpaid';
  }

  return { totalCredit, paid, remaining, status };
}

function renderAdminSuppliers(activeTab = 'all', searchQuery = '') {
  pageTitleEl.textContent = t('menuSuppliers');

  const branchSuppliers = db.suppliers.filter(s => s.branchId === state.branchId);

  let counts = { all: branchSuppliers.length, partial: 0, paid: 0 };
  const supplierDebtMap = {};

  branchSuppliers.forEach(s => {
    const debt = getSupplierDebt(s.id);
    supplierDebtMap[s.id] = debt;
    if (debt.status === 'paid') counts.paid++;
    else counts.partial++;
  });

  const filtered = branchSuppliers.filter(s => {
    const debt = supplierDebtMap[s.id];
    if (activeTab === 'partial' && debt.status === 'paid') return false;
    if (activeTab === 'paid' && debt.status !== 'paid') return false;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return s.name.toLowerCase().includes(q) || (s.phone || '').includes(q) || (s.bankAccount || '').includes(q);
    }
    return true;
  });

  mainContent.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">🚚 ${t('menuSuppliers')}</h2>
        <div class="page-subtitle">${t('supplierList')}</div>
      </div>
      <div>
        <button class="btn btn-primary" id="btn-add-supplier-top">
          ${t('registerSupplier')}
        </button>
      </div>
    </div>

    <!-- Search bar -->
    <div class="search-bar">
      <div class="search-input-wrapper">
        <span class="search-icon">🔍</span>
        <input type="text" id="supplier-search-input" value="${escapeHtml(searchQuery)}" placeholder="${t('search')} suppliers (name, phone, bank)..." />
      </div>
    </div>

    <!-- Tabs with counts -->
    <div class="tabs">
      <button class="tab-btn ${activeTab === 'all' ? 'active' : ''}" id="tab-sup-all">
        ${t('all')} <span class="tab-badge">${counts.all}</span>
      </button>
      <button class="tab-btn ${activeTab === 'partial' ? 'active' : ''}" id="tab-sup-partial">
        ${t('partiallyPaid')} <span class="tab-badge">${counts.partial}</span>
      </button>
      <button class="tab-btn ${activeTab === 'paid' ? 'active' : ''}" id="tab-sup-paid">
        ${t('fullyPaid')} <span class="tab-badge">${counts.paid}</span>
      </button>
    </div>

    <!-- Suppliers Table -->
    <div class="card">
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('supplier')}</th>
              <th>${t('bankAccountsUsed')}</th>
              <th>${t('totalCreditOwed')}</th>
              <th>${t('paid')}</th>
              <th>${t('remaining')}</th>
              <th>${t('status')}</th>
              <th style="text-align: right;">${t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.length === 0 ? `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No suppliers match criteria.</td></tr>` : ''}
            ${filtered.map(s => {
              const d = supplierDebtMap[s.id];
              return `
                <tr>
                  <td>
                    <strong>${escapeHtml(s.name)}</strong>
                    <div style="font-size: 0.78rem; color: var(--text-muted);">${escapeHtml(s.phone || '-')}</div>
                  </td>
                  <td><code>${escapeHtml(s.bankAccount || '-')}</code></td>
                  <td>${fmtMoney(d.totalCredit)}</td>
                  <td><span style="color: var(--success);">${fmtMoney(d.paid)}</span></td>
                  <td><strong style="color: ${d.remaining > 0 ? 'var(--danger)' : 'inherit'};">${fmtMoney(d.remaining)}</strong></td>
                  <td>
                    ${d.remaining === 0 ? 
                      `<span class="status-pill status-paid">${t('fullyPaid')}</span>` : 
                      `<span class="status-pill status-partial">${t('partiallyPaid')}</span>`
                    }
                  </td>
                  <td style="text-align: right;">
                    <div class="actions-cell" style="justify-content: flex-end;">
                      <button class="btn btn-primary btn-sm btn-pay-supplier" data-id="${s.id}">
                        💳 Pay
                      </button>
                      <button class="btn btn-secondary btn-sm btn-view-sup-history" data-id="${s.id}">
                        👁️ History
                      </button>
                      <button class="btn btn-danger btn-sm btn-delete-supplier" data-id="${s.id}">
                        🗑️ ${t('delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('tab-sup-all').onclick = () => renderAdminSuppliers('all', searchQuery);
  document.getElementById('tab-sup-partial').onclick = () => renderAdminSuppliers('partial', searchQuery);
  document.getElementById('tab-sup-paid').onclick = () => renderAdminSuppliers('paid', searchQuery);
  document.getElementById('btn-add-supplier-top').onclick = () => openRegisterSupplierModal();

  const searchInput = document.getElementById('supplier-search-input');
  searchInput.oninput = (e) => {
    renderAdminSuppliers(activeTab, e.target.value);
  };

  // Pay Supplier
  document.querySelectorAll('.btn-pay-supplier').forEach(btn => {
    btn.onclick = () => openSupplierPaymentModal(btn.dataset.id);
  });

  // Supplier History
  document.querySelectorAll('.btn-view-sup-history').forEach(btn => {
    btn.onclick = () => openSupplierHistoryModal(btn.dataset.id);
  });

  // Delete Supplier (Strict check: allowed only if nothing is owed)
  document.querySelectorAll('.btn-delete-supplier').forEach(btn => {
    btn.onclick = () => {
      const supId = btn.dataset.id;
      const debt = getSupplierDebt(supId);

      if (debt.remaining > 0) {
        showToast(`${t('cannotDeleteSupplierOwed')} (${fmtMoney(debt.remaining)})`, 'error');
        return;
      }

      if (confirm('Are you sure you want to delete this supplier? All debt has been settled.')) {
        db.suppliers = db.suppliers.filter(s => s.id !== supId);
        saveDB();
        showToast(t('supplierDeletedSuccess'), 'success');
        renderAdminSuppliers(activeTab, searchQuery);
      }
    };
  });
}

function openSupplierPaymentModal(supplierId) {
  const supplier = db.suppliers.find(s => s.id === supplierId);
  if (!supplier) return;
  const debt = getSupplierDebt(supplierId);

  const modalHtml = `
    <form id="supplier-payment-form">
      <div style="margin-bottom: 1rem; padding: 0.75rem; background: var(--bg-subtle); border-radius: var(--radius-md);">
        <div>Supplier: <strong>${escapeHtml(supplier.name)}</strong></div>
        <div>Remaining Debt: <strong style="color: var(--danger);">${fmtMoney(debt.remaining)}</strong></div>
        <div>Bank Account: <code>${escapeHtml(supplier.bankAccount)}</code></div>
      </div>

      <div class="form-group">
        <label>${t('paymentAmount')} (RWF) *</label>
        <input type="number" id="spay-amount" min="1" max="${debt.remaining || ''}" required placeholder="Amount to pay" />
      </div>

      <div class="form-group">
        <label>${t('date')} *</label>
        <input type="date" id="spay-date" value="${getTodayStr()}" required />
      </div>

      <div class="form-group">
        <label>${t('paymentMethod')} *</label>
        <select id="spay-method">
          <option value="Bank Transfer">Bank Transfer</option>
          <option value="MoMo">Mobile Money (MoMo)</option>
          <option value="Cash">Cash</option>
          <option value="Cheque">Cheque</option>
        </select>
      </div>

      <div class="form-group">
        <label>${t('accountPaidTo')} *</label>
        <input type="text" id="spay-account" value="${escapeHtml(supplier.bankAccount)}" required />
      </div>
    </form>
  `;

  const footerHtml = `
    <button type="button" class="btn btn-secondary btn-sm" onclick="closeModal()">${t('cancel')}</button>
    <button type="submit" form="supplier-payment-form" class="btn btn-primary btn-sm">${t('save')}</button>
  `;

  openModal(`${t('recordSupplierPayment')}: ${escapeHtml(supplier.name)}`, modalHtml, footerHtml);

  document.getElementById('supplier-payment-form').onsubmit = (e) => {
    e.preventDefault();
    const amount = parseFloat(document.getElementById('spay-amount').value);
    const date = document.getElementById('spay-date').value;
    const method = document.getElementById('spay-method').value;
    const account = document.getElementById('spay-account').value.trim();

    if (isNaN(amount) || amount <= 0) {
      showToast('Enter a valid payment amount', 'error');
      return;
    }

    const payment = {
      id: 'spay-' + Date.now(),
      supplierId: supplier.id,
      branchId: state.branchId,
      amount,
      date,
      method,
      accountPaidTo: account,
      createdAt: getTodayStr()
    };

    db.supplierPayments.push(payment);
    saveDB();
    closeModal();
    showToast('Payment recorded successfully!', 'success');
    renderAdminSuppliers();
  };
}

function openSupplierHistoryModal(supplierId) {
  const supplier = db.suppliers.find(s => s.id === supplierId);
  if (!supplier) return;

  const purchases = db.purchases.filter(p => p.supplierId === supplierId);
  const payments = db.supplierPayments.filter(sp => sp.supplierId === supplierId);
  const debt = getSupplierDebt(supplierId);

  const bodyHtml = `
    <div style="margin-bottom: 1rem; padding: 0.75rem; background: var(--bg-subtle); border-radius: var(--radius-md);">
      <h4 style="margin: 0 0 0.25rem 0;">${escapeHtml(supplier.name)}</h4>
      <div style="font-size: 0.85rem; color: var(--text-muted);">
        Phone: ${escapeHtml(supplier.phone)} • Bank: <code>${escapeHtml(supplier.bankAccount)}</code>
      </div>
      <div style="display: flex; gap: 1rem; margin-top: 0.5rem; font-size: 0.9rem;">
        <div>Total Purchases: <strong>${fmtMoney(debt.totalCredit)}</strong></div>
        <div>Total Settled: <strong style="color: var(--success);">${fmtMoney(debt.paid)}</strong></div>
        <div>Remaining Debt: <strong style="color: var(--danger);">${fmtMoney(debt.remaining)}</strong></div>
      </div>
    </div>

    <!-- Purchases History -->
    <h5>🛒 Purchases History</h5>
    <div class="table-responsive" style="margin-bottom: 1.25rem;">
      <table class="table">
        <thead>
          <tr>
            <th>${t('date')}</th>
            <th>Item</th>
            <th>Qty</th>
            <th>${t('totalCost')}</th>
            <th>${t('paidNow')}</th>
          </tr>
        </thead>
        <tbody>
          ${purchases.length === 0 ? `<tr><td colspan="5" style="color: var(--text-muted); text-align: center;">No purchases</td></tr>` : ''}
          ${purchases.map(p => `
            <tr>
              <td>${escapeHtml(p.purchaseDate || '')}</td>
              <td>${escapeHtml(p.itemName)}</td>
              <td>${p.quantity} ${escapeHtml(p.unit)}</td>
              <td>${fmtMoney(p.totalCost)}</td>
              <td><span style="color: var(--success);">${fmtMoney(p.paidNow)}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <!-- Payments History -->
    <h5>💳 Payments History</h5>
    <div class="table-responsive">
      <table class="table">
        <thead>
          <tr>
            <th>${t('date')}</th>
            <th>${t('amount')}</th>
            <th>Method</th>
            <th>Account Paid To</th>
          </tr>
        </thead>
        <tbody>
          ${payments.length === 0 ? `<tr><td colspan="4" style="color: var(--text-muted); text-align: center;">No payments recorded</td></tr>` : ''}
          ${payments.map(sp => `
            <tr>
              <td>${escapeHtml(sp.date)}</td>
              <td><strong style="color: var(--success);">${fmtMoney(sp.amount)}</strong></td>
              <td>${escapeHtml(sp.method)}</td>
              <td><code>${escapeHtml(sp.accountPaidTo)}</code></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  openModal(`Supplier Details: ${escapeHtml(supplier.name)}`, bodyHtml, `<button class="btn btn-secondary btn-sm" onclick="closeModal()">${t('close')}</button>`);
}

/* ----------------------------------------------------------------------------
   Admin 8. Others
   Enter: purchase date, supplier, product, TIN (9 digits), unit, quantity, price;
   later sell price, entry date, sold-out date.
   Shows: amount (quantity × price), Registered and Unregistered tables.
   Action: Delete.
   ---------------------------------------------------------------------------- */
function renderAdminOthers() {
  pageTitleEl.textContent = t('menuOthers');

  const branchOthers = db.others.filter(o => o.branchId === state.branchId);
  const registered = branchOthers.filter(o => o.status === 'registered');
  const unregistered = branchOthers.filter(o => o.status === 'unregistered');

  mainContent.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">📑 ${t('othersTitle')}</h2>
        <div class="page-subtitle">Track special purchases with official TIN and lifecycle</div>
      </div>
      <div>
        <button class="btn btn-primary" id="btn-add-other-modal">
          + Add Entry
        </button>
      </div>
    </div>

    <!-- Registered Table -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">✅ Registered Items (Active in Store)</h3>
        <span class="tab-badge">${registered.length}</span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('productName')}</th>
              <th>${t('supplier')}</th>
              <th>TIN</th>
              <th>Qty & Unit</th>
              <th>Cost Price</th>
              <th>Amount (Qty × Cost)</th>
              <th>${t('sellPriceLater')}</th>
              <th>${t('entryDate')}</th>
              <th>${t('soldOutDate')}</th>
              <th style="text-align: right;">${t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            ${registered.length === 0 ? `<tr><td colspan="10" style="text-align: center; color: var(--text-muted);">No registered items.</td></tr>` : ''}
            ${registered.map(o => `
              <tr>
                <td><strong>${escapeHtml(o.product)}</strong></td>
                <td>${escapeHtml(o.supplier)}</td>
                <td><code>${escapeHtml(o.tin)}</code></td>
                <td>${o.quantity} ${escapeHtml(o.unit)}</td>
                <td>${fmtMoney(o.price)}</td>
                <td><strong>${fmtMoney(o.amount || o.quantity * o.price)}</strong></td>
                <td><strong style="color: var(--primary);">${o.sellPrice ? fmtMoney(o.sellPrice) : '-'}</strong></td>
                <td>${escapeHtml(o.entryDate || '-')}</td>
                <td>${escapeHtml(o.soldOutDate || '-')}</td>
                <td style="text-align: right;">
                  <div class="actions-cell" style="justify-content: flex-end;">
                    <button class="btn btn-secondary btn-sm btn-edit-other-lifecycle" data-id="${o.id}">
                      ✏️ Update
                    </button>
                    <button class="btn btn-danger btn-sm btn-delete-other" data-id="${o.id}">
                      🗑️
                    </button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Unregistered Table -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">⏳ Unregistered Items (Pending Store Entry)</h3>
        <span class="tab-badge">${unregistered.length}</span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('productName')}</th>
              <th>${t('supplier')}</th>
              <th>TIN</th>
              <th>Qty & Unit</th>
              <th>Cost Price</th>
              <th>Amount</th>
              <th>Purchase Date</th>
              <th style="text-align: right;">${t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            ${unregistered.length === 0 ? `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No unregistered items.</td></tr>` : ''}
            ${unregistered.map(o => `
              <tr>
                <td><strong>${escapeHtml(o.product)}</strong></td>
                <td>${escapeHtml(o.supplier)}</td>
                <td><code>${escapeHtml(o.tin)}</code></td>
                <td>${o.quantity} ${escapeHtml(o.unit)}</td>
                <td>${fmtMoney(o.price)}</td>
                <td><strong>${fmtMoney(o.amount || o.quantity * o.price)}</strong></td>
                <td>${escapeHtml(o.purchaseDate || '')}</td>
                <td style="text-align: right;">
                  <div class="actions-cell" style="justify-content: flex-end;">
                    <button class="btn btn-primary btn-sm btn-register-other" data-id="${o.id}">
                      ➕ Register Now
                    </button>
                    <button class="btn btn-danger btn-sm btn-delete-other" data-id="${o.id}">
                      🗑️
                    </button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('btn-add-other-modal').onclick = () => openAddOtherModal();

  document.querySelectorAll('.btn-register-other').forEach(btn => {
    btn.onclick = () => openUpdateOtherModal(btn.dataset.id, true);
  });

  document.querySelectorAll('.btn-edit-other-lifecycle').forEach(btn => {
    btn.onclick = () => openUpdateOtherModal(btn.dataset.id, false);
  });

  document.querySelectorAll('.btn-delete-other').forEach(btn => {
    btn.onclick = () => {
      const othId = btn.dataset.id;
      if (confirm('Are you sure you want to delete this entry?')) {
        db.others = db.others.filter(o => o.id !== othId);
        saveDB();
        showToast('Entry deleted successfully.', 'success');
        renderAdminOthers();
      }
    };
  });
}

function openAddOtherModal() {
  const modalHtml = `
    <form id="add-other-form">
      <div class="form-grid">
        <div class="form-group">
          <label>${t('purchaseDate')} *</label>
          <input type="date" id="oth-date" value="${getTodayStr()}" required />
        </div>
        <div class="form-group">
          <label>${t('supplier')} *</label>
          <input type="text" id="oth-supplier" required placeholder="Supplier Name" />
        </div>
        <div class="form-group">
          <label>${t('productName')} *</label>
          <input type="text" id="oth-product" required placeholder="Product Name" />
        </div>
        <div class="form-group">
          <label>${t('tinNumber')} *</label>
          <input type="text" id="oth-tin" maxlength="9" required placeholder="9 digits (e.g. 102938475)" />
        </div>
        <div class="form-group">
          <label>${t('unit')} *</label>
          <input type="text" id="oth-unit" value="pcs" required />
        </div>
        <div class="form-group">
          <label>${t('quantity')} *</label>
          <input type="number" id="oth-qty" min="1" step="any" required placeholder="Quantity" />
        </div>
        <div class="form-group">
          <label>${t('unitCost')} (RWF) *</label>
          <input type="number" id="oth-price" min="1" required placeholder="Unit Price" />
        </div>
        <div class="form-group">
          <label>Calculated Amount (Qty × Price)</label>
          <input type="text" id="oth-amount-display" readonly value="0 RWF" style="font-weight: 700; color: var(--primary);" />
        </div>
      </div>
    </form>
  `;

  const footerHtml = `
    <button type="button" class="btn btn-secondary btn-sm" onclick="closeModal()">${t('cancel')}</button>
    <button type="submit" form="add-other-form" class="btn btn-primary btn-sm">${t('save')}</button>
  `;

  openModal('Add Other Purchase Entry', modalHtml, footerHtml);

  const qtyInput = document.getElementById('oth-qty');
  const priceInput = document.getElementById('oth-price');
  const amountDisplay = document.getElementById('oth-amount-display');

  function recalc() {
    const q = parseFloat(qtyInput.value) || 0;
    const p = parseFloat(priceInput.value) || 0;
    amountDisplay.value = fmtMoney(q * p);
  }
  qtyInput.oninput = recalc;
  priceInput.oninput = recalc;

  document.getElementById('add-other-form').onsubmit = (e) => {
    e.preventDefault();
    const tin = document.getElementById('oth-tin').value.trim();
    if (!validateTIN(tin)) {
      showToast(t('tinInvalid'), 'error');
      return;
    }

    const date = document.getElementById('oth-date').value;
    const supplier = document.getElementById('oth-supplier').value.trim();
    const product = document.getElementById('oth-product').value.trim();
    const unit = document.getElementById('oth-unit').value.trim();
    const qty = parseFloat(qtyInput.value);
    const price = parseFloat(priceInput.value);

    const newOther = {
      id: 'oth-' + Date.now(),
      branchId: state.branchId,
      purchaseDate: date,
      supplier,
      product,
      tin,
      unit,
      quantity: qty,
      price,
      amount: qty * price,
      sellPrice: null,
      entryDate: null,
      soldOutDate: null,
      status: 'unregistered'
    };

    db.others.push(newOther);
    saveDB();
    closeModal();
    showToast('Entry saved into Unregistered table.', 'success');
    renderAdminOthers();
  };
}

function openUpdateOtherModal(otherId, isRegistering = false) {
  const item = db.others.find(o => o.id === otherId);
  if (!item) return;

  const modalHtml = `
    <form id="update-other-form">
      <div style="margin-bottom: 1rem; padding: 0.75rem; background: var(--bg-subtle); border-radius: var(--radius-md);">
        <div>Product: <strong>${escapeHtml(item.product)}</strong> (${item.quantity} ${escapeHtml(item.unit)})</div>
        <div>Supplier: ${escapeHtml(item.supplier)} • TIN: <code>${escapeHtml(item.tin)}</code></div>
        <div>Cost: ${fmtMoney(item.price)} • Amount: <strong>${fmtMoney(item.amount)}</strong></div>
      </div>

      <div class="form-group">
        <label>${t('sellPriceLater')} (RWF) *</label>
        <input type="number" id="oth-upd-sellprice" min="1" value="${item.sellPrice || ''}" required placeholder="e.g. 2500" />
      </div>

      <div class="form-group">
        <label>${t('entryDate')} *</label>
        <input type="date" id="oth-upd-entrydate" value="${item.entryDate || getTodayStr()}" required />
      </div>

      <div class="form-group">
        <label>${t('soldOutDate')} (Optional)</label>
        <input type="date" id="oth-upd-soldout" value="${item.soldOutDate || ''}" />
      </div>
    </form>
  `;

  const footerHtml = `
    <button type="button" class="btn btn-secondary btn-sm" onclick="closeModal()">${t('cancel')}</button>
    <button type="submit" form="update-other-form" class="btn btn-primary btn-sm">${t('save')}</button>
  `;

  openModal(isRegistering ? 'Register Item for Sale' : 'Update Item Lifecycle', modalHtml, footerHtml);

  document.getElementById('update-other-form').onsubmit = (e) => {
    e.preventDefault();
    const sellPrice = parseFloat(document.getElementById('oth-upd-sellprice').value);
    const entryDate = document.getElementById('oth-upd-entrydate').value;
    const soldOutDate = document.getElementById('oth-upd-soldout').value;

    item.sellPrice = sellPrice;
    item.entryDate = entryDate;
    item.soldOutDate = soldOutDate;
    item.status = 'registered';

    saveDB();
    closeModal();
    showToast('Item updated successfully!', 'success');
    renderAdminOthers();
  };
}

/* ----------------------------------------------------------------------------
   Admin 9. Notifications
   Shows: promised-date extension requests (customer name, contact, amount owed, requested date)
   with Confirm, Change date, Decline.
   customers deleted by employees.
   reminders due now and upcoming.
   history by week or by specific day.
   ---------------------------------------------------------------------------- */
function renderAdminNotifications(filterMode = 'all', filterDate = '') {
  pageTitleEl.textContent = t('menuNotifications');

  const today = getTodayStr();

  // Extension requests for this branch
  let branchRequests = (db.extensionRequests || []).filter(r => r.branchId === state.branchId);

  // Deleted customers for this branch
  let branchDeleted = (db.deletedCustomersLog || []).filter(d => d.branchId === state.branchId);

  // Returns / Voided sales for this branch
  let branchReturns = (db.returns || []).filter(r => r.branchId === state.branchId);

  // Low Stock & Out-of-Stock alerts for this branch
  const branchProducts = (db.products || []).filter(p => p.branchId === state.branchId);
  const lowStockAlerts = branchProducts.filter(p => p.stock <= (p.minStockAlert !== undefined ? p.minStockAlert : 5));

  // History filtering (by week or by specific day)
  if (filterMode === 'week') {
    const d7 = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    branchRequests = branchRequests.filter(r => (r.createdAt || '') >= d7);
    branchDeleted = branchDeleted.filter(d => (d.date || '') >= d7);
    branchReturns = branchReturns.filter(r => (r.date || '') >= d7);
  } else if (filterMode === 'day' && filterDate) {
    branchRequests = branchRequests.filter(r => (r.createdAt || '') === filterDate);
    branchDeleted = branchDeleted.filter(d => (d.date || '') === filterDate);
    branchReturns = branchReturns.filter(r => (r.date || '') === filterDate);
  }

  // Reminders due now and upcoming
  const reminders = (db.customers || []).filter(c => {
    if (c.branchId !== state.branchId) return false;
    const debt = getCustomerDebt(c.id);
    return debt.remaining > 0 && c.newPromisedDate;
  }).map(c => {
    const debt = getCustomerDebt(c.id);
    const isDueToday = c.newPromisedDate === today;
    const isOverdue = c.newPromisedDate < today;
    return {
      customer: c,
      debtRemaining: debt.remaining,
      promisedDate: c.newPromisedDate,
      status: isOverdue ? 'overdue' : (isDueToday ? 'due_today' : 'upcoming')
    };
  });

  mainContent.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">🔔 ${t('menuNotifications')}</h2>
        <div class="page-subtitle">${escapeHtml(getActiveBranch().name)}</div>
      </div>
    </div>

    <!-- Filter Bar: All / Week / Specific Day -->
    <div class="card" style="padding: 0.75rem 1rem; margin-bottom: 1.25rem;">
      <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem;">
        <div class="tabs" style="margin-bottom: 0; border-bottom: none;">
          <button class="tab-btn ${filterMode === 'all' ? 'active' : ''}" id="tab-notif-all">
            📋 ${t('all')}
          </button>
          <button class="tab-btn ${filterMode === 'week' ? 'active' : ''}" id="tab-notif-week">
            📆 ${t('thisWeek')}
          </button>
        </div>

        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <label for="notif-date-picker" style="margin: 0; font-size: 0.85rem; white-space: nowrap;">
            📍 ${t('specificDay')}:
          </label>
          <input type="date" id="notif-date-picker" value="${filterDate || today}" style="width: auto; padding: 0.4rem 0.6rem;" />
        </div>
      </div>
    </div>

    <!-- 1. Low Stock & Out-of-Stock Restock Alerts -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">⚠️ ${t('restockAlerts')}</h3>
        <span class="tab-badge" style="background: ${lowStockAlerts.length > 0 ? 'var(--danger)' : 'var(--success)'}; color: #fff;">
          ${lowStockAlerts.length} items
        </span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('productName')}</th>
              <th>Current Stock</th>
              <th>Alert Threshold</th>
              <th>Status</th>
              <th>Supplier to Contact</th>
            </tr>
          </thead>
          <tbody>
            ${lowStockAlerts.length === 0 ? `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">✅ All inventory items are adequately stocked.</td></tr>` : ''}
            ${lowStockAlerts.map(p => {
              const displayName = p.name + (p.version ? ` (${p.version})` : '');
              const minAlert = p.minStockAlert !== undefined ? p.minStockAlert : 5;
              const isOut = p.stock <= 0;
              return `
                <tr>
                  <td><strong>${escapeHtml(displayName)}</strong></td>
                  <td><strong style="color: ${isOut ? 'var(--danger)' : 'var(--accent)'};">${p.stock} ${escapeHtml(p.unit)}</strong></td>
                  <td>${minAlert} ${escapeHtml(p.unit)}</td>
                  <td>
                    <span class="status-pill ${isOut ? 'status-out-of-stock' : 'status-low-stock'}">
                      ${isOut ? `❌ ${t('outOfStock')}` : `⚠️ ${t('lowStock')}`}
                    </span>
                  </td>
                  <td>
                    <strong>${escapeHtml(p.supplierName || 'Primary Supplier')}</strong>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 2. Customer Promised-Date Extension Requests -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">⏳ ${t('extensionRequestsTitle')}</h3>
        <span class="tab-badge">${branchRequests.filter(r => r.status === 'Waiting').length} Pending</span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Amount Owed</th>
              <th>Requested Date</th>
              <th>Current Status</th>
              <th style="text-align: right;">${t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            ${branchRequests.length === 0 ? `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No extension requests found.</td></tr>` : ''}
            ${branchRequests.map(r => `
              <tr>
                <td>
                  <strong>${escapeHtml(r.customerName)}</strong>
                  ${r.customerPhone ? `<br><small style="color:var(--text-muted);">${escapeHtml(r.customerPhone)}</small>` : ''}
                </td>
                <td><strong style="color: var(--danger);">${fmtMoney(r.amountOwed)}</strong></td>
                <td><strong>${escapeHtml(r.requestedDate)}</strong></td>
                <td>
                  <span class="status-pill status-${r.status.toLowerCase()}">${r.status}</span>
                  ${r.finalApprovedDate ? `<br><small>Final: ${r.finalApprovedDate}</small>` : ''}
                </td>
                <td style="text-align: right;">
                  ${r.status === 'Waiting' ? `
                    <div class="actions-cell" style="justify-content: flex-end;">
                      <button class="btn btn-success btn-sm btn-confirm-ext" data-id="${r.id}">
                        ✓ ${t('confirm')}
                      </button>
                      <button class="btn btn-secondary btn-sm btn-change-date-ext" data-id="${r.id}">
                        ✏️ ${t('changeDate')}
                      </button>
                      <button class="btn btn-danger btn-sm btn-decline-ext" data-id="${r.id}">
                        ✕ ${t('decline')}
                      </button>
                    </div>
                  ` : `
                    <small style="color: var(--text-muted);">Resolved</small>
                  `}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 3. Returns & Sale Cancellation (Voiding) Audit Log -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">🔄 Returns & Sale Voiding Log</h3>
        <span class="tab-badge">${branchReturns.length} returns</span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>Date & Time</th>
              <th>Customer</th>
              <th>Returned Items</th>
              <th>Refund Amount</th>
              <th>Reason</th>
              <th>Authorizer</th>
            </tr>
          </thead>
          <tbody>
            ${branchReturns.length === 0 ? `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No sales returns recorded.</td></tr>` : ''}
            ${branchReturns.map(ret => `
              <tr>
                <td>
                  <strong>${escapeHtml(ret.date)}</strong>
                  <br><small style="color:var(--text-muted);">${escapeHtml(ret.time || '')}</small>
                </td>
                <td><strong>${escapeHtml(ret.customerName || 'Walk-in')}</strong></td>
                <td>
                  <small>${(ret.items || []).map(i => `${i.quantity} ${escapeHtml(i.unit || '')} ${escapeHtml(i.productName)}`).join(', ')}</small>
                </td>
                <td><strong style="color: var(--danger);">-${fmtMoney(ret.totalRefund)}</strong></td>
                <td><small>${escapeHtml(ret.reason)}</small></td>
                <td><span class="status-pill status-paid">${escapeHtml(ret.voidedBy || 'Staff')}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 4. Customers Deleted by Employees Log -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">🗑️ ${t('deletedCustomersLogTitle')}</h3>
        <span class="tab-badge">${branchDeleted.length} records</span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('date')} & ${t('time')}</th>
              <th>Customer Name</th>
              <th>Contact Phone</th>
              <th>Deleted By</th>
            </tr>
          </thead>
          <tbody>
            ${branchDeleted.length === 0 ? `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No deleted customers logged.</td></tr>` : ''}
            ${branchDeleted.map(d => `
              <tr>
                <td>
                  <div>${escapeHtml(d.date)}</div>
                  <small style="color: var(--text-muted);">${escapeHtml(d.time || '')}</small>
                </td>
                <td><strong>${escapeHtml(d.name)}</strong></td>
                <td>${escapeHtml(d.phone || '-')}</td>
                <td><span class="status-pill status-overdue">${escapeHtml(d.deletedBy || 'Employee')}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 5. Credit Due Reminders -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">⏰ ${t('remindersTitle')}</h3>
        <span class="tab-badge">${reminders.length} Active</span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Contact</th>
              <th>Amount Remaining</th>
              <th>Promised Date</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${reminders.length === 0 ? `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No active debt reminders.</td></tr>` : ''}
            ${reminders.map(rem => `
              <tr>
                <td><strong>${escapeHtml(rem.customer.name)}</strong></td>
                <td>${escapeHtml(rem.customer.phone || '-')}</td>
                <td><strong style="color: var(--danger);">${fmtMoney(rem.debtRemaining)}</strong></td>
                <td><strong>${escapeHtml(rem.promisedDate)}</strong></td>
                <td>
                  ${rem.status === 'due_today' ? 
                    `<span class="status-pill status-overdue">🔔 Due Today</span>` : 
                    (rem.status === 'overdue' ? 
                      `<span class="status-pill status-overdue">⚠️ Overdue</span>` : 
                      `<span class="status-pill status-waiting">Upcoming</span>`
                    )
                  }
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('tab-notif-all').onclick = () => renderAdminNotifications('all');
  document.getElementById('tab-notif-week').onclick = () => renderAdminNotifications('week');

  const picker = document.getElementById('notif-date-picker');
  picker.onchange = (e) => {
    if (e.target.value) {
      renderAdminNotifications('day', e.target.value);
    }
  };

  // Extension request actions
  document.querySelectorAll('.btn-confirm-ext').forEach(btn => {
    btn.onclick = () => {
      const rid = btn.dataset.id;
      const req = db.extensionRequests.find(r => r.id === rid);
      if (!req) return;
      req.status = 'Approved';
      req.finalApprovedDate = req.requestedDate;
      const cust = db.customers.find(c => c.id === req.customerId);
      if (cust) cust.newPromisedDate = req.requestedDate;
      saveDB();
      showToast('Extension confirmed!', 'success');
      renderAdminNotifications(filterMode, filterDate);
    };
  });

  document.querySelectorAll('.btn-change-date-ext').forEach(btn => {
    btn.onclick = () => {
      const rid = btn.dataset.id;
      const req = db.extensionRequests.find(r => r.id === rid);
      if (!req) return;
      openModal(
        t('changeDate'),
        `
          <div class="form-group">
            <label>${t('newPromisedDate')} *</label>
            <input type="date" id="modal-change-ext-date" min="${today}" value="${req.requestedDate}" required />
          </div>
        `,
        `
          <button class="btn btn-secondary btn-sm" onclick="closeModal()">${t('cancel')}</button>
          <button class="btn btn-primary btn-sm" id="btn-save-change-date">Approve New Date</button>
        `
      );

      document.getElementById('btn-save-change-date').onclick = () => {
        const newD = document.getElementById('modal-change-ext-date').value;
        if (!newD) {
          showToast('Please select a valid future date', 'error');
          return;
        }
        req.status = 'Approved';
        req.finalApprovedDate = newD;
        const cust = db.customers.find(c => c.id === req.customerId);
        if (cust) cust.newPromisedDate = newD;
        saveDB();
        closeModal();
        showToast('Extension date adjusted & approved!', 'success');
        renderAdminNotifications(filterMode, filterDate);
      };
    };
  });

  document.querySelectorAll('.btn-decline-ext').forEach(btn => {
    btn.onclick = () => {
      const rid = btn.dataset.id;
      const req = db.extensionRequests.find(r => r.id === rid);
      if (!req) return;
      req.status = 'Declined';
      saveDB();
      showToast('Extension request declined', 'info');
      renderAdminNotifications(filterMode, filterDate);
    };
  });
}

function renderAdminSettings() {
  pageTitleEl.textContent = t('menuSettings');

  const currentBranch = getActiveBranch();
  if (!currentBranch.employees || currentBranch.employees.length === 0) {
    currentBranch.employees = [{ id: 'emp-1', name: 'Staff 1', pin: currentBranch.employeePassword || '1234' }];
  }

  mainContent.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">⚙️ ${t('menuSettings')}</h2>
        <div class="page-subtitle">${t('adminSettings')}</div>
      </div>
    </div>

    <!-- 1. Current Branch & Password Settings -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">🏢 Current Branch: ${escapeHtml(currentBranch.name)}</h3>
      </div>
      <form id="settings-current-branch-form">
        <div class="form-grid">
          <div class="form-group">
            <label>${t('currentBranchName')} *</label>
            <input type="text" id="set-branch-name" value="${escapeHtml(currentBranch.name)}" required />
          </div>

          <div class="form-group">
            <label>${t('branchEmployeePassword')} *</label>
            <input type="text" id="set-emp-pwd" value="${escapeHtml(currentBranch.employeePassword || '')}" required />
          </div>
        </div>

        <div style="margin-top: 1rem; border-top: 1px solid var(--border-light); padding-top: 1rem;">
          <h4 style="margin: 0 0 0.5rem 0;">🔐 Admin Master Password</h4>
          <div class="form-group" style="max-width: 400px;">
            <label>${t('adminPasswordLabel')}</label>
            <input type="password" id="set-admin-pwd" placeholder="Leave empty to keep current password" autocomplete="new-password" />
          </div>
        </div>

        <div style="margin-top: 1rem; display: flex; justify-content: flex-end;">
          <button type="submit" class="btn btn-primary">
            💾 ${t('save')} Changes
          </button>
        </div>
      </form>
    </div>

    <!-- 2. Branch Staff & Individual PINs Card -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">👥 ${t('branchEmployees')} (${escapeHtml(currentBranch.name)})</h3>
      </div>
      <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">
        Configure individual sellers and 4-digit PINs for this branch. Each employee signs in with their PIN, stamping their name on sales, returns, and daily closings.
      </p>

      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('sellerName')}</th>
              <th>4-Digit PIN</th>
              <th>Role</th>
              <th style="text-align: right;">${t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            ${(currentBranch.employees || []).map(emp => `
              <tr>
                <td><strong>${escapeHtml(emp.name)}</strong></td>
                <td><code>${escapeHtml(emp.pin)}</code></td>
                <td><span class="status-pill status-paid">${t('employee')}</span></td>
                <td style="text-align: right;">
                  <button class="btn btn-danger btn-sm btn-delete-emp" data-id="${emp.id}" title="${t('delete')}">
                    🗑️ ${t('delete')}
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <form id="add-employee-form" style="margin-top: 1.25rem; border-top: 1px solid var(--border-light); padding-top: 1rem;">
        <h4 style="margin: 0 0 0.75rem 0;">➕ ${t('addEmployee')}</h4>
        <div class="form-grid">
          <div class="form-group">
            <label>${t('sellerName')} *</label>
            <input type="text" id="new-emp-name" required placeholder="e.g. Marie Uwase" />
          </div>
          <div class="form-group">
            <label>${t('sellerPIN')} *</label>
            <input type="text" id="new-emp-pin" required maxlength="10" placeholder="e.g. 2026" />
          </div>
        </div>
        <div style="margin-top: 0.75rem; display: flex; justify-content: flex-end;">
          <button type="submit" class="btn btn-primary btn-sm">
            + ${t('addEmployee')}
          </button>
        </div>
      </form>
    </div>

    <!-- 3. Create New Branch -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">➕ ${t('addNewBranch')}</h3>
      </div>
      <form id="add-new-branch-form">
        <div class="form-grid">
          <div class="form-group">
            <label>${t('newBranchName')} *</label>
            <input type="text" id="new-branch-name" required placeholder="e.g. Musanze Outlet, Nyarugenge Branch" />
          </div>
          <div class="form-group">
            <label>${t('newBranchEmpPassword')} *</label>
            <input type="text" id="new-branch-pwd" required placeholder="Employee default password/PIN" />
          </div>
        </div>

        <div style="margin-top: 1rem; display: flex; justify-content: flex-end;">
          <button type="submit" class="btn btn-success">
            ✨ Create Branch
          </button>
        </div>
      </form>
    </div>

    <!-- 4. Existing Branches Overview -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">📋 Registered Branches (${db.settings.branches.length})</h3>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>Branch ID</th>
              <th>Branch Name</th>
              <th>Staff Roster</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${db.settings.branches.map(b => `
              <tr>
                <td><code>${escapeHtml(b.id)}</code></td>
                <td><strong>${escapeHtml(b.name)}</strong></td>
                <td>${(b.employees || []).length} Sellers</td>
                <td>
                  ${b.id === state.branchId ? 
                    `<span class="status-pill status-paid">Active Now</span>` : 
                    `<span class="status-pill status-waiting">Available</span>`
                  }
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 5. Cloud Sync (Multi-Device Access) -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">☁️ Cloud Sync (Multi-Device Access)</h3>
        <span class="status-pill ${cloudSync.enabled ? 'status-paid' : 'status-waiting'}">
          ${cloudSync.enabled ? '✅ Enabled' : '⚫ Local Only'}
        </span>
      </div>
      <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:1rem;">
        Connect to Firebase so the owner can view real-time sales, stock, and cash data from <strong>any device or browser</strong> — including their phone.
        The developer sets this up once per client using their Firebase project credentials.
      </p>
      ${cloudSync.enabled ? `
        <div style="background:var(--success-light,#d1fae5); padding:0.75rem; border-radius:var(--radius-sm,6px); margin-bottom:1rem; font-size:0.88rem;">
          ✅ Syncing as: <strong>${escapeHtml(cloudSync.companySlug)}</strong>
        </div>
        <button type="button" class="btn btn-danger btn-sm" id="btn-disconnect-cloud">🔌 Disconnect & Use Local Only</button>
      ` : `
        <form id="firebase-config-form">
          <div class="form-grid">
            <div class="form-group">
              <label>API Key *</label>
              <input type="text" id="fb-api-key" placeholder="AIzaSy..." required />
            </div>
            <div class="form-group">
              <label>Project ID *</label>
              <input type="text" id="fb-project-id" placeholder="my-shop-12345" required />
            </div>
            <div class="form-group">
              <label>Auth Domain *</label>
              <input type="text" id="fb-auth-domain" placeholder="my-shop-12345.firebaseapp.com" required />
            </div>
            <div class="form-group">
              <label>App ID *</label>
              <input type="text" id="fb-app-id" placeholder="1:xxx:web:xxx" required />
            </div>
            <div class="form-group full-width">
              <label>Sync Identifier (slug) *</label>
              <input type="text" id="fb-company-slug" value="${escapeHtml((db.settings.companyName||'my-shop').replace(/\s+/g,'-').toLowerCase())}" required />
              <small style="color:var(--text-muted)">Unique key for this business in Firestore. Use lowercase letters, numbers, and hyphens only.</small>
            </div>
          </div>
          <div style="margin-top:0.75rem; display:flex; justify-content:flex-end; gap:0.5rem; flex-wrap:wrap;">
            <a href="https://console.firebase.google.com/" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">📋 Open Firebase Console</a>
            <button type="submit" class="btn btn-primary btn-sm">☁️ Enable Cloud Sync</button>
          </div>
        </form>
      `}
    </div>

    <!-- 6. Data Backup, Export & Factory Reset -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">💾 System Data & Business Portability</h3>
      </div>
      <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 1rem;">
        You can export complete store data to a portable JSON backup file, restore from an existing backup, or reset this system to zero data for new client deployments.
      </p>

      <div style="display: flex; flex-wrap: wrap; gap: 0.75rem;">
        <button type="button" class="btn btn-primary" id="btn-export-backup">
          📥 Export Data Backup (JSON)
        </button>
        <button type="button" class="btn btn-secondary" id="btn-import-backup-trigger">
          📤 Restore Data Backup (JSON)
        </button>
        <input type="file" id="import-backup-input" accept=".json" style="display: none;" />
        <button type="button" class="btn btn-danger" id="btn-factory-reset">
          ⚠️ Factory Reset (Wipe All Data)
        </button>
      </div>
    </div>
  `;

  // 1. Current Branch form submit
  document.getElementById('settings-current-branch-form').onsubmit = (e) => {
    e.preventDefault();
    const newName = document.getElementById('set-branch-name').value.trim();
    const newEmpPwd = document.getElementById('set-emp-pwd').value.trim();
    const newAdminPwd = document.getElementById('set-admin-pwd').value.trim();

    if (newName) currentBranch.name = newName;
    if (newEmpPwd) currentBranch.employeePassword = newEmpPwd;
    if (newAdminPwd) db.settings.adminPassword = newAdminPwd;

    state.branchName = currentBranch.name;
    saveDB();
    storage.set(SESSION_KEY, state);
    showToast(t('settingsSaved'), 'success');
    refreshUI();
  };

  // 2. Add Employee to Current Branch
  document.getElementById('add-employee-form').onsubmit = (e) => {
    e.preventDefault();
    const name = document.getElementById('new-emp-name').value.trim();
    const pin = document.getElementById('new-emp-pin').value.trim();
    if (!name || !pin) return;

    if (!currentBranch.employees) currentBranch.employees = [];
    currentBranch.employees.push({
      id: 'emp-' + Date.now(),
      name,
      pin
    });

    saveDB();
    showToast(t('employeeAdded'), 'success');
    renderAdminSettings();
  };

  // Delete employee from branch
  document.querySelectorAll('.btn-delete-emp').forEach(btn => {
    btn.onclick = () => {
      const eid = btn.dataset.id;
      if (currentBranch.employees.length <= 1) {
        showToast(t('cannotDeleteLastEmployee'), 'error');
        return;
      }
      if (confirm('Remove this employee/PIN from the branch?')) {
        currentBranch.employees = currentBranch.employees.filter(emp => emp.id !== eid);
        saveDB();
        showToast(t('employeeDeleted'), 'info');
        renderAdminSettings();
      }
    };
  });

  // 3. Add New Branch form submit
  document.getElementById('add-new-branch-form').onsubmit = (e) => {
    e.preventDefault();
    const newName = document.getElementById('new-branch-name').value.trim();
    const newPwd = document.getElementById('new-branch-pwd').value.trim();

    const newBranch = {
      id: 'branch-' + Date.now(),
      name: newName,
      employeePassword: newPwd,
      employees: [
        { id: 'emp-' + Date.now(), name: 'Cashier 1', pin: newPwd || '1234' }
      ],
      createdAt: getTodayStr()
    };

    db.settings.branches.push(newBranch);
    saveDB();
    showToast(`${t('branchCreatedSuccess')}: ${newName}`, 'success');
    renderAdminSettings();
  };

  // 4. Data Backup Export
  document.getElementById('btn-export-backup').onclick = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(db, null, 2));
    const dlAnchor = document.createElement('a');
    dlAnchor.setAttribute('href', dataStr);
    dlAnchor.setAttribute('download', `shop-control-backup-${getTodayStr()}.json`);
    document.body.appendChild(dlAnchor);
    dlAnchor.click();
    dlAnchor.remove();
    showToast('Backup JSON exported successfully!', 'success');
  };

  // Data Backup Import
  const fileInput = document.getElementById('import-backup-input');
  document.getElementById('btn-import-backup-trigger').onclick = () => fileInput.click();
  fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = JSON.parse(event.target.result);
        if (imported && imported.settings && imported.products) {
          db = imported;
          saveDB();
          showToast('Database restored successfully from backup!', 'success');
          refreshUI();
        } else {
          showToast('Invalid backup file format.', 'error');
        }
      } catch (err) {
        showToast('Error reading JSON file: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  };

  // Factory Reset
  document.getElementById('btn-factory-reset').onclick = () => {
    if (confirm('CRITICAL: Reset all data? This will clear all sales, inventory, and customers, returning to a zero-data first-time setup state.')) {
      storage.remove(DB_KEY);
      storage.remove(SESSION_KEY);
      db = getBlankDatabase();
      state = { role: null, branchId: 'branch-1', branchName: 'Main Branch', activePage: 'products', loggedIn: false };
      showToast('System reset to zero data. Please configure your new business.', 'info');
      renderFirstTimeSetup();
    }
  };
}

function renderEmployeeProducts() {
  pageTitleEl.textContent = t('menuProducts');

  const branchProducts = db.products.filter(p => p.branchId === state.branchId);

  mainContent.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">📦 ${t('menuProducts')}</h2>
        <div class="page-subtitle">${escapeHtml(getActiveBranch().name)} (${t('viewOnly')})</div>
      </div>
    </div>

    <div class="card">
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('productName')}</th>
              <th>${t('stock')}</th>
              <th>${t('sellingPrice')}</th>
              <th>${t('dateAdded')}</th>
            </tr>
          </thead>
          <tbody>
            ${branchProducts.length === 0 ? `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No products registered yet.</td></tr>` : ''}
            ${branchProducts.map(p => {
              const displayName = p.name + (p.version ? ` (${p.version})` : '') + (p.batch ? ` [${p.batch}]` : '');
              const minAlert = p.minStockAlert !== undefined ? p.minStockAlert : 5;
              let stockBadge = '';
              if (p.stock <= 0) {
                stockBadge = `<span class="status-pill status-out-of-stock">❌ ${t('outOfStock')} (0 ${escapeHtml(p.unit)})</span>`;
              } else if (p.stock <= minAlert) {
                stockBadge = `<span class="status-pill status-low-stock">⚠️ ${t('lowStock')} (${p.stock} ${escapeHtml(p.unit)})</span>`;
              } else {
                stockBadge = `<span class="status-pill status-paid">✅ ${p.stock} ${escapeHtml(p.unit)}</span>`;
              }

              return `
                <tr>
                  <td><strong>${escapeHtml(displayName)}</strong></td>
                  <td>${stockBadge}</td>
                  <td><strong style="color: var(--primary); font-size: 1rem;">${fmtMoney(p.sellingPrice)}</strong></td>
                  <td>${escapeHtml(p.dateAdded || p.purchaseDate || '-')}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/* ----------------------------------------------------------------------------
   Employee 4. Sales (POS)
   Enter: customer (search or register: name letters only, phone up to 10 digits),
   product, container size for litres (20L to 0.5L) and how many, or quantity for other units,
   price per unit (editable), sale date, promised payment date (future only), paid now, payment channel.
   Shows: cart with line totals, total, stock limits. Time is saved automatically.
   ---------------------------------------------------------------------------- */
let employeeCart = [];

function renderEmployeeSales() {
  pageTitleEl.textContent = t('menuSales');

  const branchProducts = (db.products || []).filter(p => p.branchId === state.branchId);
  const branchCustomers = (db.customers || []).filter(c => c.branchId === state.branchId);
  const today = getTodayStr();

  // Today's sales in this branch
  const todaySales = (db.sales || []).filter(s => s.branchId === state.branchId && s.saleDate === today);

  const cartTotal = employeeCart.reduce((sum, item) => sum + item.lineTotal, 0);

  mainContent.innerHTML = `
    <div class="pos-layout">
      <!-- Left Column: Product Selection & Cart Entry -->
      <div>
        <!-- Customer Selection Card -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">👤 ${t('customer')}</h3>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-quick-reg-cust">
              ${t('registerCustomer')}
            </button>
          </div>
          <div class="form-group">
            <select id="pos-customer-select" required>
              <option value="">-- Choose Customer --</option>
              ${branchCustomers.map(c => `
                <option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.phone || '-')})</option>
              `).join('')}
            </select>
          </div>
        </div>

        <!-- Product & Quantity/Container Selection Card -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">📦 Select Item</h3>
          </div>
          <div class="form-grid">
            <div class="form-group full-width">
              <label>${t('productName')} *</label>
              <select id="pos-product-select">
                <option value="">-- Select Product in Stock --</option>
                ${branchProducts.map(p => {
                  const minAlert = p.minStockAlert !== undefined ? p.minStockAlert : 5;
                  const isOut = p.stock <= 0;
                  const isLow = !isOut && p.stock <= minAlert;
                  const alertLabel = isOut ? ` [❌ OUT OF STOCK (0 ${p.unit})]` : (isLow ? ` [⚠️ LOW STOCK: ${p.stock} left]` : ` (Stock: ${p.stock} ${p.unit})`);
                  return `
                    <option value="${p.id}" data-unit="${p.unit}" data-price="${p.sellingPrice}" data-stock="${p.stock}" ${isOut ? 'disabled style="color:var(--danger);"' : (isLow ? 'style="color:var(--accent);font-weight:700;"' : '')}>
                      ${escapeHtml(p.name)} ${p.version ? `(${escapeHtml(p.version)})` : ''} — ${fmtMoney(p.sellingPrice)}${alertLabel}
                    </option>
                  `;
                }).join('')}
              </select>
            </div>

            <!-- Dynamic Quantity or Container Size for Litres -->
            <div class="form-group full-width" id="pos-unit-input-container">
              <!-- Regular Qty or Litre Container picker -->
            </div>

            <!-- Editable Price per unit -->
            <div class="form-group">
              <label>${t('editablePrice')} (RWF) *</label>
              <input type="number" id="pos-editable-price" min="1" placeholder="Price" />
            </div>

            <div class="form-group" style="display: flex; align-items: flex-end;">
              <button type="button" class="btn btn-primary" id="btn-add-to-cart" style="width: 100%;">
                🛒 ${t('addToCart')}
              </button>
            </div>
          </div>
        </div>

        <!-- Cart Items Table -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">🛒 ${t('cart')}</h3>
            <span class="tab-badge">${employeeCart.length} items</span>
          </div>
          <div class="table-responsive">
            <table class="table">
              <thead>
                <tr>
                  <th>${t('productName')}</th>
                  <th>Quantity / Container</th>
                  <th>Unit Price</th>
                  <th>${t('lineTotal')}</th>
                  <th style="text-align: right;">${t('actions')}</th>
                </tr>
              </thead>
              <tbody id="cart-table-body">
                ${employeeCart.length === 0 ? `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">${t('emptyCart')}</td></tr>` : ''}
                ${employeeCart.map((item, idx) => `
                  <tr>
                    <td><strong>${escapeHtml(item.productName)}</strong></td>
                    <td>
                      ${item.containerSize ? 
                        `<span class="status-pill status-waiting">${item.containerCount} × ${item.containerSize}L (${item.quantity}L)</span>` : 
                        `<strong>${item.quantity} ${escapeHtml(item.unit)}</strong>`
                      }
                    </td>
                    <td>${fmtMoney(item.unitPrice)}</td>
                    <td><strong style="color: var(--primary);">${fmtMoney(item.lineTotal)}</strong></td>
                    <td style="text-align: right;">
                      <button class="btn btn-danger btn-sm btn-remove-cart" data-index="${idx}">✕</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Right Column: Finalize Sale Payment & Credit -->
      <div>
        <div class="card" style="position: sticky; top: 75px;">
          <div class="card-header">
            <h3 class="card-title">🧾 ${t('finalizeSale')}</h3>
          </div>

          <div class="cart-summary">
            <div class="cart-row">
              <span>Items Total:</span>
              <span id="pos-summary-items-total">${fmtMoney(cartTotal)}</span>
            </div>
            <div class="cart-total-row">
              <span>${t('grandTotal')}:</span>
              <span id="pos-summary-grand-total" style="color: var(--primary);">${fmtMoney(cartTotal)}</span>
            </div>
          </div>

          <form id="pos-finalize-form" style="margin-top: 1rem;">
            <!-- Sale Date -->
            <div class="form-group">
              <label>${t('saleDate')} *</label>
              <input type="date" id="pos-sale-date" value="${today}" max="${today}" required />
            </div>

            <!-- Payment Channel -->
            <div class="form-group">
              <label>${t('paymentChannel')} *</label>
              <select id="pos-channel" required>
                <option value="Cash">💵 Cash</option>
                <option value="MoMo">📱 MTN Mobile Money (MoMo)</option>
                <option value="Airtel Money">🔴 Airtel Money</option>
                <option value="Bank Transfer">🏦 Bank Transfer / POS</option>
              </select>
            </div>

            <!-- Paid Now -->
            <div class="form-group">
              <label>${t('paidNow')} (RWF) *</label>
              <input type="number" id="pos-paid-now" min="0" max="${cartTotal}" value="${cartTotal}" required />
            </div>

            <!-- Dynamic Credit Promised Payment Date -->
            <div id="pos-credit-container" style="display: none; background: var(--bg-subtle); padding: 0.85rem; border-radius: var(--radius-sm); margin-bottom: 1rem; border: 1px dashed var(--accent);">
              <div style="font-size: 0.85rem; margin-bottom: 0.5rem; color: var(--accent-text);">
                ⚠️ Unpaid balance: <strong id="pos-credit-amount">0 RWF</strong> (Credit)
              </div>
              <div class="form-group" style="margin-bottom: 0;">
                <label>${t('promisedPaymentDate')} * <span class="hint">(${t('futureOnly')})</span></label>
                <input type="date" id="pos-promised-date" min="${new Date(Date.now() + 86400000).toISOString().split('T')[0]}" />
              </div>
            </div>

            <button type="submit" class="btn btn-success" style="width: 100%; padding: 0.85rem;" ${employeeCart.length === 0 ? 'disabled' : ''}>
              ✅ ${t('finalizeSale')}
            </button>
          </form>
        </div>
      </div>
    </div>

    <!-- Today's Finalized Sales in this Branch -->
    <div class="card" style="margin-top: 1.5rem;">
      <div class="card-header">
        <h3 class="card-title">📋 Today's Branch Sales (${todaySales.length})</h3>
        <span class="status-pill status-paid">Logged as: ${escapeHtml(state.employeeName || 'Staff')}</span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Customer</th>
              <th>Items</th>
              <th>Total</th>
              <th>Paid</th>
              <th>Status / Sold By</th>
              <th style="text-align: right;">Action</th>
            </tr>
          </thead>
          <tbody>
            ${todaySales.length === 0 ? `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No sales recorded yet today.</td></tr>` : ''}
            ${todaySales.map(s => `
              <tr style="${s.isVoided ? 'opacity: 0.65; background: var(--bg-subtle);' : ''}">
                <td><strong>${escapeHtml(s.saleTime || '')}</strong></td>
                <td>
                  <strong>${escapeHtml(s.customerName || 'Walk-in')}</strong>
                  ${s.customerPhone ? `<br><small style="color:var(--text-muted);">${escapeHtml(s.customerPhone)}</small>` : ''}
                </td>
                <td>
                  <small>${(s.items || []).map(i => `${i.quantity} ${escapeHtml(i.unit || '')} ${escapeHtml(i.productName)}`).join(', ')}</small>
                </td>
                <td><strong>${fmtMoney(s.total)}</strong></td>
                <td><strong style="color: var(--success);">${fmtMoney(s.paidNow)}</strong></td>
                <td>
                  ${s.isVoided ? 
                    `<span class="status-pill status-voided">${t('voided')}</span><br><small style="color:var(--danger);">${escapeHtml(s.voidReason || '')}</small>` : 
                    `<span class="status-pill status-paid">Valid</span><br><small style="color:var(--text-muted);">By: ${escapeHtml(s.soldBy || 'Staff')}</small>`
                  }
                </td>
                <td style="text-align: right;">
                  ${!s.isVoided ? `
                    <button class="btn btn-danger btn-sm btn-void-sale" data-id="${s.id}">
                      🔄 ${t('voidSale')}
                    </button>
                  ` : `
                    <small style="color: var(--text-muted);">Voided</small>
                  `}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Quick Customer Registration
  document.getElementById('btn-quick-reg-cust').onclick = () => openRegisterCustomerModal();

  // Product Selection handler
  const prodSelect = document.getElementById('pos-product-select');
  const unitContainer = document.getElementById('pos-unit-input-container');
  const priceInput = document.getElementById('pos-editable-price');

  let selectedContainerSize = 20;

  function updateUnitInput() {
    const opt = prodSelect.selectedOptions[0];
    if (!opt || !opt.value) {
      unitContainer.innerHTML = '';
      priceInput.value = '';
      return;
    }

    const unit = opt.dataset.unit || '';
    const defPrice = opt.dataset.price || 0;
    const stock = parseFloat(opt.dataset.stock) || 0;

    priceInput.value = defPrice;

    const isLitre = unit.toLowerCase().includes('litre') || unit.toLowerCase() === 'l';

    if (isLitre) {
      unitContainer.innerHTML = `
        <label>${t('containerSize')} (Available Stock: ${stock} Litres)</label>
        <div class="chip-group" id="container-chips">
          ${[20, 10, 5, 2, 1, 0.5].map(sz => `
            <button type="button" class="chip-btn ${sz === selectedContainerSize ? 'selected' : ''}" data-size="${sz}">
              ${sz}L
            </button>
          `).join('')}
        </div>
        <div style="margin-top: 0.65rem;">
          <label>${t('containerCount')} *</label>
          <input type="number" id="pos-container-count" min="1" value="1" required />
        </div>
        <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.35rem;" id="pos-litre-calc-hint">
          Total Litres: ${selectedContainerSize} L
        </div>
      `;

      document.querySelectorAll('#container-chips .chip-btn').forEach(btn => {
        btn.onclick = () => {
          document.querySelectorAll('#container-chips .chip-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          selectedContainerSize = parseFloat(btn.dataset.size);
          recalcLitreHint();
        };
      });

      const countInput = document.getElementById('pos-container-count');
      function recalcLitreHint() {
        const count = parseFloat(countInput.value) || 0;
        const totalL = selectedContainerSize * count;
        document.getElementById('pos-litre-calc-hint').textContent = `Total Litres: ${totalL} L`;
      }
      countInput.oninput = recalcLitreHint;
    } else {
      unitContainer.innerHTML = `
        <label>${t('quantity')} (${escapeHtml(unit)}) * <span class="hint">(Stock: ${stock} ${escapeHtml(unit)})</span></label>
        <input type="number" id="pos-standard-qty" min="0.1" max="${stock}" step="any" value="1" required />
      `;
    }
  }

  prodSelect.onchange = updateUnitInput;

  // Add to cart button
  document.getElementById('btn-add-to-cart').onclick = () => {
    const opt = prodSelect.selectedOptions[0];
    if (!opt || !opt.value) {
      showToast('Please select a product first!', 'warning');
      return;
    }

    const prodId = opt.value;
    const prod = branchProducts.find(p => p.id === prodId);
    if (!prod) return;

    if (prod.stock <= 0) {
      showToast(t('outOfStock') + ' - Cannot add item with 0 stock!', 'error');
      return;
    }

    const unitPrice = parseFloat(priceInput.value);
    if (isNaN(unitPrice) || unitPrice <= 0) {
      showToast('Please enter a valid price per unit', 'error');
      return;
    }

    const isLitre = prod.unit.toLowerCase().includes('litre') || prod.unit.toLowerCase() === 'l';
    let qty = 0;
    let containerSize = null;
    let containerCount = null;

    if (isLitre) {
      containerCount = parseFloat(document.getElementById('pos-container-count').value);
      if (isNaN(containerCount) || containerCount <= 0) {
        showToast('Please enter a valid container count', 'error');
        return;
      }
      containerSize = selectedContainerSize;
      qty = containerSize * containerCount;
    } else {
      qty = parseFloat(document.getElementById('pos-standard-qty').value);
      if (isNaN(qty) || qty <= 0) {
        showToast('Please enter a valid quantity', 'error');
        return;
      }
    }

    const alreadyInCartQty = employeeCart
      .filter(item => item.productId === prod.id)
      .reduce((sum, item) => sum + item.quantity, 0);

    if (alreadyInCartQty + qty > prod.stock) {
      showToast(`${t('notEnoughStock')} (Max available: ${prod.stock - alreadyInCartQty} ${prod.unit})`, 'error');
      return;
    }

    const lineTotal = qty * unitPrice;

    employeeCart.push({
      productId: prod.id,
      productName: prod.name + (prod.version ? ` (${prod.version})` : ''),
      unit: prod.unit,
      containerSize,
      containerCount,
      quantity: qty,
      unitPrice,
      costPrice: prod.costPrice || 0,
      lineTotal
    });

    renderEmployeeSales();
  };

  // Remove from cart
  document.querySelectorAll('.btn-remove-cart').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.index);
      employeeCart.splice(idx, 1);
      renderEmployeeSales();
    };
  });

  // Credit calculation on Paid Now
  const paidNowInput = document.getElementById('pos-paid-now');
  const creditContainer = document.getElementById('pos-credit-container');
  const creditAmountEl = document.getElementById('pos-credit-amount');

  function updateCreditStatus() {
    const paid = parseFloat(paidNowInput.value) || 0;
    const remaining = cartTotal - paid;
    if (remaining > 0) {
      creditContainer.style.display = 'block';
      creditAmountEl.textContent = fmtMoney(remaining);
      const promInput = document.getElementById('pos-promised-date');
      if (promInput) promInput.required = true;
    } else {
      creditContainer.style.display = 'none';
      const promInput = document.getElementById('pos-promised-date');
      if (promInput) promInput.required = false;
    }
  }

  paidNowInput.oninput = updateCreditStatus;
  updateCreditStatus();

  // Finalize Sale Form
  document.getElementById('pos-finalize-form').onsubmit = (e) => {
    e.preventDefault();

    if (employeeCart.length === 0) {
      showToast(t('cartEmptyWarning'), 'warning');
      return;
    }

    const custId = document.getElementById('pos-customer-select').value;
    const customer = branchCustomers.find(c => c.id === custId);
    if (!customer) {
      showToast('Please select or register a customer for this sale.', 'error');
      return;
    }

    const saleDate = document.getElementById('pos-sale-date').value;
    const paidNow = parseFloat(paidNowInput.value) || 0;
    const channel = document.getElementById('pos-channel').value;
    const promised = document.getElementById('pos-promised-date') ? document.getElementById('pos-promised-date').value : '';

    const remainingDebt = Math.max(0, cartTotal - paidNow);

    if (remainingDebt > 0) {
      if (!promised || !isFutureDate(promised)) {
        showToast(t('promisedDateRequired'), 'error');
        return;
      }
    }

    // Deduct stock for each item in cart
    employeeCart.forEach(cartItem => {
      const prod = db.products.find(p => p.id === cartItem.productId);
      if (prod) {
        prod.stock = Math.max(0, prod.stock - cartItem.quantity);
      }
    });

    // Create Sale record with automatic time and staff name
    const newSale = {
      id: 'sale-' + Date.now(),
      branchId: state.branchId,
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
      items: [...employeeCart],
      total: cartTotal,
      paidNow,
      remainingDebt,
      saleDate,
      saleTime: getCurrentTimeStr(),
      paymentChannel: channel,
      promisedDate: remainingDebt > 0 ? promised : null,
      employeeRole: 'employee',
      soldBy: state.employeeName || 'Staff',
      soldById: state.employeeId || '',
      isVoided: false
    };

    db.sales.push(newSale);

    // Update Customer promised dates
    if (remainingDebt > 0 && promised) {
      if (!customer.firstPromisedDate) {
        customer.firstPromisedDate = promised;
      }
      customer.newPromisedDate = promised;
    }

    saveDB();
    employeeCart = [];
    showToast(t('saleSuccess'), 'success');
    renderEmployeeSales();
  };

  // Attach Void buttons for today's sales
  document.querySelectorAll('.btn-void-sale').forEach(btn => {
    btn.onclick = () => openVoidSaleModal(btn.dataset.id);
  });
}

function renderEmployeeCustomers(activeTab = 'all', searchQuery = '') {
  pageTitleEl.textContent = t('menuCustomers');

  const branchCustomers = db.customers.filter(c => c.branchId === state.branchId);

  let counts = { all: branchCustomers.length, partial: 0, paid: 0, overdue: 0 };
  const customerDebtMap = {};
  const today = getTodayStr();

  branchCustomers.forEach(c => {
    const debt = getCustomerDebt(c.id);
    customerDebtMap[c.id] = debt;
    if (debt.status === 'paid') counts.paid++;
    else if (debt.status === 'overdue') counts.overdue++;
    else if (debt.status === 'partial') counts.partial++;
  });

  const filteredCustomers = branchCustomers.filter(c => {
    const debt = customerDebtMap[c.id];
    if (activeTab === 'partial' && debt.status !== 'partial') return false;
    if (activeTab === 'paid' && debt.status !== 'paid') return false;
    if (activeTab === 'overdue' && debt.status !== 'overdue') return false;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return c.name.toLowerCase().includes(q) || (c.phone || '').includes(q);
    }
    return true;
  });

  mainContent.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">👥 ${t('menuCustomers')}</h2>
        <div class="page-subtitle">${escapeHtml(getActiveBranch().name)}</div>
      </div>
      <div>
        <button class="btn btn-primary" id="btn-employee-reg-cust">
          ${t('registerCustomer')}
        </button>
      </div>
    </div>

    <!-- Search bar -->
    <div class="search-bar">
      <div class="search-input-wrapper">
        <span class="search-icon">🔍</span>
        <input type="text" id="emp-cust-search" value="${escapeHtml(searchQuery)}" placeholder="${t('search')} (name, phone)..." />
      </div>
    </div>

    <!-- Tabs with counts -->
    <div class="tabs">
      <button class="tab-btn ${activeTab === 'all' ? 'active' : ''}" id="tab-emp-cust-all">
        ${t('all')} <span class="tab-badge">${counts.all}</span>
      </button>
      <button class="tab-btn ${activeTab === 'partial' ? 'active' : ''}" id="tab-emp-cust-partial">
        ${t('partiallyPaid')} <span class="tab-badge">${counts.partial}</span>
      </button>
      <button class="tab-btn ${activeTab === 'paid' ? 'active' : ''}" id="tab-emp-cust-paid">
        ${t('fullyPaid')} <span class="tab-badge">${counts.paid}</span>
      </button>
      <button class="tab-btn ${activeTab === 'overdue' ? 'active' : ''}" id="tab-emp-cust-overdue">
        ${t('overdue')} <span class="tab-badge">${counts.overdue}</span>
      </button>
    </div>

    <!-- Customers List -->
    <div class="card">
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('customer')}</th>
              <th>${t('status')}</th>
              <th>${t('totalDebt')}</th>
              <th>${t('paid')}</th>
              <th>${t('remaining')}</th>
              <th>${t('firstPromisedDate')}</th>
              <th>${t('newPromisedDate')}</th>
              <th style="text-align: right;">${t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            ${filteredCustomers.length === 0 ? `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No customers found.</td></tr>` : ''}
            ${filteredCustomers.map(c => {
              const d = customerDebtMap[c.id];
              let statusClass = 'status-paid';
              let statusLabel = t('fullyPaid');
              if (d.status === 'overdue') {
                statusClass = 'status-overdue';
                statusLabel = t('overdue');
              } else if (d.status === 'partial') {
                statusClass = 'status-partial';
                statusLabel = t('partiallyPaid');
              }

              // Extension request condition: enabled ONLY when promised date has been reached (today >= promised date) AND remaining > 0
              const canRequestExtension = d.remaining > 0 && c.newPromisedDate && today >= c.newPromisedDate;

              return `
                <tr>
                  <td>
                    <strong>${escapeHtml(c.name)}</strong>
                    <div style="font-size: 0.78rem; color: var(--text-muted);">${escapeHtml(c.phone || '-')}</div>
                  </td>
                  <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
                  <td>${fmtMoney(d.totalDebt)}</td>
                  <td><span style="color: var(--success);">${fmtMoney(d.paid)}</span></td>
                  <td><strong style="color: ${d.remaining > 0 ? 'var(--danger)' : 'inherit'};">${fmtMoney(d.remaining)}</strong></td>
                  <td>${escapeHtml(c.firstPromisedDate || '-')}</td>
                  <td><strong>${escapeHtml(c.newPromisedDate || '-')}</strong></td>
                  <td style="text-align: right;">
                    <div class="actions-cell" style="justify-content: flex-end;">
                      <!-- Record payment -->
                      ${d.remaining > 0 ? `
                        <button class="btn btn-success btn-sm btn-record-cust-pay" data-id="${c.id}" title="${t('recordPayment')}">
                          💵 Pay
                        </button>
                      ` : ''}

                      <!-- Extension request button -->
                      <button class="btn btn-warning btn-sm btn-request-extension" data-id="${c.id}" ${canRequestExtension ? '' : 'disabled title="' + t('extensionOnlyWhenReached') + '"'}>
                        ⏳ Extend Date
                      </button>

                      <!-- History -->
                      <button class="btn btn-secondary btn-sm btn-view-cust-history" data-id="${c.id}">
                        👁️ History
                      </button>

                      <!-- Delete Customer (only if no credit) -->
                      <button class="btn btn-danger btn-sm btn-delete-customer" data-id="${c.id}" title="${t('delete')}">
                        🗑️
                      </button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('tab-emp-cust-all').onclick = () => renderEmployeeCustomers('all', searchQuery);
  document.getElementById('tab-emp-cust-partial').onclick = () => renderEmployeeCustomers('partial', searchQuery);
  document.getElementById('tab-emp-cust-paid').onclick = () => renderEmployeeCustomers('paid', searchQuery);
  document.getElementById('tab-emp-cust-overdue').onclick = () => renderEmployeeCustomers('overdue', searchQuery);
  document.getElementById('btn-employee-reg-cust').onclick = () => openRegisterCustomerModal();

  const searchInput = document.getElementById('emp-cust-search');
  searchInput.oninput = (e) => {
    renderEmployeeCustomers(activeTab, e.target.value);
  };

  document.querySelectorAll('.btn-view-cust-history').forEach(btn => {
    btn.onclick = () => openCustomerHistoryModal(btn.dataset.id);
  });

  // Record Payment
  document.querySelectorAll('.btn-record-cust-pay').forEach(btn => {
    btn.onclick = () => openRecordCustomerPaymentModal(btn.dataset.id);
  });

  // Request Extension
  document.querySelectorAll('.btn-request-extension').forEach(btn => {
    btn.onclick = () => openEmployeeExtensionRequestModal(btn.dataset.id);
  });

  // Delete Customer (Strict check: Allowed only if no credit; admin is notified!)
  document.querySelectorAll('.btn-delete-customer').forEach(btn => {
    btn.onclick = () => {
      const custId = btn.dataset.id;
      const customer = db.customers.find(c => c.id === custId);
      if (!customer) return;

      const debt = getCustomerDebt(custId);
      if (debt.remaining > 0) {
        showToast(t('cannotDeleteCustomerDebt'), 'error');
        return;
      }

      if (confirm(`Delete customer "${customer.name}"? Customer has zero outstanding credit. Admin will be notified.`)) {
        // Log deletion to deletedCustomersLog for Admin Notifications
        db.deletedCustomersLog.push({
          id: 'del-' + Date.now(),
          branchId: state.branchId,
          customerName: customer.name,
          customerPhone: customer.phone,
          deletedBy: 'employee',
          date: getTodayStr(),
          time: getCurrentTimeStr(),
          reason: 'Removed by employee with zero debt balance'
        });

        db.customers = db.customers.filter(c => c.id !== custId);
        saveDB();
        showToast(t('customerDeletedSuccess'), 'success');
        renderEmployeeCustomers(activeTab, searchQuery);
      }
    };
  });
}

function openRecordCustomerPaymentModal(customerId) {
  const customer = db.customers.find(c => c.id === customerId);
  if (!customer) return;
  const debt = getCustomerDebt(customerId);

  const modalHtml = `
    <form id="record-customer-pay-form">
      <div style="margin-bottom: 1rem; padding: 0.75rem; background: var(--bg-subtle); border-radius: var(--radius-md);">
        <div>Customer: <strong>${escapeHtml(customer.name)}</strong> (${escapeHtml(customer.phone)})</div>
        <div>Current Remaining Debt: <strong style="color: var(--danger); font-size: 1.1rem;">${fmtMoney(debt.remaining)}</strong></div>
      </div>

      <div class="form-group">
        <label>${t('paymentAmount')} (RWF) *</label>
        <input type="number" id="cpay-amount" min="1" max="${debt.remaining}" required placeholder="Amount" />
      </div>

      <div class="form-group">
        <label>${t('date')} *</label>
        <input type="date" id="cpay-date" value="${getTodayStr()}" required />
      </div>

      <div class="form-group">
        <label>${t('paymentChannel')} *</label>
        <select id="cpay-channel">
          <option value="Cash">Cash</option>
          <option value="MoMo">Mobile Money (MoMo)</option>
          <option value="Bank Transfer">Bank Transfer</option>
          <option value="Card">Card</option>
        </select>
      </div>

      <div class="form-group">
        <label>Notes (Optional)</label>
        <input type="text" id="cpay-notes" placeholder="e.g. Cleared invoice / partial deposit" />
      </div>
    </form>
  `;

  const footerHtml = `
    <button type="button" class="btn btn-secondary btn-sm" onclick="closeModal()">${t('cancel')}</button>
    <button type="submit" form="record-customer-pay-form" class="btn btn-primary btn-sm">${t('save')}</button>
  `;

  openModal(`${t('recordPayment')}: ${escapeHtml(customer.name)}`, modalHtml, footerHtml);

  document.getElementById('record-customer-pay-form').onsubmit = (e) => {
    e.preventDefault();
    const amount = parseFloat(document.getElementById('cpay-amount').value);
    const date = document.getElementById('cpay-date').value;
    const channel = document.getElementById('cpay-channel').value;
    const notes = document.getElementById('cpay-notes').value.trim();

    if (isNaN(amount) || amount <= 0) {
      showToast('Enter a valid payment amount', 'error');
      return;
    }

    const newPayment = {
      id: 'cpay-' + Date.now(),
      customerId: customer.id,
      branchId: state.branchId,
      amount,
      date,
      time: getCurrentTimeStr(),
      channel,
      notes,
      createdAt: getTodayStr()
    };

    db.customerPayments.push(newPayment);
    saveDB();
    closeModal();
    showToast('Payment recorded successfully! Debt updated.', 'success');
    renderEmployeeCustomers();
  };
}

function openEmployeeExtensionRequestModal(customerId) {
  const customer = db.customers.find(c => c.id === customerId);
  if (!customer) return;
  const debt = getCustomerDebt(customerId);

  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  const modalHtml = `
    <form id="extension-request-form">
      <div style="margin-bottom: 1rem; padding: 0.75rem; background: var(--bg-subtle); border-radius: var(--radius-md);">
        <div>Customer Name: <strong>${escapeHtml(customer.name)}</strong></div>
        <div>Contact: <strong>${escapeHtml(customer.phone)}</strong></div>
        <div>Amount Owed: <strong style="color: var(--danger);">${fmtMoney(debt.remaining)}</strong></div>
        <div>Current Promised Date: <strong>${escapeHtml(customer.newPromisedDate || 'Reached')}</strong></div>
      </div>

      <div class="form-group">
        <label>${t('requestedDate')} * <span class="hint">(Must be a future date)</span></label>
        <input type="date" id="ext-req-date" min="${tomorrowStr}" required />
      </div>

      <div class="form-group">
        <label>${t('extensionReason')} (Optional)</label>
        <textarea id="ext-req-reason" rows="3" placeholder="Reason given by customer for extending payment date..."></textarea>
      </div>
    </form>
  `;

  const footerHtml = `
    <button type="button" class="btn btn-secondary btn-sm" onclick="closeModal()">${t('cancel')}</button>
    <button type="submit" form="extension-request-form" class="btn btn-warning btn-sm">Send Request to Admin</button>
  `;

  openModal(`${t('requestExtension')}: ${escapeHtml(customer.name)}`, modalHtml, footerHtml);

  document.getElementById('extension-request-form').onsubmit = (e) => {
    e.preventDefault();
    const reqDate = document.getElementById('ext-req-date').value;
    const reason = document.getElementById('ext-req-reason').value.trim();

    if (!isFutureDate(reqDate)) {
      showToast('Requested date must be in the future!', 'error');
      return;
    }

    const request = {
      id: 'req-' + Date.now(),
      branchId: state.branchId,
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
      amountOwed: debt.remaining,
      currentPromisedDate: customer.newPromisedDate,
      requestedDate: reqDate,
      reason,
      status: 'Waiting',
      finalApprovedDate: null,
      createdAt: getTodayStr()
    };

    db.extensionRequests.push(request);
    saveDB();
    closeModal();
    showToast('Extension request sent to Admin Notifications!', 'success');
    renderEmployeeCustomers();
  };
}

/* ----------------------------------------------------------------------------
   Employee 6. Purchases (Expenses / Petty Cash)
   Enter: action done and its amount.
   Shows: total used today and the list with date and time (these amounts reduce the admin's net cash).
   ---------------------------------------------------------------------------- */
function renderEmployeePurchases() {
  pageTitleEl.textContent = t('employeeExpensesTitle');

  const today = getTodayStr();

  // All expenses for current branch
  const branchExpenses = db.employeeExpenses.filter(e => e.branchId === state.branchId);

  // Filter today's expenses
  const todayExpenses = branchExpenses.filter(e => e.date === today);
  const totalUsedToday = todayExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);

  mainContent.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">💸 ${t('recordEmployeePurchase')}</h2>
        <div class="page-subtitle">${escapeHtml(getActiveBranch().name)} (Petty cash & store purchases)</div>
      </div>
    </div>

    <!-- Expense Entry Form Card -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">📝 Record Daily Expense</h3>
      </div>
      <form id="employee-expense-form">
        <div class="form-grid">
          <div class="form-group full-width">
            <label>${t('actionDone')} * <span class="hint">(${t('expenseReason')})</span></label>
            <input type="text" id="exp-action-done" required placeholder="e.g. Motorcycle transport for goods, store cleaning detergents, receipt books..." />
          </div>

          <div class="form-group">
            <label>${t('amount')} (RWF) *</label>
            <input type="number" id="exp-amount" min="1" required placeholder="e.g. 5000" />
          </div>

          <div class="form-group" style="display: flex; align-items: flex-end;">
            <button type="submit" class="btn btn-primary" style="width: 100%;">
              💾 Record Expense
            </button>
          </div>
        </div>
      </form>
    </div>

    <!-- Total Used Today Banner Card -->
    <div class="card" style="background: var(--bg-subtle);">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem;">
        <div>
          <div style="font-size: 0.85rem; color: var(--text-muted); font-weight: 600; text-transform: uppercase;">
            ${t('totalUsedToday')} (${today})
          </div>
          <div style="font-size: 1.8rem; font-weight: 700; color: var(--danger);">
            ${fmtMoney(totalUsedToday)}
          </div>
        </div>
        <div style="color: var(--text-muted); font-size: 0.82rem; max-width: 320px;">
          ℹ️ These expenses are automatically deducted from the shop's Net Cash in the Admin's Shop Control dashboard.
        </div>
      </div>
    </div>

    <!-- Purchases History List with Date & Time -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">📜 Expense History</h3>
        <span class="badge-branch">${branchExpenses.length} entries</span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('date')} & ${t('time')}</th>
              <th>${t('actionDone')}</th>
              <th style="text-align: right;">${t('amount')}</th>
            </tr>
          </thead>
          <tbody>
            ${branchExpenses.length === 0 ? `<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">No expenses recorded yet.</td></tr>` : ''}
            ${branchExpenses.slice().reverse().map(e => `
              <tr>
                <td>
                  <div><strong>${escapeHtml(e.date)}</strong></div>
                  <small style="color: var(--text-muted);">${escapeHtml(e.time || '')}</small>
                </td>
                <td><strong>${escapeHtml(e.actionDone)}</strong></td>
                <td style="text-align: right; color: var(--danger); font-weight: 700;">
                  -${fmtMoney(e.amount)}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('employee-expense-form').onsubmit = (e) => {
    e.preventDefault();
    const actionDone = document.getElementById('exp-action-done').value.trim();
    const amount = parseFloat(document.getElementById('exp-amount').value);

    if (isNaN(amount) || amount <= 0) {
      showToast('Please enter a valid expense amount', 'error');
      return;
    }

    const newExpense = {
      id: 'exp-' + Date.now(),
      branchId: state.branchId,
      actionDone,
      amount,
      date: getTodayStr(),
      time: getCurrentTimeStr(),
      createdAt: getTodayStr()
    };

    db.employeeExpenses.push(newExpense);
    saveDB();
    showToast(t('expenseSavedSuccess'), 'success');
    renderEmployeePurchases();
  };
}

/* ----------------------------------------------------------------------------
   Employee 7. Notifications
   Shows: reminders at 10:00 on the promised date (name, contact, amount),
   requests sent and their status (Waiting, Approved with the final date, Declined),
   history by week or by specific day.
   ---------------------------------------------------------------------------- */
function renderEmployeeNotifications(filterMode = 'all', filterDate = '') {
  pageTitleEl.textContent = t('menuNotifications');

  const today = getTodayStr();

  // Requests sent by employee
  let myRequests = db.extensionRequests.filter(r => r.branchId === state.branchId);

  // History filtering
  if (filterMode === 'week') {
    const d7 = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    myRequests = myRequests.filter(r => (r.createdAt || '') >= d7);
  } else if (filterMode === 'day' && filterDate) {
    myRequests = myRequests.filter(r => (r.createdAt || '') === filterDate);
  }

  // Reminders at 10:00 on the promised date
  const reminders = db.customers.filter(c => {
    if (c.branchId !== state.branchId) return false;
    const debt = getCustomerDebt(c.id);
    return debt.remaining > 0 && c.newPromisedDate;
  }).map(c => {
    const debt = getCustomerDebt(c.id);
    const isToday = c.newPromisedDate === today;
    const isOverdue = c.newPromisedDate < today;
    return {
      customer: c,
      debt: debt.remaining,
      date: c.newPromisedDate,
      isToday,
      isOverdue
    };
  }).filter(r => r.isToday || r.isOverdue)
    .sort((a, b) => a.date.localeCompare(b.date));

  mainContent.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">🔔 ${t('menuNotifications')}</h2>
        <div class="page-subtitle">${escapeHtml(getActiveBranch().name)}</div>
      </div>
    </div>

    <!-- History Filter Bar -->
    <div class="card" style="padding: 0.75rem 1rem;">
      <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem;">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <span style="font-size: 0.88rem; font-weight: 600;">${t('historyFilter')}:</span>
          <button class="btn btn-sm ${filterMode === 'all' ? 'btn-primary' : 'btn-secondary'}" id="btn-emp-hist-all">
            ${t('all')}
          </button>
          <button class="btn btn-sm ${filterMode === 'week' ? 'btn-primary' : 'btn-secondary'}" id="btn-emp-hist-week">
            ${t('byWeek')}
          </button>
        </div>

        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <label for="emp-hist-day" style="margin: 0; font-size: 0.85rem;">${t('bySpecificDay')}:</label>
          <input type="date" id="emp-hist-day" value="${filterDate || today}" style="width: auto; padding: 0.35rem 0.5rem;" />
        </div>
      </div>
    </div>

    <!-- 1. Reminders at 10:00 on Promised Date -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">⏰ Reminders at 10:00 on Promised Date</h3>
        <span class="tab-badge" style="background: var(--danger); color: #fff;">${reminders.length} Active</span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('customer')}</th>
              <th>Contact</th>
              <th>Amount Owed</th>
              <th>Promised Date</th>
              <th>Reminder Status</th>
            </tr>
          </thead>
          <tbody>
            ${reminders.length === 0 ? `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No payment reminders due today.</td></tr>` : ''}
            ${reminders.map(rem => `
              <tr>
                <td><strong>${escapeHtml(rem.customer.name)}</strong></td>
                <td>${escapeHtml(rem.customer.phone || '-')}</td>
                <td><strong style="color: var(--danger);">${fmtMoney(rem.debt)}</strong></td>
                <td><strong>${escapeHtml(rem.date)}</strong></td>
                <td>
                  ${rem.isToday ? 
                    `<span class="status-pill status-partial">🔔 Reminder Due Today (10:00)</span>` : 
                    `<span class="status-pill status-overdue">🚨 Overdue since ${escapeHtml(rem.date)}</span>`
                  }
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 2. Requests Sent & Their Status -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">📩 Extension Requests Sent & Status</h3>
        <span class="tab-badge">${myRequests.length}</span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>${t('customer')}</th>
              <th>Amount Owed</th>
              <th>Original Promised Date</th>
              <th>Requested Date</th>
              <th>Status</th>
              <th>Final Approved Date</th>
            </tr>
          </thead>
          <tbody>
            ${myRequests.length === 0 ? `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No extension requests sent.</td></tr>` : ''}
            ${myRequests.slice().reverse().map(r => {
              let statusPill = `<span class="status-pill status-waiting">Waiting</span>`;
              if (r.status === 'Approved') statusPill = `<span class="status-pill status-paid">Approved</span>`;
              if (r.status === 'Declined') statusPill = `<span class="status-pill status-overdue">Declined</span>`;

              return `
                <tr>
                  <td>
                    <strong>${escapeHtml(r.customerName)}</strong>
                    <div style="font-size: 0.78rem; color: var(--text-muted);">${escapeHtml(r.customerPhone || '')}</div>
                  </td>
                  <td>${fmtMoney(r.amountOwed)}</td>
                  <td>${escapeHtml(r.currentPromisedDate)}</td>
                  <td><strong>${escapeHtml(r.requestedDate)}</strong></td>
                  <td>${statusPill}</td>
                  <td>
                    ${r.status === 'Approved' ? 
                      `<strong style="color: var(--success);">${escapeHtml(r.finalApprovedDate || r.requestedDate)}</strong>` : 
                      (r.status === 'Declined' ? `<span style="color: var(--danger); font-size: 0.85rem;">Declined by Admin</span>` : `<span style="color: var(--text-muted);">Awaiting response...</span>`)
                    }
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('btn-emp-hist-all').onclick = () => renderEmployeeNotifications('all');
  document.getElementById('btn-emp-hist-week').onclick = () => renderEmployeeNotifications('week');

  const picker = document.getElementById('emp-hist-day');
  picker.onchange = (e) => {
    if (e.target.value) renderEmployeeNotifications('day', e.target.value);
  };
}

/* ----------------------------------------------------------------------------
   10. Online / Offline Indicator & Startup Initialization
   ---------------------------------------------------------------------------- */
function updateOnlineStatus() {
  const dot = document.getElementById('online-indicator');
  if (dot) {
    if (cloudSync.enabled) {
      // Cloud sync handles the dot color; just reflect offline if no internet
      if (!navigator.onLine) cloudSync._setStatus('offline');
    } else {
      dot.className = navigator.onLine ? 'dot green' : 'dot red';
      dot.title = navigator.onLine ? 'Online (local only)' : 'Offline Mode (Local Storage Active)';
    }
  }
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

// Apply Theme and Language
applyTheme(currentTheme);
applyLang(currentLang);

// Start Application
function initApp() {
  if (!db || !db.settings || !db.settings.isConfigured) {
    renderFirstTimeSetup();
  } else if (state.loggedIn) {
    setupDrawerMenu();
    loadPage(state.activePage || (state.role === 'admin' ? 'products' : 'sales'));
  } else {
    renderLogin();
  }
}

// Expose helpers for testing & devtools
window.storage = storage;
window.db = db;
window.saveDB = saveDB;
window.cloudSync = cloudSync;
window.getCustomerDebt = getCustomerDebt;
window.getSupplierDebt = getSupplierDebt;
window.validateName = validateName;
window.validatePhone = validatePhone;
window.validateDigitsOnly = validateDigitsOnly;
window.validateTIN = validateTIN;
window.isFutureDate = isFutureDate;
window.fmtMoney = fmtMoney;

// Auto-init cloud sync if previously configured by developer
(async function autoInitCloudSync() {
  const cfg = storage.get(FIREBASE_CONFIG_KEY);
  if (cfg && cfg.apiKey && typeof firebase !== 'undefined') {
    const { companySlug, ...firebaseConfig } = cfg;
    const slug = companySlug || (db.settings.companyName || 'shop').replace(/\s+/g, '-').toLowerCase();
    const ok = await cloudSync.init(firebaseConfig, slug);
    if (ok) {
      const pulled = await cloudSync.pull();
      if (pulled && typeof refreshUI === 'function') refreshUI();
    }
  }
})();

initApp();
