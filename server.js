require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, "data.json");
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-too";

// ---------- tiny JSON "database" ----------
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const fresh = { employees: [], managers: [], sales: [], ownerPinHash: null };
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  if (!db.managers) db.managers = [];
  return db;
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function hash(pin) {
  return crypto.createHash("sha256").update(String(pin)).digest("hex");
}
function newId() {
  return crypto.randomBytes(8).toString("hex");
}
function monthKey(dateStr) {
  return (dateStr || "").slice(0, 7);
}
function dateRangeFor(query) {
  const period = query.period || "month";
  const ref = query.date ? new Date(query.date) : new Date();
  let start, end;
  if (period === "day") {
    const d = query.date || new Date().toISOString().slice(0, 10);
    start = d + "T00:00:00.000Z";
    end = d + "T23:59:59.999Z";
  } else if (period === "week") {
    const day = ref.getUTCDay(); // 0=Sun
    const monday = new Date(ref);
    monday.setUTCDate(ref.getUTCDate() - ((day + 6) % 7));
    monday.setUTCHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    sunday.setUTCHours(23, 59, 59, 999);
    start = monday.toISOString();
    end = sunday.toISOString();
  } else if (period === "payperiod") {
    // Your biweekly pay period: 14 days ending on the payroll-processing Tuesday you pick,
    // starting the Wednesday 13 days before it.
    const endDate = query.date ? new Date(query.date + "T23:59:59.999Z") : new Date();
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - 13);
    startDate.setUTCHours(0, 0, 0, 0);
    start = startDate.toISOString();
    end = endDate.toISOString();
  } else if (period === "year") {
    const y = query.date ? query.date.slice(0, 4) : String(ref.getUTCFullYear());
    start = `${y}-01-01T00:00:00.000Z`;
    end = `${y}-12-31T23:59:59.999Z`;
  } else {
    // month
    const m = query.month || new Date().toISOString().slice(0, 7);
    start = `${m}-01T00:00:00.000Z`;
    const [y, mo] = m.split("-").map(Number);
    const lastDay = new Date(y, mo, 0).getDate();
    end = `${m}-${String(lastDay).padStart(2, "0")}T23:59:59.999Z`;
  }
  return { start, end };
}
function inRange(dateStr, start, end) {
  if (!dateStr) return false;
  return dateStr >= start && dateStr <= end;
}
function saleUpsellTotal(sale) {
  return (sale.upsells || []).reduce((a, u) => a + (parseFloat(u.price) || 0), 0);
}
function saleTotal(sale) {
  return (parseFloat(sale.basePrice) || 0) + saleUpsellTotal(sale);
}

function upsertSaleFromGHL(db, { date, customerName, customerPhone, customerEmail, car, employeeName, baseService, basePrice, ghlOpportunityId }) {
  // employeeName can be a single tech or several, e.g. "Jordan Smith, Sam Rivera" —
  // this is how tag-teamed jobs (multiple techs on one car) get represented.
  const rawNames = String(employeeName || "").split(/[,&]/).map((n) => n.trim()).filter(Boolean);
  const matched = [];
  const unmatched = [];
  rawNames.forEach((n) => {
    const emp = db.employees.find((e) => e.name.toLowerCase() === n.toLowerCase());
    if (emp) matched.push(emp);
    else if (n) unmatched.push(n);
  });

  let sale = db.sales.find((s) => s.ghlOpportunityId === ghlOpportunityId);
  if (!sale) {
    sale = { id: newId(), ghlOpportunityId, upsells: [], status: "pending", completed: false, paid: false };
    db.sales.push(sale);
  }
  sale.date = date || sale.date || new Date().toISOString();
  sale.customerName = customerName || sale.customerName || "";
  sale.customerPhone = customerPhone || sale.customerPhone || "";
  sale.customerEmail = customerEmail || sale.customerEmail || "";
  sale.car = car || sale.car || "";
  sale.employeeIds = matched.map((e) => e.id);
  sale.employeeNames = matched.map((e) => e.name).concat(unmatched.map((n) => n + " (unmatched)")).join(", ") || "Unassigned";
  sale.baseService = baseService || sale.baseService || "";
  sale.basePrice = basePrice !== undefined ? parseFloat(basePrice) || 0 : sale.basePrice || 0;
  sale.syncedFromGHL = true;
  if (!sale.status) sale.status = "pending";
  if (sale.completed === undefined) sale.completed = false;
  if (sale.paid === undefined) sale.paid = false;
  return sale;
}

