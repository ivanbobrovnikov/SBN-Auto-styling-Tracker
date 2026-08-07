require("dotenv").config();
const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, "data.json");
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-too";

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const fresh = { employees: [], sales: [], ownerPinHash: null };
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
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
function saleUpsellTotal(sale) {
  return (sale.upsells || []).reduce((a, u) => a + (parseFloat(u.price) || 0), 0);
}
function saleTotal(sale) {
  return (parseFloat(sale.basePrice) || 0) + saleUpsellTotal(sale);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 90 },
  })
);

function requireOwner(req, res, next) {
  if (req.session.role === "owner") return next();
  return res.status(401).json({ error: "Owner login required." });
}
function requireEmployee(req, res, next) {
  if (req.session.role === "employee" || req.session.role === "owner") return next();
  return res.status(401).json({ error: "Login required." });
}

app.get("/api/session", (req, res) => {
  const db = loadDB();
  if (req.session.role === "owner") return res.json({ role: "owner" });
  if (req.session.role === "employee") {
    const emp = db.employees.find((e) => e.id === req.session.employeeId);
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
  req.session.role = "owner";
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const db = loadDB();
  const { pin } = req.body;
  if (db.ownerPinHash && hash(pin) === db.ownerPinHash) {
    req.session.role = "owner";
    return res.json({ role: "owner" });
  }
  const emp = db.employees.find((e) => e.pinHash === hash(pin));
  if (emp) {
    req.session.role = "employee";
    req.session.employeeId = emp.id;
    return res.json({ role: "employee", employeeId: emp.id, name: emp.name });
  }
  return res.status(401).json({ error: "Incorrect PIN." });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

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

app.post("/api/webhook/ghl", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const { date, customerName, car, employeeName, baseService, basePrice, ghlOpportunityId } = req.body;
  if (!ghlOpportunityId) return res.status(400).json({ error: "ghlOpportunityId is required so we can avoid duplicates." });

  const emp = db.employees.find((e) => e.name.toLowerCase() === String(employeeName || "").toLowerCase());

  let sale = db.sales.find((s) => s.ghlOpportunityId === ghlOpportunityId);
  if (!sale) {
    sale = { id: newId(), ghlOpportunityId, upsells: [] };
    db.sales.push(sale);
  }
  sale.date = date || sale.date || new Date().toISOString();
  sale.customerName = customerName || sale.customerName || "";
  sale.car = car || sale.car || "";
  sale.employeeId = emp ? emp.id : sale.employeeId || null;
  sale.employeeName = emp ? emp.name : employeeName || "Unassigned";
  sale.baseService = baseService || sale.baseService || "";
  sale.basePrice = basePrice !== undefined ? parseFloat(basePrice) || 0 : sale.basePrice || 0;
  sale.syncedFromGHL = true;

  saveDB(db);
  res.json({ ok: true, saleId: sale.id, matchedEmployee: !!emp });
});

app.post("/api/sales", requireOwner, (req, res) => {
  const db = loadDB();
  const { date, customerName, car, employeeId, baseService, basePrice } = req.body;
  if (!car || !employeeId) return res.status(400).json({ error: "Car and employee are required." });
  const emp = db.employees.find((e) => e.id === employeeId);
  const sale = {
    id: newId(),
    date: date || new Date().toISOString(),
    customerName: customerName || "",
    car,
    employeeId,
    employeeName: emp ? emp.name : "Removed employee",
    baseService: baseService || "",
    basePrice: parseFloat(basePrice) || 0,
    syncedFromGHL: false,
    upsells: [],
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

app.post("/api/sales/:id/upsells", requireEmployee, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.id);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  if (req.session.role === "employee" && sale.employeeId !== req.session.employeeId) {
    return res.status(403).json({ error: "This job isn't assigned to you." });
  }
  const { name, price } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Upsell name is required." });
  sale.upsells = sale.upsells || [];
  sale.upsells.push({ id: newId(), name: name.trim(), price: parseFloat(price) || 0 });
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/sales/:saleId/upsells/:upsellId", requireEmployee, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.saleId);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  if (req.session.role === "employee" && sale.employeeId !== req.session.employeeId) {
    return res.status(403).json({ error: "This job isn't assigned to you." });
  }
  sale.upsells = (sale.upsells || []).filter((u) => u.id !== req.params.upsellId);
  saveDB(db);
  res.json({ ok: true });
});

app.get("/api/my/jobs", requireEmployee, (req, res) => {
  const db = loadDB();
  const employeeId = req.session.role === "owner" && req.query.employeeId ? req.query.employeeId : req.session.employeeId;
  const jobs = db.sales
    .filter((s) => s.employeeId === employeeId)
    .map((s) => ({
      id: s.id,
      date: s.date,
      car: s.car,
      baseService: s.baseService,
      upsells: s.upsells || [],
      upsellTotal: saleUpsellTotal(s),
    }));
  res.json(jobs);
});

app.get("/api/my/performance", requireEmployee, (req, res) => {
  const db = loadDB();
  const employeeId = req.session.role === "owner" && req.query.employeeId ? req.query.employeeId : req.session.employeeId;
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const emp = db.employees.find((e) => e.id === employeeId);
  const mine = db.sales.filter((s) => s.employeeId === employeeId && monthKey(s.date) === month);

  const upsellRev = mine.reduce((a, s) => a + saleUpsellTotal(s), 0);
  const cars = mine.length;
  const carsWithUpsell = mine.filter((s) => (s.upsells || []).length > 0).length;
  const attachRate = cars ? (carsWithUpsell / cars) * 100 : 0;

  const breakdown = {};
  mine.forEach((s) => (s.upsells || []).forEach((u) => {
    const k = u.name.trim();
    breakdown[k] = breakdown[k] || { name: k, count: 0, revenue: 0 };
    breakdown[k].count += 1;
    breakdown[k].revenue += parseFloat(u.price) || 0;
  }));
  const sorted = Object.values(breakdown).sort((a, b) => b.revenue - a.revenue);
  const commission = emp && emp.commissionRate ? upsellRev * (emp.commissionRate / 100) : 0;

  res.json({
    month, cars, attachRate, upsellRevenue: upsellRev,
    top: sorted.slice(0, 2), growthArea: sorted.length > 1 ? sorted[sorted.length - 1] : null,
    commissionRate: emp ? emp.commissionRate : 0, commission,
  });
});

app.get("/api/owner/sales", requireOwner, (req, res) => {
  const db = loadDB();
  const month = req.query.month;
  const sales = db.sales.filter((s) => !month || monthKey(s.date) === month);
  res.json(sales.map((s) => ({ ...s, total: saleTotal(s), upsellTotal: saleUpsellTotal(s) })));
});

app.get("/api/owner/summary", requireOwner, (req, res) => {
  const db = loadDB();
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const sales = db.sales.filter((s) => monthKey(s.date) === month);
  const totalRevenue = sales.reduce((a, s) => a + saleTotal(s), 0);
  const totalUpsell = sales.reduce((a, s) => a + saleUpsellTotal(s), 0);
  const carCount = sales.length;
  const attachRate = carCount ? (sales.filter((s) => (s.upsells || []).length > 0).length / carCount) * 100 : 0;

  const perEmployee = db.employees.map((emp) => {
    const empSales = sales.filter((s) => s.employeeId === emp.id);
    return {
      id: emp.id, name: emp.name,
      cars: empSales.length,
      revenue: empSales.reduce((a, s) => a + saleTotal(s), 0),
      upsellRevenue: empSales.reduce((a, s) => a + saleUpsellTotal(s), 0),
    };
  });

  const leaderboard = [];
  const grouped = {};
  sales.forEach((s) => (s.upsells || []).forEach((u) => {
    const key = u.name.trim() + "||" + (s.employeeName || "Unassigned");
    grouped[key] = grouped[key] || { upsell: u.name.trim(), employee: s.employeeName || "Unassigned", count: 0, revenue: 0 };
    grouped[key].count += 1;
    grouped[key].revenue += parseFloat(u.price) || 0;
  }));
  Object.values(grouped).sort((a, b) => b.revenue - a.revenue).forEach((r) => leaderboard.push(r));

  res.json({
    month, totalRevenue, totalUpsellRevenue: totalUpsell,
    upsellPercentOfRevenue: totalRevenue ? (totalUpsell / totalRevenue) * 100 : 0,
    carCount, attachRate, perEmployee, leaderboard,
  });
});

app.listen(PORT, () => console.log(`SBN Autostyling Tracker running on port ${PORT}`));
