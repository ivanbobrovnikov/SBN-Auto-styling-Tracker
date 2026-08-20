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
    const fresh = { employees: [], managers: [], salesReps: [], sales: [], ownerPinHash: null };
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  if (!db.managers) db.managers = [];
  if (!db.salesReps) db.salesReps = [];
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
// Business hours: Mon–Sat, 9am–6pm, Eastern time — regardless of what timezone the server
// itself runs in. This decides which of a sales rep's two commission rates applies, based
// on the moment the deal actually closed (opportunity hit Booked w/ Deposit), not the
// scheduled appointment time.
function isDuringBusinessHours(isoString) {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return true; // safest default if something's malformed — don't silently overpay
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false, weekday: "short",
  }).formatToParts(d);
  const weekday = (parts.find((p) => p.type === "weekday") || {}).value;
  let hour = parseInt((parts.find((p) => p.type === "hour") || {}).value, 10);
  if (hour === 24) hour = 0; // some ICU builds report midnight as "24" instead of "00"
  const openDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]; // closed Sunday
  return openDays.includes(weekday) && hour >= 9 && hour < 18;
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
function money2(n) {
  return (Math.round((n || 0) * 100) / 100).toFixed(2);
}
// A cancelled job should never count toward revenue, commission, or "cars serviced" —
// but it should still be VISIBLE everywhere (All jobs, Job status, Search) so nobody
// wonders where it went. This is the one shared filter that keeps that rule consistent.
function excludingCancelled(sales) {
  return sales.filter((s) => s.status !== "cancelled");
}

// Converts a wall-clock date/time that's known to represent Eastern time into the correct
// real UTC instant — accounting for daylight saving automatically, without any external
// timezone library.
function easternWallClockToUTC(y, mo, d, h, mi, s) {
  const guessUTC = Date.UTC(y, mo, d, h, mi, s);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(guessUTC));
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  let hh = parseInt(map.hour, 10);
  if (hh === 24) hh = 0;
  const asIfEasternWereUTC = Date.UTC(+map.year, +map.month - 1, +map.day, hh, +map.minute, +map.second);
  const offset = asIfEasternWereUTC - guessUTC;
  return new Date(guessUTC - offset);
}