// Backward/forward-compatible accessor: some records may still use the old single employeeId shape.
function saleEmployeeIds(sale) {
  if (sale.employeeIds) return sale.employeeIds;
  return sale.employeeId ? [sale.employeeId] : [];
}
// Every upsell knows who personally sold it (employeeId OR managerId) — this resolves that
// into an actual display name so anyone looking at a job can see who upsold what.
function resolveUpsellNames(upsells, db) {
  return (upsells || []).map((u) => {
    let name = "Unassigned";
    if (u.employeeId) name = (db.employees.find((e) => e.id === u.employeeId) || {}).name || "Removed employee";
    else if (u.managerId) name = (db.managers.find((m) => m.id === u.managerId) || {}).name || "Removed manager";
    return { ...u, attributedToName: name };
  });
}

// ---------- app setup ----------
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const AUTH_COOKIE = "sbn_auth";
const AUTH_MAX_AGE = 1000 * 60 * 60 * 24 * 365; // 1 year — stays logged in on a phone indefinitely

function toBase64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}
function signAuth(payload) {
  const data = toBase64Url(Buffer.from(JSON.stringify(payload)));
  const sig = toBase64Url(crypto.createHmac("sha256", SESSION_SECRET).update(data).digest());
  return `${data}.${sig}`;
}
function verifyAuth(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = toBase64Url(crypto.createHmac("sha256", SESSION_SECRET).update(data).digest());
  if (sig !== expected) return null;
  try { return JSON.parse(fromBase64Url(data).toString()); } catch (e) { return null; }
}
function setAuthCookie(res, payload) {
  res.cookie(AUTH_COOKIE, signAuth(payload), { maxAge: AUTH_MAX_AGE, httpOnly: true, sameSite: "lax" });
}

// Every request gets req.auth populated from the signed cookie — no server-side session
// store involved, so logins survive server restarts and redeploys.
app.use((req, res, next) => {
  req.auth = verifyAuth(req.cookies[AUTH_COOKIE]) || { role: null };
  next();
});

function requireOwner(req, res, next) {
  if (req.auth.role === "owner") return next();
  return res.status(401).json({ error: "Owner login required." });
}
function requireManager(req, res, next) {
  if (req.auth.role === "manager" || req.auth.role === "owner") return next();
  return res.status(401).json({ error: "Manager login required." });
}
function requireEmployee(req, res, next) {
  if (req.auth.role === "employee" || req.auth.role === "manager" || req.auth.role === "owner") return next();
  return res.status(401).json({ error: "Login required." });
}

// ---------- session / login ----------
app.get("/api/session", (req, res) => {
  const db = loadDB();
  if (req.auth.role === "owner") return res.json({ role: "owner" });
  if (req.auth.role === "manager") {
    const mgr = db.managers.find((m) => m.id === req.auth.id);
    if (mgr) return res.json({ role: "manager", managerId: mgr.id, name: mgr.name });
  }
  if (req.auth.role === "employee") {
    const emp = db.employees.find((e) => e.id === req.auth.id);
    if (emp) return res.json({ role: "employee", employeeId: emp.id, name: emp.name });
  }
  return res.json({ role: null, ownerPinSet: !!db.ownerPinHash });
});

app.post("/api/setup/owner-pin", (req, res) => {
  const db = loadDB();
  if (db.ownerPinHash) return res.status(400).json({ error: "Owner PIN already set." });
  const { pin } = req.body;
  if (!pin || String(pin).length < 4) return res.status(400).json({ error: "PIN must be at least 4 digits." });
  db.ownerPinHash = hash(pin);
  saveDB(db);
  setAuthCookie(res, { role: "owner" });
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const db = loadDB();
  const { pin } = req.body;
  if (db.ownerPinHash && hash(pin) === db.ownerPinHash) {
    setAuthCookie(res, { role: "owner" });
    return res.json({ role: "owner" });
  }
  const mgr = db.managers.find((m) => m.pinHash === hash(pin));
  if (mgr) {
    setAuthCookie(res, { role: "manager", id: mgr.id });
    return res.json({ role: "manager", managerId: mgr.id, name: mgr.name });
  }
  const emp = db.employees.find((e) => e.pinHash === hash(pin));
  if (emp) {
    setAuthCookie(res, { role: "employee", id: emp.id });
    return res.json({ role: "employee", employeeId: emp.id, name: emp.name });
  }
  return res.status(401).json({ error: "Incorrect PIN." });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(AUTH_COOKIE);
  res.json({ ok: true });
});

// ---------- employees (owner only to manage; employee can read own record) ----------
app.get("/api/employees", requireOwner, (req, res) => {
  const db = loadDB();
  res.json(db.employees.map((e) => ({ id: e.id, name: e.name, commissionRate: e.commissionRate })));
});

app.post("/api/employees", requireOwner, (req, res) => {
  const db = loadDB();
  const { name, commissionRate, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: "Name and PIN are required." });
  const emp = { id: newId(), name: name.trim(), commissionRate: parseFloat(commissionRate) || 0, pinHash: hash(pin) };
  db.employees.push(emp);
  saveDB(db);
  res.json({ id: emp.id, name: emp.name, commissionRate: emp.commissionRate });
});