// GHL can send the appointment date as a human-readable string like "Thursday, August 20,
// 2026 12:00 AM" with NO timezone marker at all. That string is Eastern wall-clock time —
// but naively parsing it assumes the SERVER's own clock (UTC on Railway), which silently
// produces a time several hours off. This detects that case and converts it correctly.
// If the incoming string already has an explicit "Z" or "+HH:MM" offset, it's unambiguous
// and gets trusted as-is.
function normalizeDate(input) {
  if (!input) return null;
  const hasExplicitOffset = /Z$|[+-]\d{2}:?\d{2}$/.test(String(input).trim());
  const humanFormat = String(input).match(/(\w+),?\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!hasExplicitOffset && humanFormat) {
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const mo = months.indexOf(humanFormat[2].toLowerCase());
    if (mo !== -1) {
      const day = parseInt(humanFormat[3], 10);
      const year = parseInt(humanFormat[4], 10);
      let hour = parseInt(humanFormat[5], 10);
      const minute = parseInt(humanFormat[6], 10);
      const ampm = humanFormat[7];
      if (ampm) {
        if (ampm.toUpperCase() === "PM" && hour !== 12) hour += 12;
        if (ampm.toUpperCase() === "AM" && hour === 12) hour = 0;
      }
      const d = easternWallClockToUTC(year, mo, day, hour, minute, 0);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// GHL doesn't send our custom fields at the top level of the webhook body — it nests them
// inside a "customData" object alongside a large amount of its own native payload data
// (contact info, workflow info, calendar info, etc). This unwraps that, with a fallback
// to the raw body for our own internal test-tool calls, which send flat JSON directly.
function ghlPayload(body) {
  if (body && body.customData && typeof body.customData === "object") return body.customData;
  return body || {};
}

function upsertSaleFromGHL(db, { date, customerName, customerPhone, customerEmail, contactId, car, employeeName, salesRepName, baseService, basePrice, ghlOpportunityId, closedAt }) {
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
  // Sales rep is the person who closed the lead — usually GHL's "Assigned To" on the opportunity.
  // Only ever one person here (unlike techs), so a simple name match is enough.
  const rep = salesRepName ? db.salesReps.find((r) => r.name.toLowerCase() === String(salesRepName).trim().toLowerCase()) : null;

  const isNew = !db.sales.find((s) => s.ghlOpportunityId === ghlOpportunityId);
  let sale = db.sales.find((s) => s.ghlOpportunityId === ghlOpportunityId);
  if (!sale) {
    sale = { id: newId(), ghlOpportunityId, upsells: [], status: "pending", completed: false, paid: false };
    db.sales.push(sale);
  }
  // closedAt is stamped ONCE, at the exact moment the deal was actually closed (this webhook
  // firing for the first time = the opportunity hitting Booked w/ Deposit). Later syncs
  // (like a price update) never touch it — that would let someone accidentally shift a
  // rep's commission rate after the fact just by editing the price later.
  if (isNew) sale.closedAt = closedAt || new Date().toISOString();
  sale.date = normalizeDate(date) || sale.date || new Date().toISOString();
  sale.customerName = customerName || sale.customerName || "";
  sale.customerPhone = customerPhone || sale.customerPhone || "";
  sale.customerEmail = customerEmail || sale.customerEmail || "";
  sale.contactId = contactId || sale.contactId || null;
  sale.car = car || sale.car || "";
  sale.employeeIds = matched.map((e) => e.id);
  sale.employeeNames = matched.map((e) => e.name).concat(unmatched.map((n) => n + " (unmatched)")).join(", ") || "Unassigned";
  if (rep) { sale.salesRepId = rep.id; sale.salesRepName = rep.name; }
  else if (salesRepName) { sale.salesRepId = sale.salesRepId || null; sale.salesRepName = salesRepName + " (unmatched)"; }
  else { sale.salesRepId = sale.salesRepId || null; sale.salesRepName = sale.salesRepName || "Unassigned"; }
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
app.disable("etag"); // this is what was actually causing 304 "not modified" responses on API calls
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // some webhook senders (possibly GHL) post form-encoded, not JSON
app.use(cookieParser());
// Every /api response is dynamic data — never let the browser cache it. Without this,
// a browser can silently serve a stale cached response (HTTP 304) for things like the
// debug log, dashboard numbers, or job status, making "refresh" appear to do nothing.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});
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
function requireSales(req, res, next) {
  if (req.auth.role === "sales" || req.auth.role === "owner") return next();
  return res.status(401).json({ error: "Sales login required." });
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
  if (req.auth.role === "sales") {
    const rep = db.salesReps.find((r) => r.id === req.auth.id);
    if (rep) return res.json({ role: "sales", salesRepId: rep.id, name: rep.name });
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
  const rep = db.salesReps.find((r) => r.pinHash === hash(pin));
  if (rep) {
    setAuthCookie(res, { role: "sales", id: rep.id });
    return res.json({ role: "sales", salesRepId: rep.id, name: rep.name });
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

// ---------- sales reps (owner only to manage) — the person who CLOSED the deal, distinct from
// the techs who worked it and the managers who mark it arrived/no-show. Their commission
// depends on that arrived mark, so they get no ability to touch job status themselves. ----------
app.get("/api/salesreps", requireOwner, (req, res) => {
  const db = loadDB();
  res.json(db.salesReps.map((r) => ({ id: r.id, name: r.name, commissionRate: r.commissionRate || 0, afterHoursCommissionRate: r.afterHoursCommissionRate || 0 })));
});

app.post("/api/salesreps", requireOwner, (req, res) => {
  const db = loadDB();
  const { name, pin, commissionRate, afterHoursCommissionRate } = req.body;
  if (!name || !pin) return res.status(400).json({ error: "Name and PIN are required." });
  const rep = { id: newId(), name: name.trim(), pinHash: hash(pin), commissionRate: parseFloat(commissionRate) || 0, afterHoursCommissionRate: parseFloat(afterHoursCommissionRate) || 0 };
  db.salesReps.push(rep);
  saveDB(db);
  res.json({ id: rep.id, name: rep.name, commissionRate: rep.commissionRate, afterHoursCommissionRate: rep.afterHoursCommissionRate });
});

app.patch("/api/salesreps/:id", requireOwner, (req, res) => {
  const db = loadDB();
  const rep = db.salesReps.find((r) => r.id === req.params.id);
  if (!rep) return res.status(404).json({ error: "Not found." });
  if (req.body.commissionRate !== undefined) rep.commissionRate = parseFloat(req.body.commissionRate) || 0;
  if (req.body.afterHoursCommissionRate !== undefined) rep.afterHoursCommissionRate = parseFloat(req.body.afterHoursCommissionRate) || 0;
  if (req.body.pin) rep.pinHash = hash(req.body.pin);
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/salesreps/:id", requireOwner, (req, res) => {
  const db = loadDB();
  db.salesReps = db.salesReps.filter((r) => r.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// Manager-safe name list, same idea as manager/employees — lets a manager assign/fix which
// sales rep gets credit for a booking, without seeing commission rates.
app.get("/api/manager/salesreps", requireManager, (req, res) => {
  const db = loadDB();
  res.json(db.salesReps.map((r) => ({ id: r.id, name: r.name })));
});

// ---------- GHL webhook (public endpoint, protected by shared secret) ----------
// Point your GoHighLevel workflow's Webhook action at:
//   POST https://your-domain.com/api/webhook/ghl?secret=YOUR_WEBHOOK_SECRET
// Body (JSON): { date, customerName, car, employeeName, baseService, basePrice, ghlOpportunityId }
app.post("/api/webhook/ghl", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const data = ghlPayload(req.body);
  if (!data.ghlOpportunityId) {
    if (!db.debugLog) db.debugLog = [];
    db.debugLog.unshift({ receivedAt: new Date().toISOString(), contentType: req.headers["content-type"] || "(none)", failedReason: "missing ghlOpportunityId", body: req.body });
    db.debugLog = db.debugLog.slice(0, 30);
    saveDB(db);
    return res.status(400).json({ error: "ghlOpportunityId is required so we can avoid duplicates." });
  }
  const sale = upsertSaleFromGHL(db, data);
  saveDB(db);
  res.json({ ok: true, saleId: sale.id, matchedEmployees: sale.employeeIds.length });
});

// Price/Rep sync — a DIFFERENT matching strategy than everything else above. GHL's
// "Opportunity Changed" trigger (needed to catch a price change after booking) doesn't
// reliably carry the Appointment ID the booking workflow used — that's a real platform
// limitation, confirmed by testing, not a setup mistake. Contact ID is the one thing
// genuinely available on both sides, so this endpoint matches by contact instead.
// Risk, stated plainly: if the same contact has TWO unresolved (pending) bookings at once,
// this can't tell them apart and will update whichever is most recent. For a shop where a
// customer books one job at a time, this is a safe, practical tradeoff — not a perfect one.
app.post("/api/webhook/ghl/sync", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  if (!db.debugLog) db.debugLog = [];
  const { contactId, basePrice, salesRepName } = ghlPayload(req.body);
  if (!contactId) {
    db.debugLog.unshift({ receivedAt: new Date().toISOString(), endpoint: "sync", failedReason: "missing contactId", body: req.body });
    db.debugLog = db.debugLog.slice(0, 30);
    saveDB(db);
    return res.status(400).json({ error: "contactId is required." });
  }
  const matches = db.sales.filter((s) => s.contactId === contactId);
  if (matches.length === 0) {
    db.debugLog.unshift({ receivedAt: new Date().toISOString(), endpoint: "sync", failedReason: "no sale found with this contactId", body: req.body, knownContactIds: db.sales.map((s) => s.contactId) });
    db.debugLog = db.debugLog.slice(0, 30);
    saveDB(db);
    return res.json({ ok: true, found: false });
  }
  // Prefer the most recent still-pending booking for this contact — that's almost always
  // the one a phone call just closed. Falls back to the most recent overall if none are pending.
  const pending = matches.filter((s) => !s.status || s.status === "pending");
  const pool = pending.length ? pending : matches;
  const sale = pool.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const before = { basePrice: sale.basePrice, salesRepName: sale.salesRepName };
  if (basePrice !== undefined) sale.basePrice = parseFloat(basePrice) || 0;
  if (salesRepName) {
    const rep = db.salesReps.find((r) => r.name.toLowerCase() === String(salesRepName).trim().toLowerCase());
    if (rep) { sale.salesRepId = rep.id; sale.salesRepName = rep.name; }
  }
  db.debugLog.unshift({ receivedAt: new Date().toISOString(), endpoint: "sync", matchedSaleId: sale.id, before, after: { basePrice: sale.basePrice, salesRepName: sale.salesRepName }, body: req.body });
  db.debugLog = db.debugLog.slice(0, 30);
  saveDB(db);
  res.json({ ok: true, found: true, saleId: sale.id });
});

// Cancellation — deliberately separate from the main webhook above. This one ONLY updates
// a job that already exists (matched by ghlOpportunityId); it never creates a new one.
// If the appointment was cancelled before it ever hit "Confirmed," there's nothing in the
// tracker to cancel, and this quietly does nothing rather than creating a phantom job.
app.post("/api/webhook/ghl/cancel", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const { ghlOpportunityId } = ghlPayload(req.body);
  if (!ghlOpportunityId) return res.status(400).json({ error: "ghlOpportunityId is required." });
  const sale = db.sales.find((s) => s.ghlOpportunityId === ghlOpportunityId);
  if (!sale) return res.json({ ok: true, found: false });
  sale.status = "cancelled";
  saveDB(db);
  res.json({ ok: true, found: true, saleId: sale.id });
});

// Deletion — a genuinely different outcome from cancellation. If the appointment itself
// gets deleted in GHL (not just marked cancelled), the job disappears from the tracker
// entirely rather than sticking around labeled "Cancelled." Matched by ghlOpportunityId,
// same as cancel — if nothing matches, this quietly does nothing.
app.post("/api/webhook/ghl/delete", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const { ghlOpportunityId } = ghlPayload(req.body);
  if (!ghlOpportunityId) return res.status(400).json({ error: "ghlOpportunityId is required." });
  const before = db.sales.length;
  db.sales = db.sales.filter((s) => s.ghlOpportunityId !== ghlOpportunityId);
  const found = db.sales.length < before;
  saveDB(db);
  res.json({ ok: true, found });
});

// Diagnostic endpoint — logs whatever GHL actually sends, no matter the shape, so we can
// see real payloads for events we haven't mapped yet (like checking whether a deleted
// appointment secretly fires a status-change event under a status we haven't tried).
app.post("/api/webhook/ghl/debug", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  if (!db.debugLog) db.debugLog = [];
  db.debugLog.unshift({ receivedAt: new Date().toISOString(), contentType: req.headers["content-type"] || "(none)", body: req.body });
  db.debugLog = db.debugLog.slice(0, 30); // keep only the most recent 30
  saveDB(db);
  res.json({ ok: true });
});

app.get("/api/owner/debug-log", requireOwner, (req, res) => {
  const db = loadDB();
  res.json(db.debugLog || []);
});

app.post("/api/owner/debug-log/clear", requireOwner, (req, res) => {
  const db = loadDB();
  db.debugLog = [];
  saveDB(db);
  res.json({ ok: true });
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

// Lets the owner test the cancellation flow from the dashboard, same idea as simulate-webhook.
app.post("/api/owner/simulate-cancel", requireOwner, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.body.saleId);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  sale.status = "cancelled";
  saveDB(db);
  res.json({ ok: true });
});

// Lets the owner test the deletion flow — the job should actually vanish, not just get marked.
app.post("/api/owner/simulate-delete", requireOwner, (req, res) => {
  const db = loadDB();
  const before = db.sales.length;
  db.sales = db.sales.filter((s) => s.id !== req.body.saleId);
  const found = db.sales.length < before;
  saveDB(db);
  res.json({ ok: true, found });
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
    salesRepId: s.salesRepId || null, salesRepName: s.salesRepName || "Unassigned",
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
  if (req.body.salesRepId !== undefined) {
    sale.salesRepId = req.body.salesRepId;
    const rep = db.salesReps.find((r) => r.id === req.body.salesRepId);
    sale.salesRepName = rep ? rep.name : "Unassigned";
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
  const mine = db.sales.filter((s) => saleEmployeeIds(s).includes(employeeId) && inRange(s.date, start, end) && s.status !== "cancelled");

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
  const relevant = db.sales.filter((s) => inRange(s.date, start, end) && s.status !== "cancelled" && myUpsells(s).length > 0);
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
    jobs: relevant.map((s) => ({
      id: s.id, date: s.date, car: s.car, customerName: s.customerName,
      upsells: myUpsells(s).map((u) => ({ name: u.name, price: u.price })),
    })).sort((a, b) => (a.date < b.date ? 1 : -1)),
  });
});

// ---------- sales rep — read-only view of their own bookings. Commission depends on the
// manager's arrived/no-show mark, so a sales rep can never touch status themselves; this
// role only has GET routes, no PATCH access to anything. ----------
// One place that decides which of a rep's two rates applies to a given sale, based on
// exactly when it closed — used everywhere commission gets calculated, so the rule can
// never drift out of sync between the rep's own dashboard, the owner dashboard, and payroll.
function salesRepCommissionForSale(rep, sale) {
  if (!rep || sale.status !== "arrived") return { amount: 0, duringHours: null };
  const duringHours = isDuringBusinessHours(sale.closedAt || sale.date);
  const rate = duringHours ? (rep.commissionRate || 0) : (rep.afterHoursCommissionRate || 0);
  return { amount: (parseFloat(sale.basePrice) || 0) * (rate / 100), duringHours };
}

app.get("/api/my/sales-schedule", requireSales, (req, res) => {
  const db = loadDB();
  const repId = req.auth.role === "owner" && req.query.salesRepId ? req.query.salesRepId : req.auth.id;
  const { start, end } = dateRangeFor(req.query);
  const jobs = db.sales
    .filter((s) => s.salesRepId === repId && inRange(s.date, start, end))
    .map((s) => ({
      id: s.id, date: s.date, car: s.car, customerName: s.customerName, baseService: s.baseService,
      basePrice: s.basePrice, status: s.status || "pending",
      // No price/status editing here — this is a read-only view of what THEY sold and whether it showed.
    }));
  res.json(jobs);
});

app.get("/api/my/sales-performance", requireSales, (req, res) => {
  const db = loadDB();
  const repId = req.auth.role === "owner" && req.query.salesRepId ? req.query.salesRepId : req.auth.id;
  const { start, end } = dateRangeFor(req.query);
  const rep = db.salesReps.find((r) => r.id === repId);
  const mine = db.sales.filter((s) => s.salesRepId === repId && inRange(s.date, start, end) && s.status !== "cancelled");

  const totalBooked = mine.length;
  const totalBookedValue = mine.reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
  const showed = mine.filter((s) => s.status === "arrived");
  const showedValue = showed.reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
  const noShowCount = mine.filter((s) => s.status === "no_show").length;
  const pendingCount = mine.filter((s) => !s.status || s.status === "pending").length;

  let commission = 0, duringHoursValue = 0, afterHoursValue = 0, duringHoursCount = 0, afterHoursCount = 0;
  showed.forEach((s) => {
    const c = salesRepCommissionForSale(rep, s);
    commission += c.amount;
    if (c.duringHours) { duringHoursValue += parseFloat(s.basePrice) || 0; duringHoursCount += 1; }
    else { afterHoursValue += parseFloat(s.basePrice) || 0; afterHoursCount += 1; }
  });

  res.json({
    totalBooked, totalBookedValue, showedCount: showed.length, showedValue,
    noShowCount, pendingCount, commission,
    commissionRate: rep ? rep.commissionRate || 0 : 0,
    afterHoursCommissionRate: rep ? rep.afterHoursCommissionRate || 0 : 0,
    duringHoursCount, duringHoursValue, afterHoursCount, afterHoursValue,
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
  const sales = excludingCancelled(db.sales.filter((s) => inRange(s.date, start, end)));
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
  // Sales reps are a different pay structure entirely — commission on the base sale, only
  // when the manager marked it arrived. Not tied to upsells at all.
  const salesReps = db.salesReps.map((rep) => {
    const mine = sales.filter((s) => s.salesRepId === rep.id);
    const showed = mine.filter((s) => s.status === "arrived");
    const showedValue = showed.reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
    let commission = 0, duringHoursCount = 0, afterHoursCount = 0;
    showed.forEach((s) => {
      const c = salesRepCommissionForSale(rep, s);
      commission += c.amount;
      if (c.duringHours) duringHoursCount += 1; else afterHoursCount += 1;
    });
    return { id: rep.id, name: rep.name, commissionRate: rep.commissionRate || 0, afterHoursCommissionRate: rep.afterHoursCommissionRate || 0, totalBooked: mine.length, showedCount: showed.length, showedValue, duringHoursCount, afterHoursCount, commission };
  });

  res.json({ shopTotalUpsellRevenue, employees, managers, salesReps });
});

// Full raw backup — everyone's data, as a downloadable file the owner can save anywhere
// (their own computer, Google Drive, wherever) independent of Railway entirely.
app.get("/api/owner/backup", requireOwner, (req, res) => {
  const db = loadDB();
  const filename = `sbn-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(db, null, 2));
});

function csvEscape(val) {
  const s = String(val === undefined || val === null ? "" : val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Spreadsheet export of every job in a period, ready to open in Excel/Sheets.
app.get("/api/owner/export/csv", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const sales = db.sales.filter((s) => inRange(s.date, start, end));
  const headers = ["Date", "Car", "Customer", "Phone", "Email", "Base Service", "Worked By", "Base Price", "Upsell Total", "Total", "Status", "Completed", "Paid", "Payment Method", "Upsells (detail)"];
  const rows = sales.map((s) => {
    const upsells = resolveUpsellNames(s.upsells, db);
    const upsellDetail = upsells.map((u) => `${u.name}: ${money2(u.price)} (${u.attributedToName})`).join("; ");
    return [
      s.date || "", s.car || "", s.customerName || "", s.customerPhone || "", s.customerEmail || "",
      s.baseService || "", s.employeeNames || "Unassigned", money2(s.basePrice), money2(saleUpsellTotal(s)), money2(saleTotal(s)),
      s.status || "pending", s.completed ? "Yes" : "No", s.paid ? "Yes" : "No", s.paymentMethod || "", upsellDetail,
    ];
  });
  const csv = [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
  const filename = `sbn-tracker-export-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/csv");
  res.send(csv);
});

app.get("/api/owner/summary", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const sales = excludingCancelled(db.sales.filter((s) => inRange(s.date, start, end)));
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
  // Managers upsell too — same idea, but they're not "assigned" to cars the way techs are,
  // so there's no cars-worked count for them, just their own upsell revenue.
  const perManager = db.managers.map((mgr) => {
    const myUpsellRevenue = sales.reduce((a, s) => a + (s.upsells || []).filter((u) => u.managerId === mgr.id).reduce((x, u) => x + (parseFloat(u.price) || 0), 0), 0);
    return { id: mgr.id, name: mgr.name, upsellRevenue: myUpsellRevenue };
  });
  // Sales reps get commission on the BASE sale, only when it showed (manager-marked) —
  // completely separate from upsell commission the techs/managers earn.
  const perSalesRep = db.salesReps.map((rep) => {
    const mine = sales.filter((s) => s.salesRepId === rep.id);
    const showed = mine.filter((s) => s.status === "arrived");
    const showedValue = showed.reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
    const commission = showed.reduce((a, s) => a + salesRepCommissionForSale(rep, s).amount, 0);
    return { id: rep.id, name: rep.name, totalBooked: mine.length, showedCount: showed.length, showedValue, commissionRate: rep.commissionRate || 0, commission };
  });

  const leaderboard = [];
  const grouped = {};
  sales.forEach((s) => resolveUpsellNames(s.upsells, db).forEach((u) => {
    const key = u.name.trim() + "||" + u.attributedToName;
    grouped[key] = grouped[key] || { upsell: u.name.trim(), employee: u.attributedToName, count: 0, revenue: 0 };
    grouped[key].count += 1;
    grouped[key].revenue += parseFloat(u.price) || 0;
  }));
  Object.values(grouped).sort((a, b) => b.revenue - a.revenue).forEach((r) => leaderboard.push(r));

  res.json({
    totalRevenue, totalUpsellRevenue: totalUpsell,
    upsellPercentOfRevenue: totalRevenue ? (totalUpsell / totalRevenue) * 100 : 0,
    carCount, attachRate, perEmployee, perManager, perSalesRep, leaderboard,
  });
});

app.listen(PORT, () => console.log(`SBN Autostyling Tracker running on port ${PORT}`));