app.patch("/api/employees/:id", requireOwner, (req, res) => {
  const db = loadDB();
  const emp = db.employees.find((e) => e.id === req.params.id);
  if (!emp) return res.status(404).json({ error: "Not found." });
  if (req.body.name) emp.name = req.body.name.trim();
  if (req.body.commissionRate !== undefined) emp.commissionRate = parseFloat(req.body.commissionRate) || 0;
  if (req.body.pin) emp.pinHash = hash(req.body.pin);
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/employees/:id", requireOwner, (req, res) => {
  const db = loadDB();
  db.employees = db.employees.filter((e) => e.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ---------- managers (owner only to manage) ----------
app.get("/api/managers", requireOwner, (req, res) => {
  const db = loadDB();
  res.json(db.managers.map((m) => ({ id: m.id, name: m.name, commissionRate: m.commissionRate || 0 })));
});

app.post("/api/managers", requireOwner, (req, res) => {
  const db = loadDB();
  const { name, pin, commissionRate } = req.body;
  if (!name || !pin) return res.status(400).json({ error: "Name and PIN are required." });
  const mgr = { id: newId(), name: name.trim(), pinHash: hash(pin), commissionRate: parseFloat(commissionRate) || 0 };
  db.managers.push(mgr);
  saveDB(db);
  res.json({ id: mgr.id, name: mgr.name, commissionRate: mgr.commissionRate });
});

app.patch("/api/managers/:id", requireOwner, (req, res) => {
  const db = loadDB();
  const mgr = db.managers.find((m) => m.id === req.params.id);
  if (!mgr) return res.status(404).json({ error: "Not found." });
  if (req.body.commissionRate !== undefined) mgr.commissionRate = parseFloat(req.body.commissionRate) || 0;
  if (req.body.pin) mgr.pinHash = hash(req.body.pin);
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/managers/:id", requireOwner, (req, res) => {
  const db = loadDB();
  db.managers = db.managers.filter((m) => m.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ---------- GHL webhook (public endpoint, protected by shared secret) ----------
// Point your GoHighLevel workflow's Webhook action at:
//   POST https://your-domain.com/api/webhook/ghl?secret=YOUR_WEBHOOK_SECRET
// Body (JSON): { date, customerName, car, employeeName, baseService, basePrice, ghlOpportunityId }
app.post("/api/webhook/ghl", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  if (!req.body.ghlOpportunityId) return res.status(400).json({ error: "ghlOpportunityId is required so we can avoid duplicates." });
  const sale = upsertSaleFromGHL(db, req.body);
  saveDB(db);
  res.json({ ok: true, saleId: sale.id, matchedEmployees: sale.employeeIds.length });
});

// Lets the owner test the automatic job-creation flow right from the dashboard,
// without needing GoHighLevel wired up yet or any external tool.
app.post("/api/owner/simulate-webhook", requireOwner, (req, res) => {
  const db = loadDB();
  const fakeOpportunityId = "test_" + newId();
  const sale = upsertSaleFromGHL(db, { ...req.body, ghlOpportunityId: fakeOpportunityId });
  saveDB(db);
  res.json({ ok: true, saleId: sale.id, matchedEmployees: sale.employeeIds.length });
});

// ---------- manual fallback entry (owner only — for walk-ins or if GHL sync misses one) ----------
app.post("/api/sales", requireOwner, (req, res) => {
  const db = loadDB();
  const { date, customerName, car, employeeIds, baseService, basePrice } = req.body;
  if (!car || !employeeIds || !employeeIds.length) return res.status(400).json({ error: "Car and at least one employee are required." });
  const names = employeeIds.map((id) => (db.employees.find((e) => e.id === id) || {}).name).filter(Boolean);
  const sale = {
    id: newId(),
    date: date || new Date().toISOString(),
    customerName: customerName || "",
    car,
    employeeIds,
    employeeNames: names.join(", ") || "Unassigned",
    baseService: baseService || "",
    basePrice: parseFloat(basePrice) || 0,
    syncedFromGHL: false,
    upsells: [],
    status: "pending",
    completed: false,
    paid: false,
  };
  db.sales.push(sale);
  saveDB(db);
  res.json({ ok: true, id: sale.id });
});

app.delete("/api/sales/:id", requireOwner, (req, res) => {
  const db = loadDB();
  db.sales = db.sales.filter((s) => s.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ---------- manager job-status updates (arrived / completed / paid) ----------
// Manager-safe employee list — names only, no commission rates or PINs.
app.get("/api/manager/employees", requireManager, (req, res) => {
  const db = loadDB();
  res.json(db.employees.map((e) => ({ id: e.id, name: e.name })));
});

app.get("/api/manager/jobs", requireManager, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const jobs = db.sales.filter((s) => inRange(s.date, start, end));
  res.json(jobs.map((s) => ({
    id: s.id, date: s.date, customerName: s.customerName, customerPhone: s.customerPhone, car: s.car,
    employeeIds: saleEmployeeIds(s), employeeNames: s.employeeNames || "Unassigned", baseService: s.baseService,
    total: saleTotal(s), upsellTotal: saleUpsellTotal(s), upsells: resolveUpsellNames(s.upsells, db),
    status: s.status || (s.arrived ? "arrived" : "pending"), completed: !!s.completed, paid: !!s.paid, paymentMethod: s.paymentMethod || null,
  })));
});

app.patch("/api/manager/jobs/:id", requireManager, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.id);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  if (req.body.status !== undefined) sale.status = req.body.status;
  if (req.body.completed !== undefined) sale.completed = !!req.body.completed;
  if (req.body.paid !== undefined) {
    sale.paid = !!req.body.paid;
    if (!sale.paid) sale.paymentMethod = null;
  }
  if (req.body.paymentMethod !== undefined) {
    sale.paymentMethod = req.body.paymentMethod; // "cash" | "card" | null
    sale.paid = !!req.body.paymentMethod;
  }
  if (req.body.employeeIds !== undefined) {
    sale.employeeIds = req.body.employeeIds;
    const names = req.body.employeeIds.map((id) => (db.employees.find((e) => e.id === id) || {}).name).filter(Boolean);
    sale.employeeNames = names.join(", ") || "Unassigned";
  }
  saveDB(db);
  res.json({ ok: true });
});

// ---------- upsells ----------
app.post("/api/sales/:id/upsells", requireEmployee, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.id);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  // Deliberately NOT restricted to techs assigned to the car — assignment tracks who did the
  // labor, upselling is separate. Anyone logged in can upsell any car on the schedule.
  const { name, price } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Upsell name is required." });
  sale.upsells = sale.upsells || [];
  const upsell = { id: newId(), name: name.trim(), price: parseFloat(price) || 0, employeeId: null, managerId: null };
  if (req.auth.role === "employee") upsell.employeeId = req.auth.id;
  else if (req.auth.role === "manager") upsell.managerId = req.auth.id;
  else if (req.body.employeeId) upsell.employeeId = req.body.employeeId;
  else if (req.body.managerId) upsell.managerId = req.body.managerId;
  sale.upsells.push(upsell);
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/sales/:saleId/upsells/:upsellId", requireEmployee, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.saleId);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  const target = (sale.upsells || []).find((u) => u.id === req.params.upsellId);
  if (!target) return res.status(404).json({ error: "Upsell not found." });
  // Employees can only undo their own entries; managers and the owner can remove any.
  if (req.auth.role === "employee" && target.employeeId !== req.auth.id) {
    return res.status(403).json({ error: "You can only remove upsells you personally logged." });
  }
  sale.upsells = (sale.upsells || []).filter((u) => u.id !== req.params.upsellId);
  saveDB(db);
  res.json({ ok: true });
});

// ---------- employee's own data only — server enforces this, ignores any client-supplied id ----------
// The full schedule — every job, not just ones a tech is assigned to. Assignment (who worked
// the car) is now purely a manager-entered record for pay purposes; it doesn't gate who can
// log an upsell. But what shows here is only the upsells THIS person personally logged —
// not a teammate's, even on a shared car. (Managers still see everyone's, on their own board.)
app.get("/api/my/jobs", requireEmployee, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const myId = req.auth.id;
  const jobs = db.sales
    .filter((s) => inRange(s.date, start, end))
    .map((s) => ({
      id: s.id,
      date: s.date,
      car: s.car,
      baseService: s.baseService,
      employeeNames: s.employeeNames || "Unassigned",
      status: s.status || "pending",
      upsells: resolveUpsellNames((s.upsells || []).filter((u) => u.employeeId === myId), db),
      // basePrice and total sale $ intentionally NOT sent to employees
    }));
  res.json(jobs);
});

app.get("/api/my/performance", requireEmployee, (req, res) => {
  const db = loadDB();
  const employeeId = req.auth.role === "owner" && req.query.employeeId ? req.query.employeeId : req.auth.id;
  const { start, end } = dateRangeFor(req.query);
  const emp = db.employees.find((e) => e.id === employeeId);
  const mine = db.sales.filter((s) => saleEmployeeIds(s).includes(employeeId) && inRange(s.date, start, end));

  // Only upsells this specific person personally logged count toward their own numbers —
  // even on a shared job, a teammate's upsell isn't credited to them.
  const myUpsells = (s) => (s.upsells || []).filter((u) => u.employeeId === employeeId);
  const upsellRev = mine.reduce((a, s) => a + myUpsells(s).reduce((x, u) => x + (parseFloat(u.price) || 0), 0), 0);
  const cars = mine.length;
  const carsWithUpsell = mine.filter((s) => myUpsells(s).length > 0).length;
  const attachRate = cars ? (carsWithUpsell / cars) * 100 : 0;

  const breakdown = {};
  mine.forEach((s) => myUpsells(s).forEach((u) => {
    const k = u.name.trim();
    breakdown[k] = breakdown[k] || { name: k, count: 0, revenue: 0 };
    breakdown[k].count += 1;
    breakdown[k].revenue += parseFloat(u.price) || 0;
  }));
  const sorted = Object.values(breakdown).sort((a, b) => b.revenue - a.revenue);
  const commission = emp && emp.commissionRate ? upsellRev * (emp.commissionRate / 100) : 0;

  res.json({
    cars, attachRate, upsellRevenue: upsellRev,
    top: sorted.slice(0, 2), growthArea: sorted.length > 1 ? sorted[sorted.length - 1] : null,
    commissionRate: emp ? emp.commissionRate : 0, commission,
  });
});

// ---------- manager's own upsell performance — managers upsell too, and get credited personally ----------
app.get("/api/manager/performance", requireManager, (req, res) => {
  const db = loadDB();
  const managerId = req.auth.role === "owner" && req.query.managerId ? req.query.managerId : req.auth.id;
  const { start, end } = dateRangeFor(req.query);
  const mgr = db.managers.find((m) => m.id === managerId);

  const myUpsells = (s) => (s.upsells || []).filter((u) => u.managerId === managerId);
  const relevant = db.sales.filter((s) => inRange(s.date, start, end) && myUpsells(s).length > 0);
  const upsellRev = relevant.reduce((a, s) => a + myUpsells(s).reduce((x, u) => x + (parseFloat(u.price) || 0), 0), 0);
  const cars = relevant.length;

  const breakdown = {};
  relevant.forEach((s) => myUpsells(s).forEach((u) => {
    const k = u.name.trim();
    breakdown[k] = breakdown[k] || { name: k, count: 0, revenue: 0 };
    breakdown[k].count += 1;
    breakdown[k].revenue += parseFloat(u.price) || 0;
  }));
  const sorted = Object.values(breakdown).sort((a, b) => b.revenue - a.revenue);
  const commission = mgr && mgr.commissionRate ? upsellRev * (mgr.commissionRate / 100) : 0;

  res.json({
    cars, upsellRevenue: upsellRev,
    top: sorted.slice(0, 2), growthArea: sorted.length > 1 ? sorted[sorted.length - 1] : null,
    commissionRate: mgr ? mgr.commissionRate : 0, commission,
  });
});

// ---------- contact/vehicle search — find a job by customer name, phone, email, or car ----------
app.get("/api/manager/search", requireManager, (req, res) => {
  const db = loadDB();
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) return res.json([]);
  const results = db.sales.filter((s) =>
    (s.customerName || "").toLowerCase().includes(q) ||
    (s.customerPhone || "").toLowerCase().includes(q) ||
    (s.customerEmail || "").toLowerCase().includes(q) ||
    (s.car || "").toLowerCase().includes(q) ||
    (s.employeeNames || "").toLowerCase().includes(q)
  );
  res.json(results
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 50)
    .map((s) => ({
      id: s.id, date: s.date, car: s.car, customerName: s.customerName,
      customerPhone: s.customerPhone, customerEmail: s.customerEmail,
      employeeNames: s.employeeNames, baseService: s.baseService,
      total: saleTotal(s), status: s.status, completed: !!s.completed, paid: !!s.paid, paymentMethod: s.paymentMethod || null,
      upsells: resolveUpsellNames(s.upsells, db),
    }))
  );
});

// ---------- owner-only: everything ----------
app.get("/api/owner/sales", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const sales = db.sales.filter((s) => inRange(s.date, start, end));
  res.json(sales.map((s) => ({ ...s, total: saleTotal(s), upsellTotal: saleUpsellTotal(s), upsells: resolveUpsellNames(s.upsells, db) })));
});

// Payroll view — every person's own upsells grouped together (for paying commission),
// plus the shop-wide combined total for comparison. Owner-only.
app.get("/api/owner/payroll", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const sales = db.sales.filter((s) => inRange(s.date, start, end));
  const shopTotalUpsellRevenue = sales.reduce((a, s) => a + saleUpsellTotal(s), 0);

  function personBreakdown(idField, id) {
    const mine = [];
    sales.forEach((s) => (s.upsells || []).forEach((u) => { if (u[idField] === id) mine.push(u); }));
    const revenue = mine.reduce((a, u) => a + (parseFloat(u.price) || 0), 0);
    const grouped = {};
    mine.forEach((u) => {
      const k = u.name.trim();
      grouped[k] = grouped[k] || { name: k, count: 0, revenue: 0 };
      grouped[k].count += 1;
      grouped[k].revenue += parseFloat(u.price) || 0;
    });
    return { revenue, count: mine.length, items: Object.values(grouped).sort((a, b) => b.revenue - a.revenue) };
  }

  const employees = db.employees.map((emp) => {
    const b = personBreakdown("employeeId", emp.id);
    const carsWorked = sales.filter((s) => saleEmployeeIds(s).includes(emp.id)).length;
    const commission = emp.commissionRate ? b.revenue * (emp.commissionRate / 100) : 0;
    return { id: emp.id, name: emp.name, commissionRate: emp.commissionRate || 0, carsWorked, upsellRevenue: b.revenue, upsellCount: b.count, commission, upsells: b.items };
  });
  const managers = db.managers.map((mgr) => {
    const b = personBreakdown("managerId", mgr.id);
    const commission = mgr.commissionRate ? b.revenue * (mgr.commissionRate / 100) : 0;
    return { id: mgr.id, name: mgr.name, commissionRate: mgr.commissionRate || 0, upsellRevenue: b.revenue, upsellCount: b.count, commission, upsells: b.items };
  });

  res.json({ shopTotalUpsellRevenue, employees, managers });
});

app.get("/api/owner/summary", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const sales = db.sales.filter((s) => inRange(s.date, start, end));
  const totalRevenue = sales.reduce((a, s) => a + saleTotal(s), 0);
  const totalUpsell = sales.reduce((a, s) => a + saleUpsellTotal(s), 0);
  const carCount = sales.length;
  const attachRate = carCount ? (sales.filter((s) => (s.upsells || []).length > 0).length / carCount) * 100 : 0;

  // Base price isn't split per tech since jobs are tag-teamed — "cars worked" and each
  // person's own logged upsell revenue are the numbers that stay unambiguous here.
  const perEmployee = db.employees.map((emp) => {
    const carsWorked = sales.filter((s) => saleEmployeeIds(s).includes(emp.id));
    const myUpsellRevenue = sales.reduce((a, s) => a + (s.upsells || []).filter((u) => u.employeeId === emp.id).reduce((x, u) => x + (parseFloat(u.price) || 0), 0), 0);
    return { id: emp.id, name: emp.name, cars: carsWorked.length, upsellRevenue: myUpsellRevenue };
  });

  const leaderboard = [];
  const grouped = {};
  sales.forEach((s) => (s.upsells || []).forEach((u) => {
    const empName = (db.employees.find((e) => e.id === u.employeeId) || {}).name || "Unassigned";
    const key = u.name.trim() + "||" + empName;
    grouped[key] = grouped[key] || { upsell: u.name.trim(), employee: empName, count: 0, revenue: 0 };
    grouped[key].count += 1;
    grouped[key].revenue += parseFloat(u.price) || 0;
  }));
  Object.values(grouped).sort((a, b) => b.revenue - a.revenue).forEach((r) => leaderboard.push(r));

  res.json({
    totalRevenue, totalUpsellRevenue: totalUpsell,
    upsellPercentOfRevenue: totalRevenue ? (totalUpsell / totalRevenue) * 100 : 0,
    carCount, attachRate, perEmployee, leaderboard,
  });
});

app.listen(PORT, () => console.log(`SBN Autostyling Tracker running on port ${PORT}`));
