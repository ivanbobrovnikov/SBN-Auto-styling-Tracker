require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, "data.json");
const PHOTOS_DIR = path.join(DATA_DIR, "photos");
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";
// Release label shown on screen so a half-updated deploy (one file replaced, not the other)
// is obvious at a glance instead of just looking "broken". Bump this with each release.
const BUILD = "2026-10-28-upsells";
// Separate from WEBHOOK_SECRET - protects the read/write endpoints the combined sales rep
// tracker app uses to pull stats and push Cleanup fixes. Never used by GHL at all.
const CROSS_LOCATION_SECRET = process.env.CROSS_LOCATION_SECRET || "change-me-cross-location";

const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-too";
// This same codebase runs as multiple separate deployments, one per shop location — this
// is the one thing that should differ between them without touching any code. Defaults to
// West Berlin so the existing NJ deployment keeps working exactly as-is if this is never set.
const SHOP_LOCATION_LABEL = process.env.SHOP_LOCATION_LABEL || "West Berlin, NJ";

// ---------- tiny JSON "database" ----------
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const fresh = { employees: [], managers: [], salesReps: [], sales: [], attendance: [], auditLog: [], cashEntries: [], calendarServiceMap: {}, ownerPinHash: null };
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  if (!db.managers) db.managers = [];
  if (!db.salesReps) db.salesReps = [];
  if (!db.attendance) db.attendance = [];
  if (!db.auditLog) db.auditLog = [];
  if (!db.cashEntries) db.cashEntries = [];
  if (!db.calendarServiceMap) db.calendarServiceMap = {};
  if (!db.tips) db.tips = [];
  if (!db.removedTips) db.removedTips = [];
  if (!db.textSettings) db.textSettings = { enabled: false, webhookUrl: "", fallbackPhone: "" };
  if (!db.textLog) db.textLog = [];
  return db;
}
// Who currently holds each role. A login cookie names a role and a person, and lasts a year, so on its own it would keep working for someone who has
// since been removed or moved to another role. Every request checks the person is still in that role. Kept in memory and refreshed on every save,
// so it costs nothing per request, and re-read from the file if a cookie names someone it hasn't seen (e.g. after a backup restore).
let rolePeople = null;
function refreshRolePeople(db) {
  rolePeople = { manager: new Set((db.managers || []).map((x) => x.id)), employee: new Set((db.employees || []).map((x) => x.id)), sales: new Set((db.salesReps || []).map((x) => x.id)) };
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  refreshRolePeople(db);
}
function hash(pin) {
  return crypto.createHash("sha256").update(String(pin)).digest("hex");
}
function newId() {
  return crypto.randomBytes(8).toString("hex");
}
// Records who changed a price, service, or sales rep assignment, and when — the actual
// answer to "who changed this and why does the number look different now."
function logAudit(db, req, sale, field, oldValue, newValue) {
  if (oldValue === newValue) return; // no real change, nothing to log
  if (!db.auditLog) db.auditLog = [];
  let actor = "Unknown";
  if (req.auth.label) actor = req.auth.label; // e.g. changes made from the combined rep tracker say so
  else if (req.auth.role === "owner") actor = "Owner";
  else if (req.auth.role === "manager") {
    const mgr = (db.managers || []).find((m) => m.id === req.auth.id);
    actor = `${mgr ? mgr.name : "Removed manager"} (manager)`;
  }
  db.auditLog.unshift({
    id: newId(), timestamp: new Date().toISOString(), actor,
    saleId: sale.id, car: sale.car, field, oldValue: oldValue === undefined ? null : oldValue, newValue,
  });
  db.auditLog = db.auditLog.slice(0, 1000); // cap size so this can't grow forever
}
// A permanent safeguard, not a separate tool to remember to run — this flags every sale
// that shares a real customer with another active sale, right where commission actually
// gets calculated. Matches by contactId when both have one (strongest signal); falls back
// to same customer name + same calendar day when contactId is missing.
function findDuplicateSaleIds(sales) {
  const flagged = new Set();
  const normalize = (s) => String(s || "").trim().toLowerCase();
  const byContact = {};
  const byNameDay = {};
  sales.forEach((s) => {
    if (s.contactId) (byContact[s.contactId] = byContact[s.contactId] || []).push(s);
    else if (s.customerName && s.date) {
      const key = `${s.customerName.trim().toLowerCase()}|${s.date.slice(0, 10)}`;
      (byNameDay[key] = byNameDay[key] || []).push(s);
    }
  });
  // Grouping by customer alone isn't safe — the same person can genuinely book more than
  // one car. Within each customer's group, only flag the ones that ALSO share the same
  // car/title text as an actual duplicate; a second, different car is a real separate job.
  function flagRealDuplicatesWithin(group) {
    // The same customer, the same title AND the same appointment time. A second appointment at a different time
    // (a second car, with an identical title) is a real separate job, not a duplicate.
    const byCar = {};
    group.forEach((s) => { const k = `${normalize(s.car)}|${String(s.date || "").slice(0, 16)}`; (byCar[k] = byCar[k] || []).push(s); });
    Object.values(byCar).forEach((carGroup) => { if (carGroup.length > 1) carGroup.forEach((s) => flagged.add(s.id)); });
  }
  Object.values(byContact).forEach(flagRealDuplicatesWithin);
  Object.values(byNameDay).forEach(flagRealDuplicatesWithin);
  return flagged;
}
function monthKey(dateStr) {
  return (dateStr || "").slice(0, 7);
}
// Business hours: Mon–Sat, 8am–6pm, Eastern time — regardless of what timezone the server
// itself runs in. This decides which of a sales rep's two commission rates applies, based
// on the moment the deal actually closed (opportunity hit Booked w/ Deposit), not the
// scheduled appointment time. Sundays are ALWAYS after-hours, all day, regardless of time.
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
  return openDays.includes(weekday) && hour >= 8 && hour < 18;
}

// True start/end of a calendar day in Eastern time, converted to the correct UTC instant.
// Every period boundary in this app needs this — using UTC midnight instead (the old way)
// meant "end of day" was actually landing around 8pm Eastern, silently excluding anything
// that happened later that same real day.
function startOfDayEastern(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return easternWallClockToUTC(y, m - 1, d, 0, 0, 0).toISOString();
}
function endOfDayEastern(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const nextDayMidnight = easternWallClockToUTC(y, m - 1, d + 1, 0, 0, 0);
  return new Date(nextDayMidnight.getTime() - 1).toISOString();
}

function dateRangeFor(query) {
  const period = query.period || "month";
  const ref = query.date ? new Date(query.date) : new Date();
  let start, end;
  if (period === "custom") {
    // A genuinely arbitrary owner-picked range - any start date through any end date,
    // inclusive of both, same Eastern-day boundaries as every other period here.
    const startDateStr = query.startDate || new Date().toISOString().slice(0, 10);
    const endDateStr = query.endDate || startDateStr;
    start = startOfDayEastern(startDateStr);
    end = endOfDayEastern(endDateStr);
  } else if (period === "day") {
    const d = query.date || new Date().toISOString().slice(0, 10);
    start = startOfDayEastern(d);
    end = endOfDayEastern(d);
  } else if (period === "week") {
    const day = ref.getUTCDay(); // 0=Sun
    const monday = new Date(ref);
    monday.setUTCDate(ref.getUTCDate() - ((day + 6) % 7));
    const mondayStr = monday.toISOString().slice(0, 10);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    const sundayStr = sunday.toISOString().slice(0, 10);
    start = startOfDayEastern(mondayStr);
    end = endOfDayEastern(sundayStr);
  } else if (period === "payperiod") {
    // Real payroll schedule: a true 14-calendar-day span, non-overlapping with adjacent
    // periods — e.g. Aug 26 through Sept 8 when Sept 8 is the payroll-processing date you
    // pick, with the very next period picking up Sept 9, not re-claiming Sept 8.
    const endDateStr = query.date || new Date().toISOString().slice(0, 10);
    const endRef = new Date(endDateStr + "T12:00:00Z"); // noon avoids any day-boundary ambiguity
    const startRef = new Date(endRef);
    startRef.setUTCDate(startRef.getUTCDate() - 13);
    start = startOfDayEastern(startRef.toISOString().slice(0, 10));
    end = endOfDayEastern(endDateStr);
  } else if (period === "year") {
    const y = query.date ? query.date.slice(0, 4) : String(ref.getUTCFullYear());
    start = startOfDayEastern(`${y}-01-01`);
    end = endOfDayEastern(`${y}-12-31`);
  } else {
    // month
    const m = query.month || new Date().toISOString().slice(0, 7);
    const [y, mo] = m.split("-").map(Number);
    const lastDay = new Date(y, mo, 0).getDate();
    start = startOfDayEastern(`${m}-01`);
    end = endOfDayEastern(`${m}-${String(lastDay).padStart(2, "0")}`);
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
const { parseTitlePricing } = require("./pricing");
const { titleSaysReschedule, titleSaysRedo } = require("./titlewords");
function saleTotal(sale) {
  return (parseFloat(sale.basePrice) || 0) + saleUpsellTotal(sale);
}
// The deposit typed at the end of the title ("$644-$50" means $50 was already paid), and what is still owed after it.
// Only the deposit is subtracted: a customer who paid $50 down online only hands over the rest at pickup.
function depositOf(sale) { return Math.max(0, parseFloat(sale.titleDeposit) || 0); }
function balanceDueOf(sale) { return Math.max(0, Math.round((saleTotal(sale) - depositOf(sale)) * 100) / 100); }
// The price is typed into the appointment title far more reliably than GHL's opportunity value gets updated, so when the
// title has one, it is the job's price. The order is: a price someone typed in here by hand (never overwritten) > the price
// in the title > GHL's opportunity value (kept on record as ghlValue so a disagreement is visible).
// A job that is already paid or completed keeps its price, since that's history that payroll and revenue already rest on.
function applyTitlePricing(db, sale, opts = {}) {
  const tp = parseTitlePricing(sale.car);
  if ((tp ? tp.total : null) !== (sale.titlePrice == null ? null : sale.titlePrice)) sale.priceMismatchDismissed = false; // a new price in the title is worth another look
  sale.titlePrice = tp ? tp.total : null;
  sale.titleDeposit = tp ? tp.deposit : null;
  if (!tp) return false;
  const missing = !((parseFloat(sale.basePrice) || 0) > 0);
  if (!opts.force) {
    if (sale.priceLocked) return false;
    if (sale.status === "cancelled") return false;
    // A price that's already there on a paid, completed or no-show job is history and stays. A price that is MISSING isn't
    // history, it's a gap (the opportunity value was never filled in), so it is filled whatever state the job is in. This is
    // what keeps those jobs out of Cleanup.
    if (!missing) {
      if ((sale.paid || sale.completed) && !opts.allowClosed) return false;
      if (sale.status === "no_show") return false;
    }
  }
  const prior = opts.priorPrice !== undefined ? opts.priorPrice : parseFloat(sale.basePrice) || 0;
  sale.priceSource = "title";
  if (Math.abs((parseFloat(sale.basePrice) || 0) - tp.total) >= 0.005) sale.basePrice = tp.total;
  if (!opts.silent && Math.abs(prior - sale.basePrice) >= 0.005) {
    if (!db.auditLog) db.auditLog = [];
    db.auditLog.unshift({ id: newId(), timestamp: new Date().toISOString(), actor: "Auto (price from the title)", saleId: sale.id, car: sale.car, field: "Base price", oldValue: prior, newValue: sale.basePrice });
    db.auditLog = db.auditLog.slice(0, 1000);
  }
  return Math.abs(prior - sale.basePrice) >= 0.005;
}
// ---- REDO jobs ----
// A title that says "redo" means the work is being done again at no charge. Such a job is flagged automatically and is FREE (price $0, whatever GHL's
// opportunity value says) UNLESS the title carries a priced extra service ("... REDO + sunstrip $50"), a price was typed in by hand, or an upsell was
// added: then it's an ordinary paid job and everything works as usual. A free redo never needs a payment, so it is left out of Unpaid Arrivals and
// Cleanup, it isn't counted as a new close, and it still appears on Job Status.
// A job that has already been paid is never zeroed: real money is on it.
function redoFree(s) { return !!s.isRedo && saleTotal(s) <= 0; }
function applyRedoRules(db, sale, opts = {}) {
  let changed = false;
  const log = (field, oldValue, newValue, actor) => {
    if (opts.silent) return;
    if (!db.auditLog) db.auditLog = [];
    db.auditLog.unshift({ id: newId(), timestamp: new Date().toISOString(), actor, saleId: sale.id, car: sale.car, field, oldValue, newValue });
    db.auditLog = db.auditLog.slice(0, 1000);
  };
  if (!sale.isRedo && !sale.redoDismissed && titleSaysRedo(sale.car)) {
    sale.isRedo = true; sale.redoAuto = true; changed = true;
    log("Redo (no charge)", false, true, "Auto (title says redo)");
  }
  if (!sale.isRedo) return changed;
  const priced = !!parseTitlePricing(sale.car);
  const was = parseFloat(sale.basePrice) || 0;
  const mayZero = opts.force ? !sale.paid : (!sale.paid && !sale.completed);   // a quiet background pass never rewrites a finished job
  if (!priced && !sale.priceLocked && was > 0 && mayZero) {
    sale.basePrice = 0; sale.priceSource = "redo"; changed = true;
    log("Base price", was, 0, "Auto (redo, no charge)");
  }
  return changed;
}
// Every place a title arrives or changes runs the price rules and then the redo rules.
function applyTitleRules(db, sale, opts = {}) {
  const priceChanged = applyTitlePricing(db, sale, opts);
  const redoChanged = applyRedoRules(db, sale, opts);
  return priceChanged || redoChanged;
}
function backfillTitlePricing(db) {
  let changed = 0;
  db.sales.forEach((sale) => { if (applyTitleRules(db, sale)) changed += 1; });
  return changed;
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
// A job dated before the owner's chosen revenue-tracking start date is excluded from
// every revenue/commission total, everywhere — but its real price is never touched, and
// it still shows up completely normally in All Jobs, Search, and the schedule.
function afterRevenueStart(sale, db) {
  if (!db.revenueStartDate) return true;
  return (sale.date || "") >= db.revenueStartDate;
}
// The one combined filter used everywhere a dollar total gets calculated.
function revenueEligible(sales, db) {
  return excludingCancelled(sales).filter((s) => afterRevenueStart(s, db));
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

  // GHL's own API (used by the bulk import) sends dates like "2026-09-03 09:00:00" — no
  // timezone marker, and not the same shape as the human-readable format below. Without
  // this, a real 9am Eastern appointment gets treated as 9am UTC and displays as 5am
  // Eastern — exactly the bug this catches. Seconds are optional here too, since a
  // datetime-local input field (used for manual date/time correction) never includes them.
  const plainFormat = !hasExplicitOffset && String(input).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (plainFormat) {
    const d = easternWallClockToUTC(parseInt(plainFormat[1], 10), parseInt(plainFormat[2], 10) - 1, parseInt(plainFormat[3], 10), parseInt(plainFormat[4], 10), parseInt(plainFormat[5], 10), parseInt(plainFormat[6] || "0", 10));
    if (!isNaN(d.getTime())) return d.toISOString();
  }

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

// One shared rule for figuring out what a "Booked By" / sales rep name actually means,
// used identically whether it arrives via the initial booking webhook or the later sync.
// A real registered sales rep name = normal commission attribution. Anything else — a
// manager, a tech, the owner personally, or just an unrecognized name — is a walk-in.
// It's never treated as an error; if it happens to match a specific manager or tech,
// they're pre-filled as the closer, otherwise it's left for a human to assign.
// Appointment titles at this shop start with the closer's initials, e.g. "DG 2024 Toyota
// Venza Ceramic Coating 499-95depo" — this pulls that leading token off and matches it
// against registered sales reps. This turned out to be more reliable than GHL's own
// "Contact Owner" field, which reflects generic account ownership, not who actually closed
// the specific deal.
// Appointment titles at this shop include the closer's initials somewhere — usually but
// not always at the start (e.g. "DG 2024 Toyota Venza Ceramic Coating 499-95depo"). This
// scans every all-caps 2-4 letter token in the title and returns the first one that
// matches a registered sales rep. This turned out to be more reliable than GHL's own
// "Contact Owner" field, which reflects generic account ownership, not who actually closed
// the specific deal.
// Known limitation, worth remembering: a car trim abbreviation (GT, RS, SS, etc.) could in
// theory collide with a rep's initials. Not a problem with the current three reps' initials
// (DG, FK, TG), but worth a second look if a future rep's initials match a common trim name.
function repFromTitleInitials(db, title) {
  if (!title) return null;
  const tokens = String(title).toUpperCase().match(/[A-Z]{2,4}/g) || [];
  for (const token of tokens) {
    const rep = db.salesReps.find((r) => r.initials && r.initials.toUpperCase() === token);
    if (rep) return rep;
  }
  return null;
}

function resolveSalesRepAttribution(db, salesRepName, appointmentTitle) {
  // Title initials are the trusted source now — proven more reliable than GHL's own
  // "Contact Owner" field, which reflects generic account ownership rather than who
  // actually closed this specific deal. Checked first, regardless of what else was sent.
  const titleRep = repFromTitleInitials(db, appointmentTitle);
  if (titleRep) return { salesRepId: titleRep.id, salesRepName: titleRep.name, isWalkIn: false };

  if (!salesRepName) return null;
  const nameLower = String(salesRepName).trim().toLowerCase();
  const rep = db.salesReps.find((r) => r.name.toLowerCase() === nameLower);
  if (rep) return { salesRepId: rep.id, salesRepName: rep.name, isWalkIn: false };
  const staffManager = db.managers.find((m) => m.name.toLowerCase() === nameLower);
  const staffEmployee = !staffManager && db.employees.find((e) => e.name.toLowerCase() === nameLower);
  const result = { salesRepId: null, salesRepName: "Walk-in (needs closer assigned)", isWalkIn: true };
  if (staffManager || staffEmployee) {
    result.walkInClosedByType = staffManager ? "manager" : "employee";
    result.walkInClosedById = staffManager ? staffManager.id : staffEmployee.id;
    result.walkInClosedByName = staffManager ? staffManager.name : staffEmployee.name;
  }
  return result;
}

// A customer can book again later under the very same GHL opportunity (a "find and update"
// booking workflow reuses it), and the tracker identifies a job by that opportunity ID. Treating
// every incoming booking for an opportunity as "an update to my existing job" meant a NEW
// appointment quietly overwrote the OLD one: it moved it to the new date and renamed it, and left
// everything else behind - the old price, the arrived/paid status, the old close time, the
// upsells. That corrupted past payroll and made the new appointment look already paid.
// This decides whether an incoming booking is the SAME appointment (an edit, or a reschedule of
// one that's still live) or a separate, later appointment for the same customer.
const EASTERN_DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const normalizeTitle = (t) => String(t || "").trim().toLowerCase();
// The words that identify the car and the service, with everything that changes when a booking is merely
// RESCHEDULED taken out: the price and deposit written into the title ("$400-$350"), the rep's initials in front,
// and markers like "rescheduled". Titles here look like "JA 2015 Toyota Camry Sides + Rear + Removal $400-$350".
function titleTokens(t) {
  const toks = String(t || "").toLowerCase()
    .replace(/\$\s*\d[\d,]*(?:\.\d+)?(?:\s*-\s*\$?\s*\d[\d,]*(?:\.\d+)?)?/g, " ")
    .replace(/\b(?:re-?scheduled?|resched|rebooked?|moved|new)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (toks.length > 2 && /^[a-z]{2,3}$/.test(toks[0]) && /^(19|20)\d\d$/.test(toks[1])) toks.shift(); // "fk 2015 toyota ..."
  return toks;
}
// The car itself: the year and make at the front of a title ("2015 toyota"). Two titles that name DIFFERENT cars are
// never the same booking, whatever else they share.
function vehicleKey(t) {
  const toks = titleTokens(t);
  return toks.length >= 2 && /^(19|20)\d\d$/.test(toks[0]) ? `${toks[0]} ${toks[1]}` : null;
}
function vehiclesDiffer(a, b) {
  const ka = vehicleKey(a), kb = vehicleKey(b);
  return !!(ka && kb && ka !== kb);
}
// "Same car and service". Comparing the raw text broke the moment anyone touched the deposit or added "WS" while
// rescheduling, which made a plain reschedule look like a brand-new deal (and a new close today).
function titlesMatch(a, b) {
  const na = normalizeTitle(a), nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const A = new Set(titleTokens(a)), B = new Set(titleTokens(b));
  if (Math.min(A.size, B.size) < 3) return false; // too little to compare safely
  let shared = 0;
  A.forEach((t) => { if (B.has(t)) shared += 1; });
  return shared / Math.min(A.size, B.size) >= 0.75;
}
// Work that was actually finished: marked complete, or the car came in and was paid once its appointment
// day had passed. Paying in advance, or paying a deposit, doesn't make a job "finished".
function isServiced(sale) {
  return !!sale.completed || (!!sale.paid && sale.status === "arrived" && Date.parse(sale.date) < Date.now());
}
// An earlier booking that is no longer going to happen: cancelled, a no-show, left unconfirmed, or an appointment whose
// day has already passed without the car coming in. A booking that is still coming up is LIVE, and a second booking next to
// a live one is a second appointment (for example another car), not a reschedule of it.
function isDeadBooking(s) {
  if (["cancelled", "no_show", "unconfirmed"].includes(s.status)) return true;
  if (s.status && s.status !== "pending") return false; // arrived: the car is here
  const ms = Date.parse(s.date);
  return !isNaN(ms) && EASTERN_DAY_FMT.format(new Date(ms)) < EASTERN_DAY_FMT.format(new Date());
}
const serviceLine = (v) => { const t = String(v || "").toLowerCase(); if (/tint/.test(t)) return "tint"; if (/ceramic|coat/.test(t)) return "ceramic"; if (/ppf|paint protection/.test(t)) return "ppf"; return ""; };
function isSeparateAppointment(existing, incomingIso, incomingTitle, incomingCalendarId, incomingService) {
  if (!incomingIso || !existing.date) return false;
  const oldMs = Date.parse(existing.date), newMs = Date.parse(incomingIso);
  if (isNaN(oldMs) || isNaN(newMs)) return false;
  // A booking on a DIFFERENT CALENDAR is a different appointment, not an edit of the first one: an edit stays on its own calendar. This is the customer who has
  // Window Tint Booking on one day and Ceramic Coating Booking on another for the same car (both under one GHL id). Without this, the second booking was taken for
  // an edit of the first: the tint appointment was rewritten into the ceramic one and vanished, and the close kept its old time so it didn't count today.
  // (Only when BOTH calendars are known. A job saved before calendars were recorded falls through to the older rules below.)
  if (incomingCalendarId && existing.calendarId) {
    if (String(incomingCalendarId) !== String(existing.calendarId)) return true;
  } else if (serviceLine(incomingService) && serviceLine(existing.baseService) && serviceLine(incomingService) !== serviceLine(existing.baseService)) {
    // The calendar isn't known on one side (a job saved before calendars were recorded, or a message that didn't carry it), so fall back to the SERVICE: a tint
    // booking and a ceramic booking for the same customer are two appointments far more often than one appointment switched between them, and a duplicate is
    // visible and fixable (Cleanup, Edit) where a swallowed appointment is silent.
    return true;
  }
  // Same Eastern day: a time tweak, or the same booking being re-synced - never a new appointment. The ONE exception is a clearly
  // DIFFERENT CAR while the first booking is still live: a customer bringing two cars in on one day. Both bookings arrive under the
  // same GHL id, and without this the second silently overwrote the first (the first car's job simply vanished).
  if (EASTERN_DAY_FMT.format(new Date(oldMs)) === EASTERN_DAY_FMT.format(new Date(newMs))) {
    return vehiclesDiffer(existing.car, incomingTitle) && !["cancelled", "no_show", "unconfirmed"].includes(existing.status);
  }
  // Finished work is history: a new booking after it is a new deal.
  if (isServiced(existing)) return true;
  // A cancellation is explicit - that deal ended, so booking again is a fresh sale.
  if (existing.status === "cancelled") return true;
  // Everything else - still pending, a no-show, an appointment nobody marked, a car that came in but wasn't
  // finished - is a deal that never got completed. Moving it to another day is a RESCHEDULE of that same
  // deal (it keeps its original closing time, so it doesn't count as a new close) as long as it's the same
  // car and service. This is what Frank does when he edits the existing appointment.
  if (titlesMatch(existing.car, incomingTitle)) return false;
  // A different CAR is a different booking, even when the old one is still upcoming (a customer with two cars).
  if (vehiclesDiffer(existing.car, incomingTitle)) return true;
  // The same car but a different service: if the old booking is still upcoming and untouched it was simply edited;
  // otherwise it's a new deal for the same customer.
  const upcoming = oldMs >= Date.now() && (!existing.status || existing.status === "pending");
  return !upcoming;
}

function upsertSaleFromGHL(db, { date, customerName, customerPhone, customerEmail, contactId, car, employeeName, salesRepName, baseService, basePrice, ghlOpportunityId, closedAt, calendarId }) {
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
  const attribution = resolveSalesRepAttribution(db, salesRepName, car);
  const incomingIso = normalizeDate(date);
  let sale = db.sales.find((s) => s.ghlOpportunityId === ghlOpportunityId);
  // Two cars on one day share ONE id: the newest job holds it and the other is filed under "<id>~earlier-...". When a booking comes round
  // again (a re-fire, a confirmation, a price change) for the OTHER car, it belongs to that car's job: update it in place, so re-firing
  // either booking never splits off a third copy or moves one car's details onto the other's job.
  // It only applies when the job holding the id is on the SAME DAY as this booking (the two-cars-one-day case), and only to a LIVE earlier job: a cancelled
  // or no-show job never absorbs a new booking (that booking would vanish into a dead job), and bookings on other days keep working exactly as before.
  if (sale && incomingIso && sale.date && vehiclesDiffer(sale.car, car) && EASTERN_DAY_FMT.format(new Date(sale.date)) === EASTERN_DAY_FMT.format(new Date(incomingIso))) {
    const dayOf = (iso) => EASTERN_DAY_FMT.format(new Date(iso));
    const itsOwn = db.sales.find((s) => s !== sale && String(s.ghlOpportunityId || "").startsWith(`${ghlOpportunityId}~earlier-`)
      && s.date && dayOf(s.date) === dayOf(incomingIso) && !vehiclesDiffer(s.car, car) && vehicleKey(s.car) && ["pending", "arrived"].includes(s.status || "pending"));
    if (itsOwn) sale = itsOwn;
  }
  let secondCarSameDay = false;       // this new job is a second car for a day that already has a live booking under this id
  if (sale && isSeparateAppointment(sale, incomingIso, car, calendarId, baseService)) {
    secondCarSameDay = !!(sale.date && incomingIso && EASTERN_DAY_FMT.format(new Date(sale.date)) === EASTERN_DAY_FMT.format(new Date(incomingIso)));
    // Same opportunity, different appointment. The old job keeps all of its own history untouched
    // but gives up its claim on the opportunity ID, so this booking - and every later event for
    // the opportunity (confirm, cancel, price changes) - lands on the new job instead.
    const oldKey = sale.ghlOpportunityId;
    sale.ghlOpportunityId = `${oldKey}~earlier-${sale.id}`;
    if (!db.auditLog) db.auditLog = [];
    db.auditLog.unshift({
      id: newId(), timestamp: new Date().toISOString(), actor: "Auto-split (new appointment)",
      saleId: sale.id, car: sale.car, field: "GHL Opportunity ID", oldValue: oldKey, newValue: sale.ghlOpportunityId,
    });
    db.auditLog = db.auditLog.slice(0, 1000);
    sale = undefined;
  }
  let isNew = !sale;
  const digitsOf = (v) => String(v || "").replace(/\D/g, "");
  const phoneKey = digitsOf(customerPhone), emailKey = String(customerEmail || "").trim().toLowerCase();
  // Who counts as "the same customer": the GHL contact when we have it, otherwise their phone or email.
  const sameCustomer = (s) => (contactId ? s.contactId === contactId
    : !!((phoneKey && digitsOf(s.customerPhone) === phoneKey) || (emailKey && String(s.customerEmail || "").trim().toLowerCase() === emailKey)));
  if (!sale && (contactId || phoneKey || emailKey)) {
    // A booking that arrives with a DIFFERENT appointment ID is a different booking - the key is the appointment's ID,
    // so one appointment is one id. The one thing we still fold into an existing job is a booking the customer had
    // left UNCONFIRMED and has now re-confirmed (GHL can hand that a fresh ID), for the same car and service.
    // We never fold a new appointment into one that is still live: a customer with two cars books two appointments,
    // very possibly with identical titles, and merging them would silently erase one of two real jobs. Matching on
    // the title alone can't tell those apart, so a duplicate is the safer mistake: it's visible (Payroll warns
    // about identical bookings at the same time) and Cleanup suggests it once the earlier one is clearly dead.
    const existingUnresolved = db.sales.find((s) =>
      sameCustomer(s) && s.status === "unconfirmed" && titlesMatch(s.car, car)
      && !isSeparateAppointment(s, incomingIso, car, calendarId, baseService)
    );
    if (existingUnresolved) {
      sale = existingUnresolved;
      isNew = false;
      const oldOppId = sale.ghlOpportunityId;
      sale.ghlOpportunityId = ghlOpportunityId; // future events for this booking now match directly
      if (oldOppId !== ghlOpportunityId) {
        if (!db.auditLog) db.auditLog = [];
        db.auditLog.unshift({
          id: newId(), timestamp: new Date().toISOString(), actor: "Auto-matched (reschedule)",
          saleId: sale.id, car: sale.car, field: "GHL Opportunity ID", oldValue: oldOppId, newValue: ghlOpportunityId,
        });
        db.auditLog = db.auditLog.slice(0, 1000);
      }
      // The customer re-confirmed a booking they'd left unconfirmed: it's a normal live appointment again.
      if (sale.status === "unconfirmed") {
        if (!db.auditLog) db.auditLog = [];
        db.auditLog.unshift({ id: newId(), timestamp: new Date().toISOString(), actor: "Auto-matched (re-confirmed)", saleId: sale.id, car: sale.car, field: "Status", oldValue: "unconfirmed", newValue: "pending" });
        db.auditLog = db.auditLog.slice(0, 1000);
        sale.status = "pending";
      }
    }
  }
  if (!sale) {
    sale = { id: newId(), ghlOpportunityId, upsells: [], status: "pending", completed: false, paid: false };
    db.sales.push(sale);
  }
  // closedAt is stamped ONCE, at the exact moment the deal was actually closed (this webhook
  // firing for the first time = the opportunity hitting Booked w/ Deposit). Later syncs
  // (like a price update) never touch it — that would let someone accidentally shift a
  // rep's commission rate after the fact just by editing the price later.
  if (isNew) {
    // A close time GHL sends is used, read the same Eastern-aware way as every other date (a time with no zone is Eastern wall-clock).
    // Without one, the close time is the moment this reached the tracker, which is right for a booking made just now, but wrong if the booking
    // is being fired again later. For an ordinary new job that is the long-standing behavior. For a SECOND CAR on a day that already has a booking
    // under the same id, it is more likely a re-fire, so it is marked for checking instead of being quietly trusted.
    const fromGhl = closedAt ? (normalizeDate(closedAt) || closedAt) : null;
    sale.closedAt = fromGhl || new Date().toISOString();
    sale.closedAtSource = fromGhl ? "ghl" : "tracker";
    if (!fromGhl && secondCarSameDay) {
      sale.closedAtCheck = true;
      if (!db.auditLog) db.auditLog = [];
      db.auditLog.unshift({ id: newId(), timestamp: new Date().toISOString(), actor: "Auto (second car, same day)", saleId: sale.id, car: car || "", field: "Closed At", oldValue: "", newValue: `${sale.closedAt} (when it reached the tracker: please check)` });
      db.auditLog = db.auditLog.slice(0, 1000);
    }
  }
  // The customer didn't show, and the appointment was moved to another day: that's the same deal being
  // rescheduled, so it's a live booking again (the no-show stays visible in Edit History).
  if (!isNew && incomingIso && sale.date && sale.status === "no_show"
      && EASTERN_DAY_FMT.format(new Date(sale.date)) !== EASTERN_DAY_FMT.format(new Date(incomingIso))) {
    if (!db.auditLog) db.auditLog = [];
    db.auditLog.unshift({ id: newId(), timestamp: new Date().toISOString(), actor: "Auto-matched (reschedule)", saleId: sale.id, car: sale.car, field: "Status", oldValue: "no_show", newValue: "pending" });
    db.auditLog = db.auditLog.slice(0, 1000);
    sale.status = "pending";
  }
  const prevSnap = isNew ? null : { service: sale.baseService, car: sale.car };
  sale.date = incomingIso || sale.date || new Date().toISOString();
  sale.customerName = customerName || sale.customerName || "";
  sale.customerPhone = customerPhone || sale.customerPhone || "";
  sale.customerEmail = customerEmail || sale.customerEmail || "";
  sale.contactId = contactId || sale.contactId || null;
  sale.car = sale.titleLocked ? (sale.car || car || "") : (car || sale.car || "");
  sale.employeeIds = matched.map((e) => e.id);
  sale.employeeNames = matched.map((e) => e.name).concat(unmatched.map((n) => n + " (unmatched)")).join(", ") || "Unassigned";
  if (attribution) {
    sale.salesRepId = attribution.salesRepId; sale.salesRepName = attribution.salesRepName; sale.isWalkIn = attribution.isWalkIn;
    if (attribution.walkInClosedByType) {
      sale.walkInClosedByType = attribution.walkInClosedByType;
      sale.walkInClosedById = attribution.walkInClosedById;
      sale.walkInClosedByName = attribution.walkInClosedByName;
    }
  }
  else if (salesRepName) { sale.salesRepId = sale.salesRepId || null; sale.salesRepName = salesRepName + " (unmatched)"; }
  else { sale.salesRepId = sale.salesRepId || null; sale.salesRepName = sale.salesRepName || "Unassigned"; }
  sale.baseService = baseService || sale.baseService || "";
  if (prevSnap && serviceLine(prevSnap.service) && serviceLine(sale.baseService) && serviceLine(prevSnap.service) !== serviceLine(sale.baseService)) {
    // An existing job just had its SERVICE swapped by an incoming booking (tint to ceramic, say). A second appointment normally stays its own job (see
    // isSeparateAppointment), so this means the two could not be told apart. Leave a plain trail so an appointment is never swallowed silently.
    if (!db.auditLog) db.auditLog = [];
    db.auditLog.unshift({ id: newId(), timestamp: new Date().toISOString(), actor: "GHL booking (replaced this job's service)", saleId: sale.id, car: sale.car, field: "Service", oldValue: prevSnap.service, newValue: sale.baseService });
    db.auditLog = db.auditLog.slice(0, 1000);
    if (!db.debugLog) db.debugLog = [];
    db.debugLog.unshift({ receivedAt: new Date().toISOString(), endpoint: "booking", note: `a booking replaced this job's service (${prevSnap.service} to ${sale.baseService}). If it was really a SECOND appointment, add the missing one with Add a missing job.`, jobs: [{ id: sale.id, was: prevSnap.car, now: sale.car }], body: null });
    db.debugLog = db.debugLog.slice(0, 30);
  }
  // GHL's opportunity value is kept on record, but it never overwrites a price someone typed in by hand, and the price in the
  // title (see applyTitlePricing) takes priority over it.
  const priceBeforeUpdate = parseFloat(sale.basePrice) || 0;
  if (basePrice !== undefined) sale.ghlValue = parseFloat(basePrice) || 0;
  if (!sale.priceLocked) sale.basePrice = basePrice !== undefined ? parseFloat(basePrice) || 0 : sale.basePrice || 0;
  else sale.basePrice = sale.basePrice || 0;
  sale.priceSource = sale.priceLocked ? "manual" : "ghl";
  applyTitleRules(db, sale, { priorPrice: priceBeforeUpdate, silent: isNew, allowClosed: true }); // a real GHL update for this booking: the title's price wins, paid or not
  autoFlagRescheduleFromTitle(db, sale); // the title says rescheduled, and there is an earlier dead booking: not a new close
  sale.calendarId = calendarId || sale.calendarId || null;
  sale.syncedFromGHL = true;
  if (!sale.status) sale.status = "pending";
  if (sale.completed === undefined) sale.completed = false;
  if (sale.paid === undefined) sale.paid = false;
  return sale;
}

// Backward/forward-compatible accessor: some records may still use the old single employeeId shape.
// Who worked a job, for display: the techs, plus any manager who helped hands-on. A job worked ONLY by a manager reads "Ivan (manager)" instead
// of "Unassigned" (tips and car commission already included that manager; the screens just never said so).
function workedByLabel(s) {
  const techs = s.employeeNames && s.employeeNames !== "Unassigned" ? s.employeeNames : "";
  const mgrs = s.managerHelperNames || "";
  if (techs && mgrs) return `${techs} + ${mgrs} (manager)`;
  if (mgrs) return `${mgrs} (manager)`;
  return techs || "Unassigned";
}
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
    else if (u.salesRepId) name = `${u.salesRepName || "Removed rep"} (sales rep)`;
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
app.use(express.static(path.join(__dirname, "public"), {
  // Always re-check the app's own files with the server, so a redeploy takes effect on the
  // very next open instead of a phone quietly running a stale copy of the old screen.
  setHeaders: (res, filePath) => { if (/\.(js|html|css)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache"); },
}));

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
  const auth = verifyAuth(req.cookies[AUTH_COOKIE]) || { role: null };
  if (auth.role && auth.role !== "owner") {
    if (!rolePeople) refreshRolePeople(loadDB());
    if (!(rolePeople[auth.role] && rolePeople[auth.role].has(auth.id))) refreshRolePeople(loadDB());        // maybe the file changed under us: look once more
    if (!(rolePeople[auth.role] && rolePeople[auth.role].has(auth.id))) { req.auth = { role: null }; return next(); }   // no longer in that role: treated as logged out
  }
  req.auth = auth;
  next();
});

// Before/after documentation — one walk-around clip per stage instead of a dozen separate
// stills. Accepts either video or a photo in that same slot, since not every phone/network
// makes video easy in the moment.
const PHOTO_SLOTS = ["walkaround"];
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTOS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".mp4";
    cb(null, `${req.params.saleId}-${req.body.stage}-${req.body.slot}-${newId()}${ext}`);
  },
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB - a real walk-around video needs real room
  fileFilter: (req, file, cb) => {
    if (!/^image\/|^video\//.test(file.mimetype)) return cb(new Error("Only image or video files are allowed."));
    cb(null, true);
  },
});

app.post("/api/sales/:saleId/photos", requireEmployee, photoUpload.single("photo"), (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.saleId);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  const { stage, slot } = req.body;
  if (!["before", "after"].includes(stage)) return res.status(400).json({ error: "stage must be 'before' or 'after'." });
  if (!PHOTO_SLOTS.includes(slot)) return res.status(400).json({ error: "Invalid photo slot." });
  if (!req.file) return res.status(400).json({ error: "No photo file received." });

  if (!sale.photos) sale.photos = { before: {}, after: {} };
  if (!sale.photos[stage]) sale.photos[stage] = {};
  // Replacing an existing photo in this slot — delete the old file so they don't pile up.
  const existing = sale.photos[stage][slot];
  if (existing) {
    const oldPath = path.join(PHOTOS_DIR, existing);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  sale.photos[stage][slot] = req.file.filename;
  saveDB(db);
  res.json({ ok: true, filename: req.file.filename });
});

app.delete("/api/sales/:saleId/photos/:stage/:slot", requireEmployee, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.saleId);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  const { stage, slot } = req.params;
  const filename = sale.photos && sale.photos[stage] && sale.photos[stage][slot];
  if (filename) {
    const filePath = path.join(PHOTOS_DIR, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    sale.photos[stage][slot] = null;
    saveDB(db);
  }
  res.json({ ok: true });
});

// Serves an actual photo file - requires login, same as everything else in this app.
app.get("/api/photos/:filename", requireEmployee, (req, res) => {
  const filePath = path.join(PHOTOS_DIR, req.params.filename);
  if (!filePath.startsWith(PHOTOS_DIR)) return res.status(400).end(); // guards against path traversal
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
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
// Any logged-in role at all - used specifically for shared things like notes, where a
// sales rep needs the same access as everyone else without also opening up unrelated
// things like upsells or photo uploads that they were never asked to have.
function requireAnyStaff(req, res, next) {
  if (["employee", "manager", "owner", "sales"].includes(req.auth.role)) return next();
  return res.status(401).json({ error: "Login required." });
}

// ---------- session / login ----------
// Public and harmless - just lets the screen confirm it's on the same release as the server.
app.get("/api/version", (req, res) => res.json({ build: BUILD }));

app.get("/api/session", (req, res) => {
  const db = loadDB();
  if (req.auth.role === "owner") return res.json({ role: "owner", shopLocation: SHOP_LOCATION_LABEL });
  if (req.auth.role === "manager") {
    const mgr = db.managers.find((m) => m.id === req.auth.id);
    if (mgr) return res.json({ role: "manager", managerId: mgr.id, name: mgr.name, shopLocation: SHOP_LOCATION_LABEL });
  }
  if (req.auth.role === "employee") {
    const emp = db.employees.find((e) => e.id === req.auth.id);
    if (emp) return res.json({ role: "employee", employeeId: emp.id, name: emp.name, shopLocation: SHOP_LOCATION_LABEL });
  }
  if (req.auth.role === "sales") {
    const rep = db.salesReps.find((r) => r.id === req.auth.id);
    if (rep) return res.json({ role: "sales", salesRepId: rep.id, name: rep.name, shopLocation: SHOP_LOCATION_LABEL });
  }
  return res.json({ role: null, ownerPinSet: !!db.ownerPinHash, shopLocation: SHOP_LOCATION_LABEL });
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

// ---------- employees (owner or manager can manage; employee can read own record) ----------
app.get("/api/employees", requireManager, (req, res) => {
  const db = loadDB();
  res.json(db.employees.map((e) => ({
    id: e.id, name: e.name, commissionRate: e.commissionRate, walkInCommissionRate: e.walkInCommissionRate || 0,
    payType: e.payType || null, salaryPerPeriod: e.salaryPerPeriod || 0, hourlyRate: e.hourlyRate || 0, carCommissionRate: e.carCommissionRate || 0,
  })));
});

app.post("/api/employees", requireManager, (req, res) => {
  const db = loadDB();
  const { name, commissionRate, walkInCommissionRate, pin, payType, salaryPerPeriod, hourlyRate, carCommissionRate } = req.body;
  if (!name || !pin) return res.status(400).json({ error: "Name and PIN are required." });
  const emp = {
    id: newId(), name: name.trim(), commissionRate: parseFloat(commissionRate) || 0, walkInCommissionRate: parseFloat(walkInCommissionRate) || 0, pinHash: hash(pin),
    payType: ["salary", "hourly", "commission"].includes(payType) ? payType : null,
    salaryPerPeriod: parseFloat(salaryPerPeriod) || 0, hourlyRate: parseFloat(hourlyRate) || 0, carCommissionRate: parseFloat(carCommissionRate) || 0,
  };
  db.employees.push(emp);
  saveDB(db);
  res.json({ id: emp.id, name: emp.name, commissionRate: emp.commissionRate, walkInCommissionRate: emp.walkInCommissionRate, payType: emp.payType, salaryPerPeriod: emp.salaryPerPeriod, hourlyRate: emp.hourlyRate, carCommissionRate: emp.carCommissionRate });
});

app.patch("/api/employees/:id", requireManager, (req, res) => {
  const db = loadDB();
  const emp = db.employees.find((e) => e.id === req.params.id);
  if (!emp) return res.status(404).json({ error: "Not found." });
  if (req.body.name) emp.name = req.body.name.trim();
  if (req.body.commissionRate !== undefined) emp.commissionRate = parseFloat(req.body.commissionRate) || 0;
  if (req.body.walkInCommissionRate !== undefined) emp.walkInCommissionRate = parseFloat(req.body.walkInCommissionRate) || 0;
  if (req.body.payType !== undefined) emp.payType = ["salary", "hourly", "commission"].includes(req.body.payType) ? req.body.payType : null;
  if (req.body.salaryPerPeriod !== undefined) emp.salaryPerPeriod = parseFloat(req.body.salaryPerPeriod) || 0;
  if (req.body.hourlyRate !== undefined) emp.hourlyRate = parseFloat(req.body.hourlyRate) || 0;
  if (req.body.carCommissionRate !== undefined) emp.carCommissionRate = parseFloat(req.body.carCommissionRate) || 0;
  if (req.body.pin) emp.pinHash = hash(req.body.pin);
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/employees/:id", requireManager, (req, res) => {
  const db = loadDB();
  db.employees = db.employees.filter((e) => e.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// Promotes a tech to manager WITHOUT losing anything they've logged. A person's history is
// attached to their ROLE, not just their name - upsells point at an "employee" or a "manager",
// and so do walk-in closes, tips and attendance - so simply moving the record would orphan all
// of it and wipe their pay history. The person keeps the same id, PIN and pay setup, and every
// reference to them is rewritten to the manager side in one pass (saved once: all or nothing).
function promoteEmployeeToManager(db, empId) {
  const emp = db.employees.find((e) => e.id === empId);
  if (!emp) return null;
  const moved = { upsells: 0, cars: 0, walkIns: 0, tips: 0, attendanceDays: 0 };

  db.managers.push({ ...emp, promotedFromEmployeeAt: new Date().toISOString() });
  db.employees = db.employees.filter((e) => e.id !== empId);

  db.sales.forEach((s) => {
    (s.upsells || []).forEach((u) => {
      if (u.employeeId === empId) { u.employeeId = null; u.managerId = empId; moved.upsells++; }
    });
    // "Techs who worked this car" becomes "Managers who also helped". Both count toward a car's
    // split (tips, car commission), so everyone else's share stays exactly what it was.
    const techIds = saleEmployeeIds(s);
    if (techIds.includes(empId)) {
      s.employeeIds = techIds.filter((id) => id !== empId);
      if (s.employeeId === empId) s.employeeId = null;
      s.employeeNames = s.employeeIds.map((id) => (db.employees.find((e) => e.id === id) || {}).name).filter(Boolean).join(", ") || "Unassigned";
      s.managerHelperIds = [...new Set([...(s.managerHelperIds || []), empId])];
      s.managerHelperNames = s.managerHelperIds.map((id) => (db.managers.find((m) => m.id === id) || {}).name).filter(Boolean).join(", ");
      moved.cars++;
    }
    if (s.walkInClosedByType === "employee" && s.walkInClosedById === empId) { s.walkInClosedByType = "manager"; moved.walkIns++; }
  });
  db.tips.forEach((t) => (t.split || []).forEach((sp) => {
    if (sp.personType === "employee" && sp.personId === empId) { sp.personType = "manager"; moved.tips++; }
  }));
  db.attendance.forEach((a) => {
    if (a.personType === "employee" && a.personId === empId) { a.personType = "manager"; moved.attendanceDays++; }
  });
  db.cashEntries.forEach((c) => { if (c.enteredByType === "employee" && c.enteredById === empId) c.enteredByType = "manager"; });
  return moved;
}

// The reverse of promoting: moves a manager to the tech side WITHOUT losing anything they've logged. Same id, PIN and pay setup; every reference to them
// is rewritten to the tech side in one pass (saved once: all or nothing), so their pay history comes with them exactly as it does the other way round.
function demoteManagerToEmployee(db, mgrId) {
  const mgr = db.managers.find((m) => m.id === mgrId);
  if (!mgr) return null;
  const moved = { upsells: 0, cars: 0, walkIns: 0, tips: 0, attendanceDays: 0 };
  const { promotedFromEmployeeAt, ...rest } = mgr;
  db.employees.push({ ...rest, demotedFromManagerAt: new Date().toISOString() });
  db.managers = db.managers.filter((m) => m.id !== mgrId);
  db.sales.forEach((s) => {
    (s.upsells || []).forEach((u) => {
      if (u.managerId === mgrId) { u.managerId = null; u.employeeId = mgrId; moved.upsells++; }
    });
    // "Managers who also helped" becomes "Techs who worked this car". Both count toward a car's split (tips, car commission), so everyone else's share is unchanged.
    if ((s.managerHelperIds || []).includes(mgrId)) {
      s.managerHelperIds = s.managerHelperIds.filter((id) => id !== mgrId);
      s.managerHelperNames = s.managerHelperIds.map((id) => (db.managers.find((m) => m.id === id) || {}).name).filter(Boolean).join(", ");
      s.employeeIds = [...new Set([...saleEmployeeIds(s), mgrId])];
      s.employeeNames = s.employeeIds.map((id) => (db.employees.find((e) => e.id === id) || {}).name).filter(Boolean).join(", ") || "Unassigned";
      moved.cars++;
    }
    if (s.walkInClosedByType === "manager" && s.walkInClosedById === mgrId) { s.walkInClosedByType = "employee"; moved.walkIns++; }
  });
  db.tips.forEach((t) => (t.split || []).forEach((sp) => {
    if (sp.personType === "manager" && sp.personId === mgrId) { sp.personType = "employee"; moved.tips++; }
  }));
  db.attendance.forEach((a) => {
    if (a.personType === "manager" && a.personId === mgrId) { a.personType = "employee"; moved.attendanceDays++; }
  });
  db.cashEntries.forEach((c) => { if (c.enteredByType === "manager" && c.enteredById === mgrId) c.enteredByType = "employee"; });
  return moved;
}

// Owner only. They lose manager access at once (the next thing they do signs them out), and the same PIN then signs them in as a tech.
// Refused if another person already uses that PIN: login takes the first match, so two people sharing a PIN could never both sign in as themselves.
app.post("/api/managers/:id/demote-to-employee", requireOwner, (req, res) => {
  const db = loadDB();
  const mgr = db.managers.find((m) => m.id === req.params.id);
  if (!mgr) return res.status(404).json({ error: "Manager not found." });
  const clash = [...db.employees.map((e) => ({ n: e.name, h: e.pinHash })), ...db.salesReps.map((r) => ({ n: r.name, h: r.pinHash })), ...db.managers.filter((m) => m.id !== mgr.id).map((m) => ({ n: m.name, h: m.pinHash }))].find((x) => x.h === mgr.pinHash);
  if (clash) return res.status(400).json({ error: `${clash.n} already uses ${mgr.name}'s PIN. Change one of the two PINs first, then try again.` });
  const name = mgr.name;
  const moved = demoteManagerToEmployee(db, req.params.id);
  saveDB(db);
  res.json({ ok: true, name, moved });
});

// Owner only. If they're logged in as an employee at that moment, the app just sends them back
// to the login screen, and the same PIN then signs them in as a manager.
app.post("/api/employees/:id/promote-to-manager", requireOwner, (req, res) => {
  const db = loadDB();
  const emp = db.employees.find((e) => e.id === req.params.id);
  if (!emp) return res.status(404).json({ error: "Employee not found." });
  const name = emp.name;
  const moved = promoteEmployeeToManager(db, req.params.id);
  saveDB(db);
  res.json({ ok: true, name, moved });
});

// ---------- managers (owner only to manage) ----------
app.get("/api/managers", requireOwner, (req, res) => {
  const db = loadDB();
  res.json(db.managers.map((m) => ({
    id: m.id, name: m.name, commissionRate: m.commissionRate || 0, walkInCommissionRate: m.walkInCommissionRate || 0,
    payType: m.payType || null, salaryPerPeriod: m.salaryPerPeriod || 0, hourlyRate: m.hourlyRate || 0, carCommissionRate: m.carCommissionRate || 0,
  })));
});

app.post("/api/managers", requireOwner, (req, res) => {
  const db = loadDB();
  const { name, pin, commissionRate, walkInCommissionRate, payType, salaryPerPeriod, hourlyRate, carCommissionRate } = req.body;
  if (!name || !pin) return res.status(400).json({ error: "Name and PIN are required." });
  const mgr = {
    id: newId(), name: name.trim(), pinHash: hash(pin), commissionRate: parseFloat(commissionRate) || 0, walkInCommissionRate: parseFloat(walkInCommissionRate) || 0,
    payType: ["salary", "hourly", "commission"].includes(payType) ? payType : null,
    salaryPerPeriod: parseFloat(salaryPerPeriod) || 0, hourlyRate: parseFloat(hourlyRate) || 0, carCommissionRate: parseFloat(carCommissionRate) || 0,
  };
  db.managers.push(mgr);
  saveDB(db);
  res.json({ id: mgr.id, name: mgr.name, commissionRate: mgr.commissionRate, walkInCommissionRate: mgr.walkInCommissionRate, payType: mgr.payType, salaryPerPeriod: mgr.salaryPerPeriod, hourlyRate: mgr.hourlyRate, carCommissionRate: mgr.carCommissionRate });
});

app.patch("/api/managers/:id", requireOwner, (req, res) => {
  const db = loadDB();
  const mgr = db.managers.find((m) => m.id === req.params.id);
  if (!mgr) return res.status(404).json({ error: "Not found." });
  if (req.body.commissionRate !== undefined) mgr.commissionRate = parseFloat(req.body.commissionRate) || 0;
  if (req.body.walkInCommissionRate !== undefined) mgr.walkInCommissionRate = parseFloat(req.body.walkInCommissionRate) || 0;
  if (req.body.payType !== undefined) mgr.payType = ["salary", "hourly", "commission"].includes(req.body.payType) ? req.body.payType : null;
  if (req.body.salaryPerPeriod !== undefined) mgr.salaryPerPeriod = parseFloat(req.body.salaryPerPeriod) || 0;
  if (req.body.hourlyRate !== undefined) mgr.hourlyRate = parseFloat(req.body.hourlyRate) || 0;
  if (req.body.carCommissionRate !== undefined) mgr.carCommissionRate = parseFloat(req.body.carCommissionRate) || 0;
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
// =====================================================================================================================================
// TEXTS TO SALES REPS (phase 1: missed appointments)
// The tracker decides WHEN and WHO; GHL does the actual texting. For each text the tracker sends a small JSON message to a GHL "inbound webhook"
// workflow (set in Settings), and that workflow sends the text. Everything is kept in a durable queue (it survives a restart), failed sends are
// retried, and every text, sent or not, is written to a log the owner can read. Nothing is sent until the owner adds the address AND switches it on.
// =====================================================================================================================================
const TEXT_DELAY_NOSHOW_MS = Number(process.env.TEXT_DELAY_NOSHOW_MS ?? 20000);      // a mis-tapped No-show can be undone before anyone is texted
const TEXT_DELAY_CANCEL_MS = Number(process.env.TEXT_DELAY_CANCEL_MS ?? 180000);     // a GHL "cancel" might really be a reschedule: wait and re-check
const TEXT_POLL_MS = Number(process.env.TEXT_POLL_MS ?? 15000);
const TEXT_RETRY_SECONDS = String(process.env.TEXT_RETRY_SECONDS || "60,300,900").split(",").map((n) => Number(n)).filter((n) => n > 0);
const TEXT_LOG_MAX = 300;
const FOLLOWUP_TIME_SCALE = Number(process.env.FOLLOWUP_TIME_SCALE ?? 1);          // tests only: makes "1 hour" take seconds


function normalizePhone(input) {                      // US numbers only: returns +1XXXXXXXXXX, or null if it isn't one
  const d = String(input || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return null;
}
function fmtPhone(e164) {
  const d = String(e164 || "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(e164 || "");
}
const fmtEasternTime = (iso) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
// "DG 2026 Toyota Corolla AllAroundTInt 485-50depo" -> "2026 Toyota Corolla AllAroundTInt" (the rep's initials and the price/deposit don't belong in a text)
function cleanCarForText(car) {
  let t = String(car || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^[A-Za-z]{2,3}\s+(?=\d{4}\b)/, "");
  t = t.replace(/\s*[-–]?\s*\$?\d{2,5}\s*\$?\s*[-–]\s*\$?\d{1,5}\s*\$?\s*(depo|deposit)\w*/ig, "");
  t = t.replace(/\s*\b\d{2,5}\$/g, "").replace(/\s*\$\d[\d,]*(\.\d+)?/g, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t.length > 60 ? t.slice(0, 57).trim() + "..." : t;
}
function textWebhookUrl(db) { return (db.textSettings && db.textSettings.webhookUrl) || process.env.REP_TEXT_WEBHOOK_URL || ""; }
function maskUrl(u) { try { const x = new URL(u); return `${x.origin}/…${u.slice(-6)}`; } catch (e) { return ""; } }
function validWebhookUrl(u) {
  try { const x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1"].includes(x.hostname)); } catch (e) { return false; }
}

function logText(db, entry) {
  if (!db.textLog) db.textLog = [];
  const e = { id: newId(), at: new Date().toISOString(), attempts: 0, ...entry };
  db.textLog.unshift(e);
  if (db.textLog.length > TEXT_LOG_MAX) db.textLog = db.textLog.filter((x, i) => i < TEXT_LOG_MAX || x.status === "pending");
  return e;
}
function scheduleTextRun(ms) { const t = setTimeout(() => { processTextQueue().catch(() => {}); }, Math.min(ms + 100, 2147000000)); if (t.unref) t.unref(); }

function composeMissedText(sale, kind, prefix) {
  const label = `SBN ${SHOP_LOCATION_LABEL}`, who = sale.customerName || "A customer", car = cleanCarForText(sale.car), time = fmtEasternTime(sale.date);
  const num = normalizePhone(sale.customerPhone), call = num ? fmtPhone(num) : "";
  if (kind === "cancelled") return `${label}: ${prefix}CANCELLED - ${who}, ${car}, was ${time} today.${call ? ` Call to rebook: ${call}.` : " No phone on file."}`;
  return `${label}: ${prefix}MISSED - ${who}, ${car}, was due ${time} today.${call ? ` Call ${call}.` : " No phone on file."}`;
}

// Called when a job turns No-show or Cancelled. Only today's appointments, only once per job, only when the owner has switched texts on.
function maybeQueueMissedText(db, sale, newStatus) {
  const ts = db.textSettings || {};
  if (!ts.enabled || sale.missedTextAt || redoFree(sale)) return;
  if (!sale.date || EASTERN_DAY_FMT.format(new Date(sale.date)) !== EASTERN_DAY_FMT.format(new Date())) return;
  const kind = newStatus === "cancelled" ? "cancelled" : "no_show";
  const rep = sale.salesRepId ? db.salesReps.find((r) => r.id === sale.salesRepId) : null;
  const base = { kind, saleId: sale.id, customerName: sale.customerName || "", car: cleanCarForText(sale.car) };
  sale.missedTextAt = new Date().toISOString();
  if (!textWebhookUrl(db)) { logText(db, { ...base, toName: rep ? rep.name : "", status: "skipped", reason: "No GHL address is set yet." }); return; }
  let toPhone = rep && rep.phone ? rep.phone : "", toName = rep ? rep.name : "", prefix = "";
  if (!toPhone && ts.fallbackPhone) { toPhone = ts.fallbackPhone; toName = "Fallback number"; prefix = rep ? `(${rep.name} has no phone saved) ` : "(no sales rep on this job) "; }
  if (!toPhone) { logText(db, { ...base, toName: rep ? rep.name : "(no rep)", status: "skipped", reason: rep ? `${rep.name} has no phone number saved, and there is no fallback number.` : "No sales rep on this job, and there is no fallback number." }); return; }
  const delay = kind === "cancelled" ? TEXT_DELAY_CANCEL_MS : TEXT_DELAY_NOSHOW_MS;
  logText(db, { ...base, toName, toPhone, message: composeMissedText(sale, kind, prefix), status: "pending", nextAt: Date.now() + delay });
  scheduleTextRun(delay);
}

let textsProcessing = false;
async function processTextQueue() {
  if (textsProcessing) return;
  textsProcessing = true;
  try {
    for (let guard = 0; guard < 50; guard++) {
      let db = loadDB();
      const due = (db.textLog || []).filter((x) => x.status === "pending" && x.nextAt <= Date.now()).pop();     // oldest first (the log is newest-first)
      if (!due) break;
      const url = textWebhookUrl(db), sale = due.saleId ? db.sales.find((s) => s.id === due.saleId) : null;
      const finish = (patch) => { const d2 = loadDB(), e = (d2.textLog || []).find((x) => x.id === due.id); if (e) { Object.assign(e, patch); saveDB(d2); } };
      if (due.kind !== "test" && !(db.textSettings && db.textSettings.enabled)) { finish({ status: "skipped", reason: "Texts were switched OFF before it was sent." }); continue; }
      // Re-check just before sending: has the job gone back to how it was (an undone mis-tap, or a reschedule)?
      if ((due.kind === "no_show" || due.kind === "cancelled") && sale && sale.status !== due.kind) {
        const d2 = loadDB(), s2 = d2.sales.find((x) => x.id === due.saleId); if (s2) s2.missedTextAt = null; saveDB(d2);
        finish({ status: "skipped", reason: due.kind === "no_show" ? "It was changed back before the text went out." : "No longer cancelled (probably rescheduled), so no text was sent." });
        continue;
      }
      if (!url) { finish({ status: "skipped", reason: "No GHL address is set." }); continue; }
      const payload = { source: "sbn-tracker", location: SHOP_LOCATION_LABEL, kind: due.kind === "no_show" ? "missed_appointment" : due.kind === "cancelled" ? "cancelled_appointment" : due.kind,
        toName: due.toName, toPhone: due.toPhone, message: due.message, customerName: due.customerName || due.contactName || "", customerPhone: sale ? (normalizePhone(sale.customerPhone) || "") : (due.contactPhone || ""), car: due.car || "",
        appointmentTime: sale ? sale.date : "", appointmentTimeEastern: sale && sale.date ? fmtEasternTime(sale.date) : "", saleId: due.saleId || "", ...(due.kind === "follow_up" ? { contactId: due.contactId || "", note: due.note || "", dueAt: due.dueAt || "" } : {}) };
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`GHL answered ${r.status}`);
        finish({ status: "sent", sentAt: new Date().toISOString(), attempts: (due.attempts || 0) + 1, reason: "" });
      } catch (e) {
        const attempts = (due.attempts || 0) + 1, wait = TEXT_RETRY_SECONDS[attempts - 1];
        const why = String((e && e.cause && e.cause.code) || (e && e.message) || e).slice(0, 120);
        if (wait) finish({ attempts, nextAt: Date.now() + wait * 1000, reason: `Retrying: ${why}` });
        else finish({ status: "failed", attempts, reason: `Gave up after ${attempts} tries: ${why}` });
        if (wait) scheduleTextRun(wait * 1000);
      }
    }
  } finally { textsProcessing = false; }
}
const textTimer = setInterval(() => { processTextQueue().catch(() => {}); }, TEXT_POLL_MS);
if (textTimer.unref) textTimer.unref();

function textsView(db) {
  const ts = db.textSettings || {}, url = textWebhookUrl(db), log = db.textLog || [];
  const lastSent = log.find((x) => x.status === "sent");
  return { enabled: !!ts.enabled, webhookConfigured: !!url, webhookMasked: url ? maskUrl(url) : "", webhookFromEnv: !!(!ts.webhookUrl && process.env.REP_TEXT_WEBHOOK_URL),
    fallbackPhone: ts.fallbackPhone || "", fallbackDisplay: ts.fallbackPhone ? fmtPhone(ts.fallbackPhone) : "", lastSentAt: lastSent ? lastSent.sentAt : null,
    pending: log.filter((x) => x.status === "pending").length, followUpsWaiting: log.filter((x) => x.status === "pending" && x.kind === "follow_up").length, failed: log.slice(0, 50).filter((x) => x.status === "failed").length,
    log: log.slice(0, 25).map((x) => ({ id: x.id, at: x.at, kind: x.kind, toName: x.toName || "", toDisplay: x.toPhone ? fmtPhone(x.toPhone) : "", customerName: x.customerName || x.contactName || "", car: x.car || "", message: x.message || "", dueAt: x.dueAt || null, status: x.status, attempts: x.attempts || 0, reason: x.reason || "", sentAt: x.sentAt || null })) };
}
app.get("/api/owner/texts", requireOwner, (req, res) => res.json(textsView(loadDB())));
app.put("/api/owner/texts", requireOwner, (req, res) => {
  const db = loadDB(), ts = db.textSettings, b = req.body || {};
  if (b.webhookUrl !== undefined) {
    const u = String(b.webhookUrl).trim();
    if (u && !validWebhookUrl(u)) return res.status(400).json({ error: "That isn't a valid address. It should start with https:// (copy it from the GHL workflow's webhook trigger)." });
    ts.webhookUrl = u;
  }
  if (b.fallbackPhone !== undefined) {
    const raw = String(b.fallbackPhone).trim();
    if (raw && !normalizePhone(raw)) return res.status(400).json({ error: "That doesn't look like a US phone number. Use 10 digits." });
    ts.fallbackPhone = raw ? normalizePhone(raw) : "";
  }
  if (b.enabled !== undefined) {
    if (b.enabled && !textWebhookUrl(db)) return res.status(400).json({ error: "Add the GHL address first, then switch texts on." });
    ts.enabled = !!b.enabled;
  }
  saveDB(db);
  res.json(textsView(db));
});
app.post("/api/owner/texts/test", requireOwner, async (req, res) => {
  const db = loadDB();
  if (!textWebhookUrl(db)) return res.status(400).json({ error: "Add the GHL address first." });
  const to = normalizePhone(req.body && req.body.phone);
  if (!to) return res.status(400).json({ error: "Enter a 10-digit US phone number to send the test to." });
  const e = logText(db, { kind: "test", toName: "Test", toPhone: to, message: `SBN ${SHOP_LOCATION_LABEL}: TEST - this is what a missed-appointment text will look like. Sent ${fmtEasternTime(new Date().toISOString())}.`, customerName: "", status: "pending", nextAt: Date.now() });
  saveDB(db);
  await processTextQueue();
  const done = (loadDB().textLog || []).find((x) => x.id === e.id) || e;
  res.json({ status: done.status, reason: done.reason || "" });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// FOLLOW-UPS. A rep puts a contact into follow-up in GHL (by adding a tag such as "fu-2h", or "fu-fk-2h" to name the rep), a small GHL workflow tells
// the tracker, and when the time comes the rep gets a text with the contact's name and number. GHL doesn't say WHO added a tag, and a contact's owner
// in GHL is often not the rep, so the rep is read from the initials in the tag first, then from the rep named in the message, then the fallback number.
// ---------------------------------------------------------------------------------------------------------------------------------------
const FU_TAG = /^(?:fu|follow[-_ ]?up)[-_ ]+(?:([a-z]{2,4})[-_ ]+)?(\d+(?:\.\d+)?\s*(?:m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)|tomorrow|tmrw)$/i;
function followUpWhen(raw, now) {            // "2h", "90m", "3d", "tomorrow" -> a due time (tomorrow = 10:00 AM Eastern)
  const t = String(raw || "").trim().toLowerCase();
  if (t === "tomorrow" || t === "tmrw") {
    const iso = normalizeDate(`${EASTERN_DAY_FMT.format(new Date(now + 24 * 3600 * 1000))} 10:00:00`);
    return iso ? { dueMs: Date.parse(iso), label: "tomorrow 10 AM" } : { error: "Couldn't work out tomorrow." };
  }
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/);
  if (!m) return { error: `I couldn't read "${raw}" as a time. Use something like 1h, 2h, 90m, 3d or tomorrow.` };
  const mins = Number(m[1]) * (/^m/.test(m[2]) ? 1 : /^h/.test(m[2]) ? 60 : 1440);
  if (!(mins >= 1 && mins <= 14 * 1440)) return { error: "A follow-up has to be between 1 minute and 14 days away." };
  return { dueMs: now + mins * 60000 * FOLLOWUP_TIME_SCALE, label: t };
}
function readFollowUp(p) {                   // finds the follow-up tag (or an explicit time) in whatever the GHL workflow sent
  const cands = []; const tags = Array.isArray(p.tags) ? p.tags : String(p.tags || p.tag || "").split(",");
  tags.map((x) => String(x).trim()).filter(Boolean).forEach((x) => cands.push(x));
  const when = p.minutes !== undefined && p.minutes !== "" ? `${p.minutes}m` : String(p.when || p.delay || "").trim();
  const hits = cands.map((c) => c.match(FU_TAG)).filter(Boolean).map((m) => ({ initials: m[1] || "", when: m[2] }));
  if (hits.length) return hits[hits.length - 1];                // tags are removed once used, so normally exactly one; if several, the last listed
  if (when) { const m = when.match(FU_TAG); return m ? { initials: m[1] || "", when: m[2] } : { initials: "", when }; }
  return null;
}
function findRepForFollowUp(db, initials, nameHint) {
  const reps = db.salesReps;
  if (initials) { const r = reps.find((x) => (x.initials || "").toLowerCase() === initials.toLowerCase()); if (r) return r; }
  const n = String(nameHint || "").trim().toLowerCase();
  if (n) {
    const exact = reps.find((x) => x.name.toLowerCase() === n || (x.initials || "").toLowerCase() === n); if (exact) return exact;
    const first = reps.filter((x) => x.name.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]); if (first.length === 1) return first[0];
  }
  return null;
}
app.post("/api/webhook/ghl/followup", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB(), p = ghlPayload(req.body), ts = db.textSettings || {};
  const name = String(p.contactName || p.name || p.fullName || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const phone = normalizePhone(p.contactPhone || p.phone);
  const contactKey = String(p.contactId || phone || name.toLowerCase());
  if (!name && !phone) return res.status(400).json({ error: "Send the contact's name or phone number." });
  const fu = readFollowUp(p);
  if (!fu) return res.status(400).json({ error: "No follow-up time found. Send a tag like fu-2h (or fu-fk-2h), or a time like 2h." });
  const due = followUpWhen(fu.when, Date.now());
  if (due.error) return res.status(400).json({ error: due.error });
  const note = String(p.note || "").replace(/\s+/g, " ").trim().slice(0, 140);
  const rep = findRepForFollowUp(db, fu.initials, p.salesRepName || p.repName || p.assignedTo || p.userName);
  const base = { kind: "follow_up", contactKey, contactId: String(p.contactId || ""), contactName: name || fmtPhone(phone), contactPhone: phone || "", note, dueAt: new Date(due.dueMs).toISOString() };
  if (!ts.enabled) { logText(db, { ...base, toName: rep ? rep.name : "", status: "skipped", reason: "Texts are switched OFF." }); saveDB(db); return res.json({ ok: true, queued: false, reason: "Texts are switched OFF." }); }
  if (!textWebhookUrl(db)) { logText(db, { ...base, toName: rep ? rep.name : "", status: "skipped", reason: "No GHL address is set yet." }); saveDB(db); return res.json({ ok: true, queued: false, reason: "No GHL address is set yet." }); }
  let toPhone = rep && rep.phone ? rep.phone : "", toName = rep ? rep.name : "", prefix = "";
  if (!toPhone && ts.fallbackPhone) { toPhone = ts.fallbackPhone; toName = "Fallback number"; prefix = rep ? `(${rep.name} has no phone saved) ` : "(no sales rep matched) "; }
  if (!toPhone) { logText(db, { ...base, toName: rep ? rep.name : "(no rep matched)", status: "skipped", reason: rep ? `${rep.name} has no phone number saved, and there is no fallback number.` : "Couldn't tell which sales rep this is for (put their initials in the tag, like fu-fk-2h), and there is no fallback number." }); saveDB(db); return res.json({ ok: true, queued: false, reason: "No one to text." }); }
  // one waiting follow-up per contact per rep: a newer one replaces the older (the rep changed their mind, or GHL sent it twice)
  (db.textLog || []).forEach((x) => { if (x.kind === "follow_up" && x.status === "pending" && x.contactKey === contactKey && x.toPhone === toPhone) { x.status = "cancelled"; x.reason = "Replaced by a newer follow-up."; } });
  const message = `SBN ${SHOP_LOCATION_LABEL}: ${prefix}FOLLOW-UP - ${base.contactName}${phone ? `, ${fmtPhone(phone)}` : ""}.${phone ? "" : " No phone on file."}${note ? ` Note: ${note}` : ""}`;
  const e = logText(db, { ...base, toName, toPhone, message, status: "pending", nextAt: due.dueMs });
  saveDB(db);
  scheduleTextRun(Math.max(0, due.dueMs - Date.now()));
  res.json({ ok: true, queued: true, id: e.id, dueAt: base.dueAt, toName, when: due.label });
});
// A rep takes a contact OUT of follow-up (e.g. adds a "fu-cancel" tag): any follow-up still waiting for that contact is cancelled.
app.post("/api/webhook/ghl/followup-cancel", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB(), p = ghlPayload(req.body);
  const phone = normalizePhone(p.contactPhone || p.phone), name = String(p.contactName || p.name || "").replace(/\s+/g, " ").trim();
  const contactKey = String(p.contactId || phone || name.toLowerCase());
  if (!contactKey) return res.status(400).json({ error: "Send the contact's id, phone or name." });
  let n = 0;
  (db.textLog || []).forEach((x) => { if (x.kind === "follow_up" && x.status === "pending" && (x.contactKey === contactKey || (phone && x.contactPhone === phone))) { x.status = "cancelled"; x.reason = "Cancelled in GHL."; n++; } });
  saveDB(db);
  res.json({ ok: true, cancelled: n });
});

// the Job status screen asks this before it offers a No-show button, so it can say a sales rep will be texted
app.get("/api/manager/texts-enabled", requireManager, (req, res) => { const db = loadDB(); res.json({ enabled: !!(db.textSettings && db.textSettings.enabled && textWebhookUrl(db)) }); });

app.get("/api/salesreps", requireOwner, (req, res) => {
  const db = loadDB();
  res.json(db.salesReps.map((r) => ({ id: r.id, name: r.name, initials: r.initials || "", commissionRate: r.commissionRate || 0, afterHoursCommissionRate: r.afterHoursCommissionRate || 0, phone: r.phone ? fmtPhone(r.phone) : "" })));
});

app.post("/api/salesreps", requireOwner, (req, res) => {
  const db = loadDB();
  const { name, pin, commissionRate, afterHoursCommissionRate, initials, phone } = req.body;
  if (!name || !pin) return res.status(400).json({ error: "Name and PIN are required." });
  if (phone && !normalizePhone(phone)) return res.status(400).json({ error: "That doesn't look like a US phone number. Use 10 digits." });
  const rep = { id: newId(), name: name.trim(), initials: (initials || "").trim().toUpperCase(), pinHash: hash(pin), commissionRate: parseFloat(commissionRate) || 0, afterHoursCommissionRate: parseFloat(afterHoursCommissionRate) || 0 };
  if (phone) rep.phone = normalizePhone(phone);
  db.salesReps.push(rep);
  saveDB(db);
  res.json({ id: rep.id, name: rep.name, initials: rep.initials, commissionRate: rep.commissionRate, afterHoursCommissionRate: rep.afterHoursCommissionRate });
});

app.patch("/api/salesreps/:id", requireOwner, (req, res) => {
  const db = loadDB();
  const rep = db.salesReps.find((r) => r.id === req.params.id);
  if (!rep) return res.status(404).json({ error: "Not found." });
  if (req.body.commissionRate !== undefined) rep.commissionRate = parseFloat(req.body.commissionRate) || 0;
  if (req.body.afterHoursCommissionRate !== undefined) rep.afterHoursCommissionRate = parseFloat(req.body.afterHoursCommissionRate) || 0;
  if (req.body.initials !== undefined) rep.initials = req.body.initials.trim().toUpperCase();
  if (req.body.phone !== undefined) {
    const raw = String(req.body.phone).trim();
    if (raw && !normalizePhone(raw)) return res.status(400).json({ error: "That doesn't look like a US phone number. Use 10 digits." });
    if (raw) rep.phone = normalizePhone(raw); else delete rep.phone;
  }
  if (req.body.pin) rep.pinHash = hash(req.body.pin);
  saveDB(db);
  res.json({ ok: true, phone: rep.phone ? fmtPhone(rep.phone) : "" });
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
  // accept the common spellings of the calendar field (the tracker only ever looked for "calendarId")
  if (!data.calendarId) { const c = data.calendar_id || data.calendarID || (data.calendar && (data.calendar.id || (typeof data.calendar === "string" ? data.calendar : ""))) || ""; if (c) data.calendarId = c; }
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
  const { contactId, basePrice, salesRepName, calendarId: syncCalendar, car: syncCar } = ghlPayload(req.body);
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
  let pool = pending.length ? pending : matches;
  // two live bookings for one customer: if the event says which calendar or car it is about, use that; otherwise the most recent, as before
  if (pool.length > 1 && syncCalendar) { const byCal = pool.filter((s) => String(s.calendarId) === String(syncCalendar)); if (byCal.length) pool = byCal; }
  if (pool.length > 1 && syncCar) { const byCar = pool.filter((s) => titlesMatch(s.car, syncCar)); if (byCar.length) pool = byCar; }
  const sale = pool.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const before = { basePrice: sale.basePrice, salesRepName: sale.salesRepName };
  if (basePrice !== undefined) {
    sale.ghlValue = parseFloat(basePrice) || 0;
    if (!sale.priceLocked) sale.basePrice = sale.ghlValue; // a price typed by hand is not replaced by GHL's value
    applyTitleRules(db, sale, { priorPrice: before.basePrice });
  }
  const attribution = resolveSalesRepAttribution(db, salesRepName, sale.car);
  if (attribution) {
    sale.salesRepId = attribution.salesRepId; sale.salesRepName = attribution.salesRepName; sale.isWalkIn = attribution.isWalkIn;
    if (attribution.walkInClosedByType) {
      sale.walkInClosedByType = attribution.walkInClosedByType;
      sale.walkInClosedById = attribution.walkInClosedById;
      sale.walkInClosedByName = attribution.walkInClosedByName;
    }
  }
  db.debugLog.unshift({
    receivedAt: new Date().toISOString(), endpoint: "sync", matchedSaleId: sale.id, before,
    after: { basePrice: sale.basePrice, salesRepName: sale.salesRepName },
    body: req.body,
  });
  db.debugLog = db.debugLog.slice(0, 30);
  saveDB(db);
  res.json({ ok: true, found: true, saleId: sale.id });
});


// Cancel, unconfirm and delete events carry only the GHL id. A customer with two cars on one day has TWO jobs under that one id, so the id
// alone can't say which car the event is about, and guessing could cancel the wrong car. If the event names the car, that decides it. If it
// doesn't, and there is more than one live booking that day, NOTHING is changed and it is written to the Debug log for the owner, which is
// safer than quietly changing the wrong job.
function resolveGhlTarget(db, body, endpoint, req) {
  const id = body.ghlOpportunityId;
  const holder = db.sales.find((s) => s.ghlOpportunityId === id);
  if (!holder) return { sale: null };
  const dayOf = (s) => (s.date ? EASTERN_DAY_FMT.format(new Date(s.date)) : "");
  // Only LIVE bookings (pending, or the car is here) can be confused with each other: a cancelled, no-show or unconfirmed one is already out of the picture.
  const live = (s) => ["pending", "arrived"].includes(s.status || "pending");
  // Bookings that can be mixed up under one id: two cars on the SAME DAY, or a second appointment on ANOTHER CALENDAR (tint one day, ceramic another).
  const otherCalendar = (s) => !!(s.calendarId && holder.calendarId && String(s.calendarId) !== String(holder.calendarId));
  const family = db.sales.filter((s) => (s === holder || String(s.ghlOpportunityId || "").startsWith(`${id}~earlier-`)) && live(s) && (s === holder || dayOf(s) === dayOf(holder) || otherCalendar(s)));
  if (family.length < 2) return { sale: holder };
  const title = body.car || body.title || body.appointmentTitle || "";
  const chose = (sale, how) => {          // the event named a calendar or a car, and that picked the job (written to the Debug log when it isn't simply the job holding the id)
    if (sale !== holder) {
      if (!db.debugLog) db.debugLog = [];
      db.debugLog.unshift({ receivedAt: new Date().toISOString(), endpoint, note: `two bookings share this id: used the ${how} named in the event to pick the job`, body: req.body, jobs: [{ id: sale.id, car: sale.car, date: sale.date }] });
      db.debugLog = db.debugLog.slice(0, 30);
    }
    return { sale };
  };
  if (body.calendarId) { const byCal = family.filter((s) => String(s.calendarId) === String(body.calendarId)); if (byCal.length === 1) return chose(byCal[0], "calendar"); }
  if (title) {
    const byTitle = family.filter((s) => titlesMatch(s.car, title));
    if (byTitle.length === 1) return chose(byTitle[0], "car");
    const key = vehicleKey(title), byCar = key ? family.filter((s) => vehicleKey(s.car) === key) : [];
    if (byCar.length === 1) return chose(byCar[0], "car");
  }
  if (!db.debugLog) db.debugLog = [];
  db.debugLog.unshift({ receivedAt: new Date().toISOString(), endpoint, failedReason: "two bookings share this id and the event doesn't say which one: nothing was changed", body: req.body, jobs: family.map((s) => ({ id: s.id, car: s.car, date: s.date, calendarId: s.calendarId || null })) });
  db.debugLog = db.debugLog.slice(0, 30);
  return { ambiguous: true };
}

// Cancellation — deliberately separate from the main webhook above. This one ONLY updates
// a job that already exists (matched by ghlOpportunityId); it never creates a new one.
// If the appointment was cancelled before it ever hit "Confirmed," there's nothing in the
// tracker to cancel, and this quietly does nothing rather than creating a phantom job.
app.post("/api/webhook/ghl/cancel", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const payload = ghlPayload(req.body);
  if (!payload.ghlOpportunityId) return res.status(400).json({ error: "ghlOpportunityId is required." });
  const target = resolveGhlTarget(db, payload, "cancel", req);
  if (target.ambiguous) { saveDB(db); return res.json({ ok: true, found: true, ambiguous: true }); }
  const sale = target.sale;
  if (!sale) return res.json({ ok: true, found: false });
  const wasCancelled = sale.status === "cancelled";
  sale.status = "cancelled";
  if (!wasCancelled) maybeQueueMissedText(db, sale, "cancelled");
  saveDB(db);
  res.json({ ok: true, found: true, saleId: sale.id });
});

// Unconfirmed — a real, distinct appointment status in GHL, separate from Cancelled. This
// means the customer hasn't confirmed they're still coming, not that they've definitely
// cancelled — worth flagging for follow-up, but not treated as dead the way a cancellation is.
app.post("/api/webhook/ghl/unconfirm", (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const payload = ghlPayload(req.body);
  if (!payload.ghlOpportunityId) return res.status(400).json({ error: "ghlOpportunityId is required." });
  const target = resolveGhlTarget(db, payload, "unconfirm", req);
  if (target.ambiguous) { saveDB(db); return res.json({ ok: true, found: true, ambiguous: true }); }
  const sale = target.sale;
  if (!sale) return res.json({ ok: true, found: false });
  sale.status = "unconfirmed";
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
  const payload = ghlPayload(req.body);
  if (!payload.ghlOpportunityId) return res.status(400).json({ error: "ghlOpportunityId is required." });
  const target = resolveGhlTarget(db, payload, "delete", req);
  if (target.ambiguous) { saveDB(db); return res.json({ ok: true, found: true, ambiguous: true }); }
  const before = db.sales.length;
  if (target.sale) db.sales = db.sales.filter((s) => s !== target.sale);
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

// ---------- manual fallback entry (owner or manager — for walk-ins or if GHL sync misses one) ----------
app.post("/api/sales", requireManager, (req, res) => {
  const db = loadDB();
  const { date, customerName, car, employeeIds, baseService, basePrice } = req.body;
  if (!car || !employeeIds || !employeeIds.length) return res.status(400).json({ error: "Car and at least one employee are required." });
  const names = employeeIds.map((id) => (db.employees.find((e) => e.id === id) || {}).name).filter(Boolean);
  // Every date in this app is compared as a raw ISO string (inRange does a plain >= / <=
  // string comparison, not a real Date comparison) - so it MUST be normalized into the
  // exact same full ISO-with-Z format everything else uses. A datetime-local input's raw
  // value ("2026-09-16T14:00", no seconds, no timezone) stored as-is would silently fail
  // to match Job Status or any calendar's date range, even though it looks fine anywhere
  // that just displays the date rather than filtering by it (like Search).
  const normalizedDate = date ? normalizeDate(date) : null;
  const initialDate = normalizedDate || new Date().toISOString();
  const sale = {
    id: newId(),
    date: initialDate,
    closedAt: initialDate, // set at creation so a later reschedule never has to guess what the original date was
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
  // Left blank, the price comes from the title ("... $644-$50"); a price typed in here is used exactly as typed.
  if ((parseFloat(basePrice) || 0) > 0) { sale.priceLocked = true; sale.priceSource = "manual"; }
  else { const tp = parseTitlePricing(sale.car); if (tp) sale.basePrice = tp.total; }
  applyTitleRules(db, sale, { silent: true }); // also records the deposit and the title's price (and notices a redo)
  db.sales.push(sale);
  saveDB(db);
  res.json({ ok: true, id: sale.id });
});

app.delete("/api/sales/:id", requireManager, (req, res) => {
  const db = loadDB();
  db.sales = db.sales.filter((s) => s.id !== req.params.id);
  // Cash that was auto-logged from this job's payment has nothing left to point at once the
  // job is gone - leaving it would overstate cash on hand with money nobody can trace.
  db.cashEntries = db.cashEntries.filter((e) => !(e.autoFromJob && e.saleId === req.params.id));
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

// So a manager can mark THEMSELVES (or another manager) as having also physically
// worked a car, separate from the tech assignment.
app.get("/api/manager/managers-list", requireManager, (req, res) => {
  const db = loadDB();
  res.json(db.managers.map((m) => ({ id: m.id, name: m.name })));
});

// So a manager can assign or fix which real sales rep gets credit for a job — no
// commission rates or PINs exposed, just names.
app.get("/api/manager/salesreps-list", requireManager, (req, res) => {
  const db = loadDB();
  res.json(db.salesReps.map((r) => ({ id: r.id, name: r.name })));
});

// ---------- attendance — who showed up, who didn't, who worked a half day ----------
// ---------- cash and expense tracker ----------
// Managers log entries but only ever see their OWN log — never shop-wide totals. Full
// visibility and editing across everyone belongs to the owner only. This is a deliberate
// boundary, not an oversight: managers track what they spend, they don't see the till.
const CASH_CATEGORIES = ["Customer Payment", "Supplies", "Tools", "Misc", "Other"];

function actorInfo(req, db) {
  if (req.auth.role === "owner") return { type: "owner", id: "owner", name: "Owner" };
  if (req.auth.role === "manager") {
    const mgr = db.managers.find((m) => m.id === req.auth.id);
    return { type: "manager", id: req.auth.id, name: mgr ? mgr.name : "Removed manager" };
  }
  if (req.auth.role === "employee") {
    const emp = db.employees.find((e) => e.id === req.auth.id);
    return { type: "employee", id: req.auth.id, name: emp ? emp.name : "Removed employee" };
  }
  if (req.auth.role === "sales") {
    const rep = db.salesReps.find((r) => r.id === req.auth.id);
    return { type: "sales", id: req.auth.id, name: rep ? rep.name : "Removed rep" };
  }
  return { type: "unknown", id: req.auth.id, name: "Unknown" };
}

app.post("/api/manager/cash-entries", requireManager, (req, res) => {
  const db = loadDB();
  const { type, amount, category, note, isOnline } = req.body;
  if (!["cashIn", "cashOut", "cardExpense", "bankDeposit"].includes(type)) return res.status(400).json({ error: "Invalid entry type." });
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: "A real amount is required." });
  const actor = actorInfo(req, db);
  // Two mistakes that wrecked the cash numbers: the same deposit entered twice (by two people), and a deposit far bigger
  // than the cash that has ever been recorded (a typo, or a total that isn't drawer cash). Neither is blocked outright,
  // but the person has to say "yes, that's right" before it counts.
  if (!req.body.confirmDuplicate && amt >= 100 && (type === "bankDeposit" || type === "cashOut")) {
    const dayAgo36 = Date.now() - 36 * 3600 * 1000;
    const twin = db.cashEntries.find((e) => e.type === type && !e.autoFromJob && Math.abs((Number(e.amount) || 0) - amt) < 0.005 && Date.parse(e.timestamp) >= dayAgo36);
    if (twin) return res.status(409).json({ needsConfirm: "duplicate", error: `${twin.enteredByName || "Someone"} already logged ${type === "bankDeposit" ? "a deposit" : "a cash-out"} of exactly $${amt.toFixed(2)} ${new Date(twin.timestamp).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. This may be the same one entered twice.` });
  }
  if (type === "bankDeposit" && !req.body.confirmOverdraw) {
    const sum = (t) => db.cashEntries.filter((e) => e.type === t).reduce((a, e) => a + (Number(e.amount) || 0), 0);
    const inDrawer = (Number(db.cashOpeningBalance) || 0) + sum("cashIn") - sum("cashOut") - sum("bankDeposit");
    if (amt > Math.max(inDrawer, 0) + 0.005) return res.status(409).json({ needsConfirm: "overdraw", error: `A $${amt.toFixed(2)} deposit is more than the cash that has been recorded as coming in. Please check the amount for a typo, and that this is cash from the drawer.` });
  }
  const entry = {
    id: newId(), type, amount: amt, category: category && CASH_CATEGORIES.includes(category) ? category : "Other",
    note: (note || "").trim(), isOnline: !!isOnline, receiptPhoto: null,
    enteredByType: actor.type, enteredById: actor.id, enteredByName: actor.name,
    timestamp: new Date().toISOString(),
  };
  db.cashEntries.unshift(entry);
  saveDB(db);
  res.json(entry);
});

// A manager's own log only — never shop-wide totals. The owner sees everyone through the
// separate /api/owner/cash-entries endpoint below.
app.get("/api/my/cash-entries", requireManager, (req, res) => {
  const db = loadDB();
  const actor = actorInfo(req, db);
  const mine = db.cashEntries.filter((e) => e.enteredByType === actor.type && e.enteredById === actor.id);
  res.json(mine.slice(0, 50));
});

app.patch("/api/manager/cash-entries/:id", requireManager, (req, res) => {
  const db = loadDB();
  const entry = db.cashEntries.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Not found." });
  const actor = actorInfo(req, db);
  // A manager can only fix their own entries; the owner can fix anyone's.
  if (actor.type !== "owner" && !(entry.enteredByType === actor.type && entry.enteredById === actor.id)) {
    return res.status(403).json({ error: "You can only edit your own entries." });
  }
  const logChange = (field, from, to) => { entry.editLog = entry.editLog || []; entry.editLog.push({ at: new Date().toISOString(), by: actor.name, field, from, to }); };
  if (req.body.amount !== undefined) {
    const newAmt = parseFloat(req.body.amount) || entry.amount;
    if (newAmt !== entry.amount) { logChange("amount", entry.amount, newAmt); entry.amount = newAmt; }
  }
  if (req.body.type !== undefined && req.body.type !== entry.type) {
    if (actor.type !== "owner") return res.status(403).json({ error: "Only the owner can change what kind of entry this is." });
    if (!["cashIn", "cashOut", "cardExpense", "bankDeposit"].includes(req.body.type)) return res.status(400).json({ error: "Invalid entry type." });
    if (entry.autoFromJob) return res.status(400).json({ error: "This cash-in belongs to a job on Job Status, so it can't be changed into something else here." });
    logChange("type", entry.type, req.body.type);
    entry.type = req.body.type;
  }
  if (req.body.category !== undefined && CASH_CATEGORIES.includes(req.body.category)) {
    if (req.body.category !== entry.category) logChange("category", entry.category, req.body.category);
    entry.category = req.body.category;
  }
  if (req.body.note !== undefined) entry.note = req.body.note.trim();
  if (req.body.isOnline !== undefined) entry.isOnline = !!req.body.isOnline;
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/manager/cash-entries/:id", requireManager, (req, res) => {
  const db = loadDB();
  const entry = db.cashEntries.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Not found." });
  const actor = actorInfo(req, db);
  if (actor.type !== "owner" && !(entry.enteredByType === actor.type && entry.enteredById === actor.id)) {
    return res.status(403).json({ error: "You can only delete your own entries." });
  }
  if (entry.receiptPhoto) {
    const p = path.join(PHOTOS_DIR, entry.receiptPhoto);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  db.cashEntries = db.cashEntries.filter((e) => e.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

const receiptUpload = multer({ storage: photoStorage, limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  if (!/^image\//.test(file.mimetype)) return cb(new Error("Receipts must be an image."));
  cb(null, true);
} });
app.post("/api/manager/cash-entries/:id/receipt", requireManager, receiptUpload.single("receipt"), (req, res) => {
  const db = loadDB();
  const entry = db.cashEntries.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Not found." });
  const actor = actorInfo(req, db);
  if (actor.type !== "owner" && !(entry.enteredByType === actor.type && entry.enteredById === actor.id)) {
    return res.status(403).json({ error: "You can only attach a receipt to your own entry." });
  }
  if (!req.file) return res.status(400).json({ error: "No receipt file received." });
  if (entry.receiptPhoto) {
    const oldPath = path.join(PHOTOS_DIR, entry.receiptPhoto);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  entry.receiptPhoto = req.file.filename;
  saveDB(db);
  res.json({ ok: true, filename: req.file.filename });
});

// Full visibility, owner-only — every entry from every manager, plus real totals.
app.get("/api/owner/cash-entries", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const entries = db.cashEntries.filter((e) => e.timestamp >= start && e.timestamp <= end);
  // "Cash in" specifically means cash collected from customers - the money that actually
  // enters the drawer. Depositing that cash into the bank is a separate, later event, and
  // reduces cash on hand the same way an expense would, but gets tracked as its own real
  // number rather than lumped in with generic spending.
  const totalCashIn = entries.filter((e) => e.type === "cashIn").reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const totalCashOut = entries.filter((e) => e.type === "cashOut").reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const totalCardExpense = entries.filter((e) => e.type === "cardExpense").reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const totalBankDeposits = entries.filter((e) => e.type === "bankDeposit").reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const byCategory = {};
  entries.filter((e) => e.type !== "cashIn" && e.type !== "bankDeposit").forEach((e) => { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount; });
  // Net Cash on Hand is a running balance - what's actually sitting in the drawer right
  // now - not a per-period metric. It's calculated from every entry ever logged, completely
  // independent of whatever Day/Week/Month/Year is selected above, plus an optional opening
  // balance for cash that was already in the drawer before tracking began.
  // It is deliberately NOT floored at zero. When deposits and cash-outs add up to more than the cash recorded as
  // coming in (typically a catch-up deposit for cash from before tracking started), flooring it to $0 made the
  // page look broken - "$550 in from customers, no deposits, $0 on hand" - with no way to see why. The honest
  // number, plus the numbers behind it, lets the owner see and fix the cause (usually by setting the opening balance).
  const allEntries = db.cashEntries;
  const allTimeCashIn = allEntries.filter((e) => e.type === "cashIn").reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const allTimeCashOut = allEntries.filter((e) => e.type === "cashOut").reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const allTimeBankDeposits = allEntries.filter((e) => e.type === "bankDeposit").reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const openingBalance = Number(db.cashOpeningBalance) || 0;
  const round2 = (n) => Math.round(n * 100) / 100;
  const inPeriod = new Set(entries.map((e) => e.id));
  // Cash that left the drawer in some OTHER period than the one on screen - the usual reason on-hand looks lower than
  // this period's numbers suggest.
  const outflowsOutsidePeriod = allEntries
    .filter((e) => (e.type === "cashOut" || e.type === "bankDeposit") && !inPeriod.has(e.id))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, 15)
    .map((e) => ({ id: e.id, type: e.type, category: e.category, amount: e.amount, note: e.note || "", enteredByName: e.enteredByName || "", timestamp: e.timestamp }));
  res.json({
    entries: entries.slice(0, 200),
    totalCashIn, totalCashOut, totalCardExpense, totalBankDeposits,
    netCash: round2(openingBalance + allTimeCashIn - allTimeCashOut - allTimeBankDeposits),
    openingBalance, openingBalanceSetAt: db.cashOpeningSetAt || null,
    allTime: { cashIn: round2(allTimeCashIn), cashOut: round2(allTimeCashOut), bankDeposits: round2(allTimeBankDeposits) },
    outflowsOutsidePeriod,
    byCategory: Object.entries(byCategory).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
  });
});

// Looks through every cash entry for the mistakes that make "cash on hand" wrong, and says exactly which entries they are:
//  - a bank deposit bigger than the cash that had been recorded as coming in at that moment (typo, or not drawer cash)
//  - the same amount entered twice within a day and a half
//  - a cash-OUT whose note says "payment" (probably money that came IN, entered the wrong way round)
function cashAuditFor(db) {
  const round2 = (n) => Math.round(n * 100) / 100;
  const all = (db.cashEntries || []).map((e) => ({ ...e, amount: Number(e.amount) || 0 }));
  const show = (e) => ({ id: e.id, type: e.type, amount: round2(e.amount), category: e.category, note: e.note || "", enteredByName: e.enteredByName || "", timestamp: e.timestamp, autoFromJob: !!e.autoFromJob });
  // 1) walk through time, tracking what was in the drawer, and note each deposit against it
  let balance = Number(db.cashOpeningBalance) || 0;
  const deposits = [];
  all.slice().sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0)).forEach((e) => {
    if (e.type === "cashIn") balance += e.amount;
    else if (e.type === "cashOut" || e.type === "bankDeposit") {
      if (e.type === "bankDeposit") {
        const over = Math.max(0, e.amount - Math.max(balance, 0));
        deposits.push({ ...show(e), balanceBefore: round2(balance), overdrawn: over > 0.005, overdrawsBy: round2(over) });
      }
      balance -= e.amount;
    }
  });
  const biggest = deposits.slice().sort((a, b) => b.amount - a.amount).slice(0, 8);
  const overdrawn = deposits.filter((d) => d.overdrawn);
  // 2) the same entry twice
  const groups = {};
  // Only deposits and larger cash-outs: two customers paying the same round amount in cash on one day is normal, so
  // matching Cash-in amounts say nothing about a repeat.
  all.filter((e) => !e.autoFromJob && !e.auditDismissed && ((e.type === "bankDeposit" && e.amount >= 25) || (e.type === "cashOut" && e.amount >= 250)))
    .forEach((e) => { const k = `${e.type}|${e.amount.toFixed(2)}`; (groups[k] = groups[k] || []).push(e); });
  const duplicates = [];
  Object.values(groups).forEach((g) => {
    g.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    for (let i = 1; i < g.length; i++) if (Date.parse(g[i].timestamp) - Date.parse(g[i - 1].timestamp) <= 36 * 3600 * 1000) duplicates.push({ first: show(g[i - 1]), second: show(g[i]) });
  });
  duplicates.sort((a, b) => b.first.amount - a.first.amount);
  // 3) cash-outs that look like money coming in
  const wrongDirection = all.filter((e) => e.type === "cashOut" && !e.autoFromJob && !e.auditDismissed && !/refund/i.test(e.note || "")).map((e) => {
    const noteSaysPayment = /\bpayment\b/i.test(e.note || "");
    const filedAsPayment = e.category === "Customer Payment";
    if (!noteSaysPayment && !filedAsPayment) return null;
    return { ...show(e), confidence: noteSaysPayment ? "high" : "low", reason: noteSaysPayment ? "The note says payment, which sounds like money coming IN." : "Filed under Customer Payment, which is the category for money coming in." };
  }).filter(Boolean).sort((a, b) => (a.confidence === b.confidence ? b.amount - a.amount : a.confidence === "high" ? -1 : 1)).slice(0, 15);
  return {
    entryCount: all.length,
    deposits: { count: deposits.length, total: round2(deposits.reduce((a, d) => a + d.amount, 0)), overdrawnCount: overdrawn.length, overdrawnTotal: round2(overdrawn.reduce((a, d) => a + d.amount, 0)), biggest },
    duplicates: duplicates.slice(0, 15),
    wrongDirection,
  };
}
app.get("/api/owner/cash-audit", requireOwner, (req, res) => res.json(cashAuditFor(loadDB())));
// "That's fine, stop flagging it" - for entries the audit suspects but the owner knows are right.
app.post("/api/owner/cash-audit/dismiss", requireOwner, (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  if (ids.length === 0 || ids.length > 100) return res.status(400).json({ error: "Nothing to dismiss." });
  const db = loadDB();
  let n = 0;
  db.cashEntries.forEach((e) => { if (ids.includes(e.id)) { e.auditDismissed = true; n += 1; } });
  saveDB(db);
  res.json({ ok: true, dismissed: n });
});

// What was already in the drawer before cash started being tracked here. Without it, a catch-up bank deposit (or any
// cash-out) for older cash makes the running balance go negative.
app.post("/api/owner/cash-opening-balance", requireOwner, (req, res) => {
  const amt = Number(req.body && req.body.amount);
  if (!isFinite(amt) || amt < 0 || amt > 1000000) return res.status(400).json({ error: "Enter what was in the drawer before tracking started: a number, 0 or more." });
  const db = loadDB();
  db.cashOpeningBalance = Math.round(amt * 100) / 100;
  db.cashOpeningSetAt = new Date().toISOString();
  saveDB(db);
  res.json({ ok: true, openingBalance: db.cashOpeningBalance });
});

app.get("/api/manager/attendance", requireManager, (req, res) => {
  const db = loadDB();
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const people = [
    ...db.employees.map((e) => ({ id: e.id, name: e.name, type: "employee" })),
    ...db.managers.map((m) => ({ id: m.id, name: m.name, type: "manager" })),
  ];
  const records = db.attendance.filter((a) => a.date === date);
  res.json(people.map((p) => {
    const rec = records.find((r) => r.personType === p.type && r.personId === p.id);
    return { ...p, status: rec ? rec.status : null, startTime: rec ? rec.startTime || "" : "", endTime: rec ? rec.endTime || "" : "" };
  }));
});

app.post("/api/manager/attendance", requireManager, (req, res) => {
  const db = loadDB();
  const { personType, personId, date, status, startTime, endTime } = req.body;
  if (!personType || !personId || !date) return res.status(400).json({ error: "personType, personId, and date are required." });
  const existing = db.attendance.find((a) => a.personType === personType && a.personId === personId && a.date === date);
  if (!status && startTime === undefined && endTime === undefined) {
    db.attendance = db.attendance.filter((a) => a !== existing);
  } else if (existing) {
    if (status !== undefined) existing.status = status;
    // Usually 9-5 or 9-6, but not every day is usual — these stay optional and blank
    // unless a manager actually fills in a different time for that specific day.
    if (startTime !== undefined) existing.startTime = startTime;
    if (endTime !== undefined) existing.endTime = endTime;
  } else {
    db.attendance.push({ id: newId(), personType, personId, date, status: status || null, startTime: startTime || "", endTime: endTime || "" });
  }
  saveDB(db);
  res.json({ ok: true });
});

// Owner-side rollup — total days present/absent/half-day per person over a period, for payroll.
app.get("/api/owner/attendance-summary", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const startDay = start.slice(0, 10), endDay = end.slice(0, 10);
  const records = db.attendance.filter((a) => a.date >= startDay && a.date <= endDay);
  const people = [
    ...db.employees.map((e) => ({ id: e.id, name: e.name, type: "employee" })),
    ...db.managers.map((m) => ({ id: m.id, name: m.name, type: "manager" })),
  ];
  res.json(people.map((p) => {
    const mine = records.filter((r) => r.personType === p.type && r.personId === p.id);
    return {
      ...p,
      present: mine.filter((r) => r.status === "present").length,
      absent: mine.filter((r) => r.status === "absent").length,
      halfDay: mine.filter((r) => r.status === "half_day").length,
    };
  }));
});

// Finds every job missing a base price or a sales rep, regardless of when it happened —
// this is the cleanup tool for catching up jobs that came in before a fix was live.
// Shown up but not yet paid — the exact gap between "Shown up" and "Total revenue" on the
// dashboard, surfaced directly instead of making someone notice the two numbers don't
// match and go hunting for why. No date restriction, same as Cleanup, since this is meant
// to catch anything that's fallen through the cracks regardless of when it happened.
app.get("/api/manager/unpaid-arrived", requireManager, (req, res) => {
  const db = loadDB();
  const jobs = db.sales.filter((s) => s.status === "arrived" && !s.paid && !redoFree(s)); // a free redo never needs paying
  res.json(jobs.map((s) => ({
    id: s.id, date: s.date, car: s.car, customerName: s.customerName, customerPhone: s.customerPhone,
    baseService: s.baseService, basePrice: s.basePrice || 0, total: saleTotal(s), employeeNames: workedByLabel(s),
  })).sort((a, b) => (a.date < b.date ? 1 : -1)));
});

// Appointments scheduled for today or any day before it that were never marked with any
// real outcome at all - not arrived, not no-show, not cancelled, not completed. This
// almost always means someone forgot to click anything after the appointment happened,
// not that the appointment genuinely hasn't occurred yet. Deliberately excludes anything
// scheduled for a future day, since those correctly haven't happened yet and shouldn't be
// flagged as a problem.
app.get("/api/manager/unmarked-appointments", requireManager, (req, res) => {
  const db = loadDB();
  const todayEastern = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const cutoff = endOfDayEastern(todayEastern);
  const jobs = db.sales.filter((s) =>
    s.date <= cutoff && !["arrived", "no_show", "cancelled"].includes(s.status) && !s.completed
  );
  res.json(jobs.map((s) => ({
    id: s.id, date: s.date, car: s.car, customerName: s.customerName, customerPhone: s.customerPhone,
    baseService: s.baseService, basePrice: s.basePrice || 0, employeeNames: workedByLabel(s),
    status: s.status || "pending",
  })).sort((a, b) => (a.date < b.date ? 1 : -1)));
});

// Jobs whose title carries a price that is different from the one the tracker is using. Open jobs fix themselves (unless the
// price was typed by hand); these are the ones that didn't: a price set by hand, or a job that is already paid or completed.
app.get("/api/manager/price-mismatches", requireManager, (req, res) => {
  const db = loadDB();
  const since = Date.now() - 45 * 24 * 3600 * 1000;
  const rows = db.sales.filter((s) => {
    if (s.status === "cancelled" || s.status === "no_show" || s.priceMismatchDismissed || redoFree(s)) return false; // a free redo is meant to be $0
    const tp = parseTitlePricing(s.car);
    return tp && Math.abs((parseFloat(s.basePrice) || 0) - tp.total) >= 0.5 && Date.parse(s.date) >= since;
  }).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 60).map((s) => {
    const tp = parseTitlePricing(s.car);
    return { id: s.id, car: s.car, customerName: s.customerName || "", date: s.date, basePrice: parseFloat(s.basePrice) || 0, titlePrice: tp.total, titleDeposit: tp.deposit, ghlValue: s.ghlValue == null ? null : s.ghlValue, priceLocked: !!s.priceLocked, closed: !!(s.paid || s.completed) };
  });
  res.json(rows);
});

app.get("/api/manager/needs-cleanup", requireManager, (req, res) => {
  const db = loadDB();
  const jobs = db.sales.filter((s) => s.status !== "cancelled" && !redoFree(s) && (!s.basePrice || (!s.salesRepId && !s.isWalkIn && !s.isOnlineBooking) || !s.baseService));
  res.json(jobs.map((s) => ({
    id: s.id, date: s.date, customerName: s.customerName, customerPhone: s.customerPhone, car: s.car,
    employeeNames: workedByLabel(s), baseService: s.baseService || "",
    salesRepId: s.salesRepId || null, salesRepName: s.salesRepName || "Unassigned", isWalkIn: !!s.isWalkIn, isOnlineBooking: !!s.isOnlineBooking,
    walkInClosedByType: s.walkInClosedByType || null, walkInClosedById: s.walkInClosedById || null, walkInClosedByName: s.walkInClosedByName || null,
    basePrice: s.basePrice || 0, titlePrice: s.titlePrice == null ? null : s.titlePrice, missingPrice: !s.basePrice, missingRep: !s.salesRepId && !s.isWalkIn && !s.isOnlineBooking, missingService: !s.baseService,
  })).sort((a, b) => (a.date < b.date ? 1 : -1)));
});

// ---------- Cross-location: for the standalone combined sales rep tracker app ----------
// Read-only and one narrow write action, all gated on CROSS_LOCATION_SECRET, never the
// session/PIN system, since these are called server-to-server with no logged-in owner.

// Raw individual close records per rep, not pre-aggregated - the combining app computes
// totals, trends, day-of-week and service breakdowns, and duplicate detection itself from
// this, so each location's own endpoint stays simple and low-risk.
app.get("/api/cross-location/salesrep-closes", (req, res) => {
  if (req.query.secret !== CROSS_LOCATION_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  // Two genuinely different questions need two different date bases. "appointment" (the
  // default) filters by when the job is scheduled and matches Payroll exactly - this is
  // what Combined's period stats need, so they agree with each location's own Payroll page.
  // "closed" filters by when the deal was actually closed, regardless of when the
  // appointment happens - this is what a live "who's closing deals today" leaderboard
  // needs, matching Closing Activity instead.
  const closedBasis = req.query.dateBasis === "closed";
  const dateBasis = closedBasis ? (s) => (s.closedAt || s.date) : (s) => s.date;
  const inRangeJobs = revenueEligible(db.sales.filter((s) => s.salesRepId && inRange(dateBasis(s), start, end)), db);
  // On the closing view a booking marked as a reschedule isn't a new close. On the appointment view (the one that
  // matches Payroll) it stays, so the rep is still paid when the client shows up.
  const relevant = (closedBasis ? inRangeJobs.filter((s) => !s.isReschedule) : inRangeJobs).filter((s) => !redoFree(s)); // on BOTH bases a free redo is not a sale, so this agrees with Payroll
  const leftOut = closedBasis ? inRangeJobs.filter((s) => s.isReschedule).map((s) => {
    const r = db.salesReps.find((x) => x.id === s.salesRepId);
    return { id: s.id, auto: !!s.rescheduleAutoFlagged, car: s.car, customerName: s.customerName, date: s.date, closedAt: s.closedAt || s.date, basePrice: parseFloat(s.basePrice) || 0, status: s.status || "pending", repName: r ? r.name : "Removed rep" };
  }) : [];
  const byRep = {};
  // On the closing view, an upsell credited to a sales rep is a close of its own (the rep sold something extra), dated when it was added. It counts toward closed value and deals
  // on the leaderboard only: it is marked isUpsell with status "upsell", so no combined screen turns it into commission, and the appointment view (which matches Payroll) never sees it.
  const upsellCloses = [];
  if (closedBasis) db.sales.filter((s) => s.status !== "cancelled" && !redoFree(s)).forEach((s) => (s.upsells || []).forEach((u) => {
    if (!u.salesRepId || !u.createdAt || !inRange(u.createdAt, start, end)) return;
    const rep = db.salesReps.find((r) => r.id === u.salesRepId); if (!rep) return;
    upsellCloses.push({ rep, close: { id: "u:" + u.id, isUpsell: true, car: `${u.name} (upsell) on ${s.car}`, customerName: s.customerName, date: s.date, closedAt: u.createdAt, basePrice: parseFloat(u.price) || 0, baseService: "Upsell", status: "upsell", duringHours: isDuringBusinessHours(u.createdAt), isReschedule: false } });
  }));
  relevant.forEach((s) => {
    const rep = db.salesReps.find((r) => r.id === s.salesRepId);
    if (!rep) return;
    if (!byRep[rep.name]) byRep[rep.name] = { name: rep.name, commissionRate: rep.commissionRate || 0, afterHoursCommissionRate: rep.afterHoursCommissionRate || 0, closes: [] };
    const duringHours = isDuringBusinessHours(s.closedAt || s.date);
    byRep[rep.name].closes.push({
      id: s.id, car: s.car, customerName: s.customerName, date: s.date, closedAt: s.closedAt || s.date,
      basePrice: parseFloat(s.basePrice) || 0, baseService: s.baseService || "", status: s.status || "pending", duringHours, isReschedule: !!s.isReschedule,
    });
  });
  upsellCloses.forEach(({ rep, close }) => { if (!byRep[rep.name]) byRep[rep.name] = { name: rep.name, commissionRate: rep.commissionRate || 0, afterHoursCommissionRate: rep.afterHoursCommissionRate || 0, closes: [] }; byRep[rep.name].closes.push(close); });
  res.json({ locationLabel: SHOP_LOCATION_LABEL, perRep: Object.values(byRep), leftOut });
});

// Same shape as the owner's own Cleanup list, so the combining app can render it identically.
app.get("/api/cross-location/cleanup-list", (req, res) => {
  if (req.query.secret !== CROSS_LOCATION_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const jobs = db.sales.filter((s) => s.status !== "cancelled" && !redoFree(s) && (!s.basePrice || (!s.salesRepId && !s.isWalkIn && !s.isOnlineBooking) || !s.baseService));
  res.json({
    locationLabel: SHOP_LOCATION_LABEL,
    jobs: jobs.map((s) => ({
      id: s.id, date: s.date, customerName: s.customerName, customerPhone: s.customerPhone, car: s.car,
      employeeNames: workedByLabel(s), baseService: s.baseService || "",
      salesRepId: s.salesRepId || null, salesRepName: s.salesRepName || "Unassigned", isWalkIn: !!s.isWalkIn, isOnlineBooking: !!s.isOnlineBooking,
      basePrice: s.basePrice || 0, titlePrice: s.titlePrice == null ? null : s.titlePrice, missingPrice: !s.basePrice, missingRep: !s.salesRepId && !s.isWalkIn && !s.isOnlineBooking, missingService: !s.baseService,
    })).sort((a, b) => (a.date < b.date ? 1 : -1)),
    possibleReschedules: findPossibleReschedules(db), leftOut: recentLeftOut(db), recentMerges: recentMerges(db),
  });
});

// Deliberately narrow - only the exact fields Cleanup itself allows fixing, nothing else.
// Same as tapping the fix directly inside this tracker; just reachable from the combined app.
app.post("/api/cross-location/cleanup-fix", (req, res) => {
  if (req.query.secret !== CROSS_LOCATION_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.body.saleId);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  const { basePrice, baseService, isWalkIn, isOnlineBooking, salesRepId } = req.body;
  if (basePrice !== undefined) { sale.basePrice = parseFloat(basePrice) || 0; if (sale.basePrice > 0) { sale.priceLocked = true; sale.priceSource = "manual"; } }
  if (baseService !== undefined) sale.baseService = baseService;
  if (isWalkIn !== undefined) sale.isWalkIn = !!isWalkIn;
  if (isOnlineBooking !== undefined) sale.isOnlineBooking = !!isOnlineBooking;
  if (salesRepId !== undefined) {
    const rep = db.salesReps.find((r) => r.id === salesRepId);
    sale.salesRepId = salesRepId;
    sale.salesRepName = rep ? rep.name : sale.salesRepName;
  }
  saveDB(db);
  res.json({ ok: true });
});

// ---------- Editing and adding jobs from the combined rep tracker ----------
// These let the owner correct or add jobs from the combined rep tracker. The edit runs through this
// shop's own job editor (patchJobHandler), so every rule - Eastern-aware times, validation, Edit
// History - is identical to editing on this shop's own screen. Edit History just says who did it.
// Each person's pay at THIS location for one pay period, for the combined rep tracker to add up across locations. Read-only, and gated on the shared secret like the
// other cross-location routes. Uses the same function as the Payroll screen (teamPayrollLines), so the numbers are the ones you'd see there. For a period whose payroll
// has already been run, it reports what the run recorded (that's what was paid, with its adjustments); otherwise the live figures plus any adjustments still waiting.
const crossSecretOk = (req) => { const given = req.get("x-cross-secret") || req.query.secret; return !!given && given === CROSS_LOCATION_SECRET; };
app.get("/api/cross-location/people-pay", (req, res) => {
  if (!crossSecretOk(req)) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB(), today = trackerToday(), all = paySchedule.periods();
  const containingIndex = all.findIndex((p) => p.start <= today && today <= p.end);
  const period = req.query.periodId ? all.find((p) => p.id === String(req.query.periodId)) : all[containingIndex];
  if (!period) return res.status(400).json({ error: "That pay period isn't known here." });
  const run = payRuns(db).find((r) => r.periodId === period.id) || null;
  const waiting = payAdjustments(db).filter((a) => !a.appliedRunId);
  const people = [];
  teamPayrollLines(db, period).forEach((l) => {
    const runLine = run && !run.skipped ? (run.lines || []).find((x) => x.key === l.key) || null : null;
    const src = runLine || l;                                   // a closed run's own numbers if there is one
    const adjustments = runLine ? runLine.adjustmentsTotal : run ? 0 : payRound(waiting.filter((a) => payKey(a.personType, a.personId) === l.key).reduce((t, a) => t + a.amount, 0));
    if (!(src.subtotal !== 0 || adjustments !== 0 || l.payType || runLine)) return;       // nobody on this person's row: leave them off, as a payroll run does
    people.push({ name: l.name, role: l.personType === "manager" ? "manager" : "tech", payType: l.payType || null,
      base: src.base, upsellCommission: src.upsellCommission, walkInCommission: src.walkInCommission, tips: src.tips, subtotal: src.subtotal,
      adjustments, total: payRound(src.subtotal + adjustments), daysPresent: src.daysPresent || 0,
      changedSinceRun: !!(runLine && payRound(l.subtotal) !== runLine.subtotal) });
  });
  let warnings = [];
  try { warnings = payrollPreview(db, period).warnings.map((w) => ({ code: w.code, count: w.count, text: w.text, items: (w.items || []).slice(0, 12) })); } catch (e) { warnings = []; }
  res.json({ location: SHOP_LOCATION_LABEL, warnings, state: run ? (run.skipped ? "skipped" : "run") : "open", runClosedAt: run && !run.skipped ? run.closedAt : null,
    period: { id: period.id, start: period.start, end: period.end, name: period.name, kind: period.kind, workDays: period.workDays, submit: period.submit || null, paid: period.paid || null },
    people, ...(req.query.list ? { containingIndex, periods: all.map((p) => ({ id: p.id, start: p.start, end: p.end, name: p.name, kind: p.kind, paid: p.paid || null })) } : {}) });
});

// Sales rep pay at THIS location for one date range (their pay period is its own Thursday-to-Wednesday cycle). Read-only. Same figures as the Payroll screen's sales rep section.
app.get("/api/cross-location/salesrep-pay", (req, res) => {
  if (!crossSecretOk(req)) return res.status(401).json({ error: "Bad secret." });
  const ymd = /^\d{4}-\d{2}-\d{2}$/, start = String(req.query.start || ""), end = String(req.query.end || "");
  if (!ymd.test(start) || !ymd.test(end) || start > end) return res.status(400).json({ error: "A start and end date (YYYY-MM-DD) are required." });
  const p = buildPayroll(loadDB(), { period: "custom", startDate: start, endDate: end });
  res.json({ location: SHOP_LOCATION_LABEL, start, end, reps: (p.salesReps || []).map((r) => ({ name: r.name, commissionRate: r.commissionRate || 0, afterHoursCommissionRate: r.afterHoursCommissionRate || 0,
    totalBooked: r.totalBooked, showedCount: r.showedCount, noShowCount: r.noShowCount, showedValue: r.showedValue, commission: r.commission, duringHoursCount: r.duringHoursCount, afterHoursCount: r.afterHoursCount, duplicateCount: (r.duplicateWarnings || []).length })) });
});

// ===== Find an appointment and add an upsell: used by the rep tracker's sales-team screen. Secret-gated, like the other cross-location routes. =====
const repKey = (n) => String(n || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const upsellCreditName = (db, u) => (u.salesRepId ? (u.salesRepName || "Removed rep") + " (sales rep)" : u.employeeId ? ((db.employees.find((e) => e.id === u.employeeId) || {}).name || "Removed tech") + " (tech)" : u.managerId ? ((db.managers.find((m) => m.id === u.managerId) || {}).name || "Removed manager") + " (manager)" : "Unassigned");
// Search every appointment from 60 days back to 180 days ahead by customer name, car, service, rep or phone digits. Never returns a phone number or email.
app.get("/api/cross-location/appointments-search", (req, res) => {
  if (!crossSecretOk(req)) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB(), q = String(req.query.q || "").trim().toLowerCase(), digits = q.replace(/\D/g, "");
  if (q.length < 2) return res.json({ location: SHOP_LOCATION_LABEL, results: [] });
  const tokens = q.split(/\s+/).filter(Boolean), now = Date.now(), lo = now - 60 * 86400000, hi = now + 180 * 86400000;
  const hits = db.sales.filter((s) => {
    if (s.status === "cancelled") return false;
    const t = Date.parse(s.date); if (isNaN(t) || t < lo || t > hi) return false;
    const rep = s.salesRepId ? (db.salesReps.find((r) => r.id === s.salesRepId) || {}).name || "" : "";
    const hay = `${s.customerName || ""} ${s.car || ""} ${s.baseService || ""} ${rep}`.toLowerCase();
    return tokens.every((tk) => hay.includes(tk)) || (digits.length >= 4 && String(s.customerPhone || "").replace(/\D/g, "").includes(digits));
  }).sort((a, b) => Math.abs(Date.parse(a.date) - now) - Math.abs(Date.parse(b.date) - now)).slice(0, 25);
  res.json({ location: SHOP_LOCATION_LABEL, results: hits.map((s) => ({ id: s.id, car: s.car, customerName: s.customerName || "", date: s.date, baseService: s.baseService || "", status: s.status || "pending",
    salesRepName: s.salesRepId ? ((db.salesReps.find((r) => r.id === s.salesRepId) || {}).name || null) : null, isOnlineBooking: !!s.isOnlineBooking, isWalkIn: !!s.isWalkIn,
    upsells: (s.upsells || []).map((u) => ({ id: u.id, name: u.name, price: u.price, creditedTo: upsellCreditName(db, u), addedVia: u.addedVia || null, createdAt: u.createdAt || null })) })) });
});
const auditAdd = (db, entry) => { if (!db.auditLog) db.auditLog = []; db.auditLog.unshift({ id: newId(), timestamp: new Date().toISOString(), ...entry }); db.auditLog = db.auditLog.slice(0, 1000); };
// Add an upsell to an appointment, credited to a named sales rep (who must be set up at this location).
app.post("/api/cross-location/rep-upsell", (req, res) => {
  if (!crossSecretOk(req)) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB(), { saleId, name, price, creditName, addedBy } = req.body || {};
  const sale = db.sales.find((s) => s.id === saleId);
  if (!sale) return res.status(404).json({ error: "That appointment wasn't found." });
  if (sale.status === "cancelled") return res.status(400).json({ error: "That appointment is cancelled." });
  const label = String(name || "").trim(), amt = Number(price);
  if (!label || label.length > 60) return res.status(400).json({ error: "Give the upsell a name (up to 60 characters)." });
  if (!isFinite(amt) || amt <= 0 || amt > 100000) return res.status(400).json({ error: "Enter the upsell's price, more than $0." });
  const rep = db.salesReps.find((r) => repKey(r.name) === repKey(creditName));
  if (!rep) return res.status(400).json({ error: `"${creditName || ""}" isn't set up as a sales rep at ${SHOP_LOCATION_LABEL}. Add them on that location's Sales Reps page first.` });
  sale.upsells = sale.upsells || [];
  const now = Date.now();
  if (sale.upsells.some((u) => u.salesRepId === rep.id && u.name === label && Number(u.price) === amt && u.createdAt && now - Date.parse(u.createdAt) < 120000)) return res.status(409).json({ error: "That exact upsell was just added. Not adding it twice." });
  const upsell = { id: newId(), name: label, price: Math.round(amt * 100) / 100, employeeId: null, managerId: null, salesRepId: rep.id, salesRepName: rep.name, createdAt: new Date(now).toISOString(), addedVia: "rep-tracker", addedBy: String(addedBy || "").slice(0, 60) };
  sale.upsells.push(upsell);
  auditAdd(db, { actor: `Rep tracker (${upsell.addedBy || "unknown"})`, saleId: sale.id, car: sale.car, field: "Upsell added", oldValue: "", newValue: `${label} $${upsell.price} credited to ${rep.name}` });
  saveDB(db);
  res.json({ ok: true, location: SHOP_LOCATION_LABEL, upsell: { id: upsell.id, name: upsell.name, price: upsell.price, creditedTo: rep.name, createdAt: upsell.createdAt } });
});
// Undo: only the person who added it (by name) and only within 30 minutes. The owner can remove any upsell from this location's own tracker.
app.post("/api/cross-location/rep-upsell/undo", (req, res) => {
  if (!crossSecretOk(req)) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB(), { saleId, upsellId, addedBy } = req.body || {};
  const sale = db.sales.find((s) => s.id === saleId), u = sale && (sale.upsells || []).find((x) => x.id === upsellId);
  if (!u) return res.status(404).json({ error: "That upsell wasn't found." });
  if (u.addedVia !== "rep-tracker" || repKey(u.addedBy) !== repKey(addedBy)) return res.status(403).json({ error: "Only the person who added an upsell can undo it. Ask the owner to remove it." });
  if (!u.createdAt || Date.now() - Date.parse(u.createdAt) > 30 * 60000) return res.status(403).json({ error: "It's been more than 30 minutes, so only the owner can remove it now." });
  sale.upsells = sale.upsells.filter((x) => x.id !== upsellId);
  auditAdd(db, { actor: `Rep tracker (${u.addedBy})`, saleId: sale.id, car: sale.car, field: "Upsell removed", oldValue: `${u.name} $${u.price} credited to ${u.salesRepName}`, newValue: "" });
  saveDB(db); res.json({ ok: true });
});
// Upsells a rep has had credited since the start of today (Eastern), for the "My upsells today" list.
app.get("/api/cross-location/rep-upsells", (req, res) => {
  if (!crossSecretOk(req)) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB(), who = repKey(req.query.name), me = repKey(req.query.addedBy || req.query.name), today = EASTERN_DAY_FMT.format(new Date()), out = [];
  db.sales.forEach((s) => (s.upsells || []).forEach((u) => {
    if (!u.salesRepId || repKey(u.salesRepName) !== who || !u.createdAt || EASTERN_DAY_FMT.format(new Date(u.createdAt)) !== today) return;
    out.push({ saleId: s.id, upsellId: u.id, name: u.name, price: u.price, car: s.car, customerName: s.customerName || "", createdAt: u.createdAt, addedBy: u.addedBy || "", canUndo: u.addedVia === "rep-tracker" && repKey(u.addedBy) === me && Date.now() - Date.parse(u.createdAt) <= 30 * 60000 });
  }));
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ location: SHOP_LOCATION_LABEL, upsells: out });
});

app.get("/api/cross-location/salesreps", (req, res) => {
  if (req.query.secret !== CROSS_LOCATION_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  res.json({ locationLabel: SHOP_LOCATION_LABEL, salesReps: db.salesReps.map((r) => ({ id: r.id, name: r.name })) });
});

// Only these fields can be changed from there - nothing about payments, techs, upsells or deleting.
const CROSS_EDITABLE = ["closedAt", "date", "car", "basePrice", "baseService", "salesRepId", "isWalkIn", "isOnlineBooking", "status", "isReschedule", "rescheduleDismissed"];
app.post("/api/cross-location/job-edit", (req, res) => {
  if (req.query.secret !== CROSS_LOCATION_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.body.saleId);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  const body = {};
  CROSS_EDITABLE.forEach((k) => { if (req.body[k] !== undefined) body[k] = req.body[k]; });
  // Checked up front so a bad value gets a clear message instead of being silently ignored.
  if (body.closedAt !== undefined && !normalizeDate(body.closedAt)) return res.status(400).json({ error: "That closing time isn't a valid date and time." });
  if (body.date !== undefined && !normalizeDate(body.date)) return res.status(400).json({ error: "That appointment time isn't a valid date and time." });
  if (body.basePrice !== undefined && !(parseFloat(body.basePrice) >= 0)) return res.status(400).json({ error: "Price must be a number, 0 or more." });
  if (body.car !== undefined && !String(body.car).trim()) return res.status(400).json({ error: "The title can't be empty." });
  if (body.status !== undefined && !["pending", "arrived", "no_show", "cancelled"].includes(body.status)) return res.status(400).json({ error: "Unknown status." });
  if (body.salesRepId !== undefined && !db.salesReps.some((r) => r.id === body.salesRepId)) return res.status(400).json({ error: "That sales rep doesn't exist at this location." });
  if ((body.isReschedule !== undefined && typeof body.isReschedule !== "boolean") || (body.rescheduleDismissed !== undefined && typeof body.rescheduleDismissed !== "boolean")) return res.status(400).json({ error: "That must be true or false." });
  req.params = { id: sale.id };
  req.body = body;
  req.auth = { role: "owner", id: "rep-tracker", label: "Rep tracker (owner)" };
  // Say which fields were actually applied, so the caller can tell a tracker that hasn't been updated yet
  // (it would silently ignore a field it doesn't know) from one that really did the change.
  const sendJson = res.json.bind(res);
  res.json = (obj) => sendJson(obj && obj.ok ? { ...obj, applied: Object.keys(body) } : obj);
  return patchJobHandler(req, res);
});

// Adds a job that never made it into the tracker. Unlike the shop's own add-job form it needs no
// tech, and it takes the sales rep and the REAL closing time, since those decide the commission.
app.post("/api/cross-location/job-add", (req, res) => {
  if (req.query.secret !== CROSS_LOCATION_SECRET) return res.status(401).json({ error: "Bad secret." });
  const db = loadDB();
  const { customerName, car, date, closedAt, basePrice, baseService, salesRepId, isWalkIn, isOnlineBooking, status, force } = req.body;
  if (!String(car || "").trim()) return res.status(400).json({ error: "Enter the car / title." });
  const apptIso = normalizeDate(date);
  if (!apptIso) return res.status(400).json({ error: "Enter the appointment date and time." });
  const closedIso = closedAt ? normalizeDate(closedAt) : new Date().toISOString();
  if (!closedIso) return res.status(400).json({ error: "That closing time isn't a valid date and time." });
  const typedPrice = basePrice === undefined || basePrice === null || basePrice === "" ? 0 : parseFloat(basePrice);
  if (!(typedPrice >= 0)) return res.status(400).json({ error: "Price must be a number, 0 or more." });
  // Left blank, the price comes from the title ("... $644-$50"); a price typed here is used as typed.
  const titlePricing = parseTitlePricing(car);
  const price = typedPrice > 0 ? typedPrice : (titlePricing ? titlePricing.total : 0);
  const st = status || "pending";
  if (!["pending", "arrived", "no_show"].includes(st)) return res.status(400).json({ error: "Unknown status." });
  let rep = null;
  if (salesRepId) {
    rep = db.salesReps.find((r) => r.id === salesRepId);
    if (!rep) return res.status(400).json({ error: "That sales rep doesn't exist at this location." });
  }
  // The most likely mistake is adding something that's already there - same customer, similar title,
  // same day. Say so first; the caller can resend with force to add it anyway.
  const cust = String(customerName || "").trim().toLowerCase();
  const title = String(car).trim().toLowerCase();
  if (cust && !force) {
    const dupe = db.sales.find((s) => s.status !== "cancelled" && String(s.customerName || "").trim().toLowerCase() === cust
      && EASTERN_DAY_FMT.format(new Date(s.date)) === EASTERN_DAY_FMT.format(new Date(apptIso))
      && (String(s.car || "").toLowerCase().includes(title) || title.includes(String(s.car || "").toLowerCase())));
    if (dupe) return res.status(409).json({ duplicate: true, error: `A job for ${customerName.trim()} with a similar title is already on the books for that day.`, existing: { id: dupe.id, car: dupe.car, date: dupe.date } });
  }
  const sale = {
    id: newId(), date: apptIso, closedAt: closedIso, customerName: String(customerName || "").trim(), car: String(car).trim(),
    employeeIds: [], employeeNames: "Unassigned", baseService: baseService || "", basePrice: price,
    syncedFromGHL: false, upsells: [], status: st, completed: false, paid: false,
    salesRepId: null, salesRepName: "Unassigned", isWalkIn: false, isOnlineBooking: false,
  };
  if (isWalkIn) { sale.isWalkIn = true; sale.salesRepName = "Walk-in (booked by staff)"; }
  else if (isOnlineBooking) { sale.isOnlineBooking = true; sale.salesRepName = "Online Booking"; }
  else if (rep) { sale.salesRepId = rep.id; sale.salesRepName = rep.name; }
  if (typedPrice > 0) { sale.priceLocked = true; sale.priceSource = "manual"; } // typed in the add form: used exactly as typed
  applyTitleRules(db, sale, { silent: true }); // records the deposit and the title's price too (and notices a redo)
  db.sales.push(sale);
  if (!db.auditLog) db.auditLog = [];
  db.auditLog.unshift({ id: newId(), timestamp: new Date().toISOString(), actor: "Rep tracker (owner)", saleId: sale.id, car: sale.car, field: "Job added", oldValue: null, newValue: `${sale.salesRepName} · $${sale.basePrice}` });
  db.auditLog = db.auditLog.slice(0, 1000);
  saveDB(db);
  res.json({ ok: true, id: sale.id });
});

// Auto-fix as much of Cleanup as can be safely derived from data already on the job —
// the car/title text — using the exact same detection already proven for the live GHL
// flow and bulk import. Only acts when a real pattern is found; price can never be
// guessed and always needs a human, so it's reported but never touched here.
app.post("/api/manager/cleanup-auto-fix", requireManager, (req, res) => {
  const db = loadDB();
  const dryRun = !!req.body.dryRun;
  const jobs = db.sales.filter((s) => s.status !== "cancelled" && (!s.basePrice || (!s.salesRepId && !s.isWalkIn) || !s.baseService));
  const results = { fixedService: 0, fixedRep: 0, stillNeedsPrice: 0, stillNeedsManualService: 0, stillNeedsManualRep: 0, preview: [] };

  jobs.forEach((s) => {
    const hadService = !!s.baseService;
    const hadRep = !!(s.salesRepId || s.isWalkIn);
    const hadPrice = !!s.basePrice;

    let serviceFix = null, repFix = null;
    if (!hadService) {
      const guessed = guessServiceFromTitle(s.car);
      if (guessed) serviceFix = guessed;
    }
    if (!hadRep) {
      const rep = repFromTitleInitials(db, s.car);
      if (rep) repFix = rep;
    }

    if (serviceFix || repFix) {
      results.preview.push({ id: s.id, car: s.car, serviceFix, repFix: repFix ? repFix.name : null });
      if (!dryRun) {
        if (serviceFix) { logAudit(db, req, s, "Service", s.baseService, serviceFix); s.baseService = serviceFix; }
        if (repFix) { logAudit(db, req, s, "Sales rep", s.salesRepName, repFix.name); s.salesRepId = repFix.id; s.salesRepName = repFix.name; s.isWalkIn = false; }
      }
      if (serviceFix) results.fixedService++;
      if (repFix) results.fixedRep++;
    }

    if (!hadPrice) results.stillNeedsPrice++;
    if (!hadService && !serviceFix) results.stillNeedsManualService++;
    if (!hadRep && !repFix) results.stillNeedsManualRep++;
  });

  if (!dryRun) saveDB(db);
  res.json({ ok: true, dryRun, totalJobsChecked: jobs.length, ...results });
});

// Bulk-mark several jobs as Online Booking at once — for the real scenario where a
// backlog of genuine website self-bookings all sit flagged as "missing a rep" simply
// because nobody typed initials into a title nobody filled out themselves.
app.post("/api/manager/cleanup-mark-online", requireManager, (req, res) => {
  const db = loadDB();
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "No jobs selected." });
  let fixed = 0;
  ids.forEach((id) => {
    const sale = db.sales.find((s) => s.id === id);
    if (!sale) return;
    logAudit(db, req, sale, "Sales rep", sale.salesRepName, "Online Booking");
    sale.isOnlineBooking = true;
    sale.salesRepId = null; sale.salesRepName = "Online Booking"; sale.isWalkIn = false;
    sale.walkInClosedByType = null; sale.walkInClosedById = null; sale.walkInClosedByName = null;
    fixed++;
  });
  saveDB(db);
  res.json({ ok: true, fixed });
});

// Which GHL calendar means which service — a far more reliable signal than the title text,
// since a genuine online booking's title is often just the customer's name with nothing to
// guess a service from at all. The calendar itself is unambiguous.
app.get("/api/manager/calendar-service-map", requireManager, (req, res) => {
  const db = loadDB();
  // Every distinct calendarId already seen in the data, with one real example so the owner
  // can recognize which is which without needing to go look it up in GHL.
  const seen = {};
  db.sales.filter((s) => s.calendarId).forEach((s) => {
    if (!seen[s.calendarId]) seen[s.calendarId] = { calendarId: s.calendarId, exampleCar: s.car, exampleService: s.baseService || "" };
  });
  res.json({ map: db.calendarServiceMap || {}, seenCalendars: Object.values(seen) });
});

app.post("/api/manager/calendar-service-map", requireManager, (req, res) => {
  const db = loadDB();
  const { calendarId, service } = req.body;
  if (!calendarId || !service) return res.status(400).json({ error: "calendarId and service are required." });
  if (!db.calendarServiceMap) db.calendarServiceMap = {};
  db.calendarServiceMap[calendarId] = service;
  saveDB(db);
  res.json({ ok: true, map: db.calendarServiceMap });
});

// Re-checks every job still missing a service against the calendar mapping above — for
// jobs that already have a calendarId stored but no title-text keyword to guess from.
app.post("/api/manager/cleanup-fix-by-calendar", requireManager, (req, res) => {
  const db = loadDB();
  const dryRun = !!req.body.dryRun;
  const map = db.calendarServiceMap || {};
  const jobs = db.sales.filter((s) => s.status !== "cancelled" && !s.baseService && s.calendarId && map[s.calendarId]);
  const preview = jobs.map((s) => ({ id: s.id, car: s.car, calendarId: s.calendarId, serviceFix: map[s.calendarId] }));
  if (!dryRun) {
    jobs.forEach((s) => {
      logAudit(db, req, s, "Service", s.baseService, map[s.calendarId]);
      s.baseService = map[s.calendarId];
    });
    saveDB(db);
  }
  res.json({ ok: true, dryRun, fixed: jobs.length, preview });
});

// Tips - pick a job, amount auto-splits evenly among whoever's assigned to it.
const money$ = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
const TIP_SELF_UNDO_MS = Number(process.env.TIP_SELF_UNDO_MS ?? 10 * 60 * 1000);       // a person can take back their OWN tip for 10 minutes
// The payroll run (if any) that has already counted a tip. A tip belongs to the pay period of the job's date. Once that payroll has been run (or skipped and carried
// forward), taking the tip away would silently change a check that's already gone out, so that has to be a payroll adjustment instead.
function tipRunBlock(db, tip) {
  const ymd = tip.date ? EASTERN_DAY_FMT.format(new Date(tip.date)) : null;
  const period = ymd ? paySchedule.periodContaining(ymd) : null;
  const run = period ? payRuns(db).find((r) => r.periodId === period.id) : null;
  return run ? { period, run } : null;
}
const tipView = (db, t, canSeeSplit) => {
  const block = tipRunBlock(db, t);
  return { id: t.id, amount: t.amount, timestamp: t.timestamp, loggedByName: t.loggedByName || "", split: canSeeSplit ? t.split.map((p) => ({ name: p.name, amount: p.amount, personType: p.personType })) : [],
    removable: !block, blockedReason: block ? `Payroll for ${payShortDate(block.period.start)} to ${payShortDate(block.period.end)} has already been run. To correct this tip, add an adjustment on the Payroll screen.` : "" };
};
app.post("/api/manager/tips", requireAnyStaff, (req, res) => {
  const db = loadDB();
  const { saleId, amount } = req.body;
  const sale = db.sales.find((s) => s.id === saleId);
  const amt = parseFloat(amount);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  if (!amt || amt <= 0) return res.status(400).json({ error: "A real amount is required." });
  // Techs AND any manager who helped hands-on both count toward the split - same
  // "who actually worked this car" logic already used for car commission.
  const workers = [
    ...saleEmployeeIds(sale).map((id) => ({ personType: "employee", personId: id })),
    ...(sale.managerHelperIds || []).map((id) => ({ personType: "manager", personId: id })),
  ];
  if (workers.length === 0) return res.status(400).json({ error: "No one is assigned to this car yet. Add who worked on it first, then add the tip." });
  const each = Math.round((amt / workers.length) * 100) / 100;
  const split = workers.map((w) => {
    const person = w.personType === "employee" ? db.employees.find((e) => e.id === w.personId) : db.managers.find((m) => m.id === w.personId);
    return { personType: w.personType, personId: w.personId, name: person ? person.name : "Removed person", amount: each };
  });
  const actor = actorInfo(req, db);
  const tip = { id: newId(), saleId, car: sale.car, date: sale.date, amount: amt, split, loggedByName: actor.name, loggedById: req.auth.id || null, loggedByRole: req.auth.role || null, timestamp: new Date().toISOString() };
  db.tips.push(tip);
  logAudit(db, req, sale, "Tip", "", `added ${money$(amt)}: ${split.map((p) => `${p.name} ${money$(p.amount)}`).join(", ")}`);
  saveDB(db);
  res.json({ ok: true, tip });
});
// Take a tip back (put on the wrong car, wrong amount). Owner and managers: any tip, until its pay period's payroll has been run. A tech: only a tip they logged themselves,
// within 10 minutes. The tip is archived (not lost) and the removal is written to the history.
app.delete("/api/manager/tips/:id", requireAnyStaff, (req, res) => {
  const db = loadDB(), tip = db.tips.find((t) => t.id === req.params.id);
  if (!tip) return res.status(404).json({ error: "That tip was already removed, or doesn't exist." });
  const role = req.auth.role, isBoss = role === "owner" || role === "manager";
  if (!isBoss) {
    const mine = tip.loggedById && tip.loggedById === req.auth.id && tip.loggedByRole === role;
    if (!mine || Date.now() - Date.parse(tip.timestamp) > TIP_SELF_UNDO_MS) return res.status(403).json({ error: "You can take back a tip you logged yourself for 10 minutes. After that, ask a manager to remove it." });
  }
  const block = tipRunBlock(db, tip);
  if (block) return res.status(409).json({ error: `Payroll for ${payShortDate(block.period.start)} to ${payShortDate(block.period.end)} has already been run, so this tip can't be removed here. To correct it, add an adjustment on the Payroll screen.` });
  const actor = actorInfo(req, db);
  db.tips = db.tips.filter((t) => t.id !== tip.id);
  db.removedTips.push({ ...tip, removedAt: new Date().toISOString(), removedByName: actor.name });
  logAudit(db, req, db.sales.find((s) => s.id === tip.saleId) || { id: tip.saleId, car: tip.car }, "Tip", `${money$(tip.amount)}: ${tip.split.map((p) => `${p.name} ${money$(p.amount)}`).join(", ")}`, "removed");
  saveDB(db);
  res.json({ ok: true });
});
app.get("/api/manager/tips", requireManager, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  res.json(db.tips.filter((t) => t.timestamp >= start && t.timestamp <= end).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)));
});

// Cash received against a job is kept in lockstep with the Cash & Expenses log. Marking a
// job paid in cash creates (or updates) ONE linked "cashIn" entry for the amount actually
// handed over; unmarking it removes that entry again, so cash on hand can never drift away
// from what Job Status says was collected. The cash entry is the single source of truth for
// the amount - Job Status reads it back from there rather than keeping a second copy that
// could disagree if someone later corrects the entry in Cash Log.
function linkedCashEntries(db, saleId) {
  return db.cashEntries.filter((e) => e.autoFromJob && e.saleId === saleId);
}
function reconcileCashPayment(db, req, sale, requestedAmount) {
  const linked = linkedCashEntries(db, sale.id);
  const existing = linked[0] || null;
  if (!sale.paidCash) {
    if (linked.length > 0) {
      const before = linked.reduce((a, e) => a + e.amount, 0);
      db.cashEntries = db.cashEntries.filter((e) => !(e.autoFromJob && e.saleId === sale.id));
      logAudit(db, req, sale, "Cash received", before, 0);
    }
    return;
  }
  // Newly marked with no amount given (e.g. the quick button on Unpaid Arrivals) defaults to what is still owed after the
  // deposit (the whole total when there was none), because a deposit was paid earlier, not handed over in cash at pickup.
  // An unrelated update to an already-logged job keeps what's there.
  const amount = requestedAmount !== undefined ? requestedAmount : existing ? existing.amount : balanceDueOf(sale);
  if (!(amount > 0)) return; // a job with no price yet has no cash amount to log
  if (existing) {
    if (linked.length > 1) db.cashEntries = db.cashEntries.filter((e) => !(e.autoFromJob && e.saleId === sale.id && e !== existing));
    if (existing.amount !== amount) {
      logAudit(db, req, sale, "Cash received", existing.amount, amount);
      existing.amount = amount;
    }
    return;
  }
  const actor = actorInfo(req, db);
  db.cashEntries.unshift({
    id: newId(), type: "cashIn", amount, category: "Customer Payment",
    note: `${sale.car || "Job"}${sale.customerName ? " — " + sale.customerName : ""}`,
    isOnline: false, receiptPhoto: null, saleId: sale.id, autoFromJob: true,
    enteredByType: actor.type, enteredById: actor.id, enteredByName: actor.name,
    timestamp: new Date().toISOString(),
  });
  logAudit(db, req, sale, "Cash received", 0, amount);
}

// Repairs a job that the old matching bug overwrote with a NEWER booking. Everything the job has
// accumulated - price, status, payment, close time, upsells, photos, notes, techs, tips, cash -
// belongs to the EARLIER appointment, so it all moves to a restored earlier job carrying the
// original date, and the live job is reset to what it really is: a fresh, pending booking.
// The original date can't be recovered automatically (the bug wrote over it), so the owner supplies it.
function splitEarlierAppointment(db, req, saleId, originalIso, originalCar, opts = {}) {
  const live = db.sales.find((s) => s.id === saleId);
  if (!live) return null;
  const earlier = JSON.parse(JSON.stringify(live));
  earlier.id = newId();
  earlier.date = originalIso;
  if (originalCar) earlier.car = originalCar;
  earlier.ghlOpportunityId = `${live.ghlOpportunityId}~earlier-${earlier.id}`;
  // The overwrite also replaced the rep with whoever booked the NEWER appointment, so without this
  // the original close would stay credited to the wrong person. The owner says who it really was.
  if (opts.originalRep) {
    earlier.salesRepId = opts.originalRep.id; earlier.salesRepName = opts.originalRep.name;
    earlier.isWalkIn = false; earlier.isOnlineBooking = false;
    earlier.walkInClosedByType = null; earlier.walkInClosedById = null; earlier.walkInClosedByName = null;
    logAudit(db, req, earlier, "Sales rep", live.salesRepName, opts.originalRep.name);
  }
  db.sales.push(earlier);
  // Things logged against the job back when it was still the earlier appointment go with it.
  db.tips.forEach((t) => { if (t.saleId === live.id) t.saleId = earlier.id; });
  db.cashEntries.forEach((c) => { if (c.autoFromJob && c.saleId === live.id) c.saleId = earlier.id; });
  // The live job becomes the fresh booking it really is. Price is cleared on purpose so it shows
  // up in Cleanup until the real one is entered (or GHL's price sync fills it in).
  live.status = "pending"; live.completed = false;
  live.paid = false; live.paidCash = false; live.paidCard = false; live.paymentMethod = null;
  // The new booking counts as a close for the rep on the day it REALLY closed (that decides the day it
  // shows in Closing Activity and whether the in-hours or after-hours rate applies); blank means now.
  live.basePrice = 0; live.closedAt = opts.newClosedIso || new Date().toISOString();
  live.upsells = []; live.notes = []; delete live.photos; delete live.isReschedule;
  live.employeeIds = []; live.employeeNames = "Unassigned"; live.managerHelperIds = []; live.managerHelperNames = "";
  delete live.employeeId;
  logAudit(db, req, live, "Split off earlier appointment", null, `${earlier.car} (${originalIso.slice(0, 10)})`);
  return { earlierId: earlier.id };
}

// Combines two bookings for the same customer into ONE job. The EARLIER job is the real deal (it keeps its original
// closing time, rep and history); the newer one is only where it got moved to, so its date, title and price move onto
// the earlier job and the duplicate goes away. It refuses whenever merging could lose something:
//  - the earlier job was actually finished (then it's a separate deal, not a reschedule),
//  - the newer job has already been worked (arrived / paid / completed), which a merge would drop,
//  - or the two don't look like the same customer's same booking.
const jobPersonKey = (s) => s.contactId || String(s.customerPhone || "").replace(/\D/g, "") || String(s.customerName || "").trim().toLowerCase();
function liveJobWorked(s) { return (!!s.status && s.status !== "pending") || !!s.paid || !!s.completed; }
function mergeJobPair(db, req, liveId, earlierId) {
  const live = db.sales.find((s) => s.id === liveId), earlier = db.sales.find((s) => s.id === earlierId);
  if (!live || !earlier || live.id === earlier.id) return { status: 404, error: "Job not found." };
  const linked = (earlier.ghlOpportunityId || "").startsWith(`${live.ghlOpportunityId}~earlier-`) && !!live.ghlOpportunityId;
  // Same customer (or the same GHL opportunity) AND the same car and service. Sharing an opportunity alone isn't enough:
  // a cancelled Camry job and a new BMW booking on the same opportunity are two different sales.
  if (!((linked || (jobPersonKey(live) && jobPersonKey(live) === jobPersonKey(earlier))) && titlesMatch(live.car, earlier.car))) {
    return { status: 409, error: "These two don't look like the same customer's same booking, so they weren't merged." };
  }
  if (!isDeadBooking(earlier) && !isServiced(earlier)) return { status: 409, error: "That earlier booking is still coming up, so these look like two separate appointments (for example two cars), not a reschedule. Nothing was changed." };
  if (isServiced(earlier)) return { status: 409, error: "That earlier job was already completed or paid, so this is a separate deal, not a reschedule. Nothing was changed." };
  if (liveJobWorked(live)) return { status: 409, error: "The newer job has already been worked on (arrived, paid or completed), and merging would lose that. Use \"Don't count as a new close\" instead. Nothing was changed." };
  const fromDate = earlier.date;
  if (live.ghlOpportunityId) earlier.ghlOpportunityId = live.ghlOpportunityId; // so later GHL events for this booking find it
  earlier.date = live.date;
  if (live.car) earlier.car = live.car;
  if (live.baseService) earlier.baseService = live.baseService;
  if ((parseFloat(live.basePrice) || 0) > 0) earlier.basePrice = live.basePrice;
  applyTitleRules(db, earlier, { silent: true });
  if (earlier.status === "no_show" || earlier.status === "cancelled") earlier.status = "pending"; // it's a live booking again
  if (!earlier.salesRepId && live.salesRepId) { earlier.salesRepId = live.salesRepId; earlier.salesRepName = live.salesRepName; }
  if (!(earlier.employeeIds || []).length && (live.employeeIds || []).length) { earlier.employeeIds = live.employeeIds; earlier.employeeNames = live.employeeNames; }
  earlier.upsells = [...(earlier.upsells || []), ...(live.upsells || [])];
  earlier.notes = [...(earlier.notes || []), ...(live.notes || [])];
  if (live.photos) {
    earlier.photos = earlier.photos || { before: {}, after: {} };
    ["before", "after"].forEach((stage) => Object.entries((live.photos || {})[stage] || {}).forEach(([slot, file]) => { earlier.photos[stage] = earlier.photos[stage] || {}; if (file && !earlier.photos[stage][slot]) earlier.photos[stage][slot] = file; }));
  }
  db.tips.forEach((t) => { if (t.saleId === live.id) t.saleId = earlier.id; });
  db.cashEntries.forEach((c) => { if (c.autoFromJob && c.saleId === live.id) c.saleId = earlier.id; });
  db.sales = db.sales.filter((s) => s.id !== live.id);
  logAudit(db, req, earlier, "Merged back (it was a reschedule)", fromDate.slice(0, 10), earlier.date.slice(0, 10));
  return { ok: true, id: earlier.id };
}
// The key-based form: the newer job holds the GHL opportunity id and the earlier one was re-keyed "~earlier-".
function mergeBackIntoEarlier(db, req, liveId) {
  const live = db.sales.find((s) => s.id === liveId);
  if (!live || !live.ghlOpportunityId) return { status: 404, error: "Job not found." };
  const earlier = db.sales.filter((s) => (s.ghlOpportunityId || "").startsWith(`${live.ghlOpportunityId}~earlier-`)).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (!earlier) return { status: 404, error: "There's no earlier job to merge this into." };
  return mergeJobPair(db, req, liveId, earlier.id);
}
// What has been merged lately, read straight from Edit History, so "what happened to that job?" always has an answer.
function recentMerges(db, days = 14) {
  const cutoff = Date.now() - days * 86400000;
  return (db.auditLog || []).filter((e) => /^Merged back/.test(e.field || "") && Date.parse(e.timestamp) >= cutoff).map((e) => {
    const sale = db.sales.find((x) => x.id === e.saleId);
    return { saleId: e.saleId, car: (sale && sale.car) || e.car || "", customerName: sale ? sale.customerName : "", mergedAt: e.timestamp, actor: e.actor || "", fromDate: e.oldValue, toDate: e.newValue, stillExists: !!sale };
  });
}
// A safety net for anything the automatic matching still misses: recent closes where the SAME customer already has an
// earlier, unfinished booking for the same car/service. These are what a reschedule that slipped through looks like,
// so the owner can flag them from Cleanup in one tap. Dismissed ones (marked "not a reschedule") never come back.
const customerKeyOf = (s) => s.contactId || String(s.customerPhone || "").replace(/\D/g, "") || String(s.customerName || "").trim().toLowerCase();
function customerIndex(db) {
  const byKey = {};
  db.sales.forEach((s) => { const k = customerKeyOf(s); if (k) (byKey[k] = byKey[k] || []).push(s); });
  return byKey;
}
// The earlier booking this one is probably a reschedule of: the same customer's, for the same car and service, that was never
// finished and is no longer going to happen (cancelled, a no-show, left unconfirmed, or a day that passed with nobody coming).
// A booking that is still upcoming, or one that was finished, is never the partner: that would be a second appointment.
function reschedulePartnerOf(db, j, byKey) {
  const k = customerKeyOf(j);
  if (!k) return null;
  const closedMs = Date.parse(j.closedAt || j.date);
  return (byKey[k] || [])
    .filter((e) => e.id !== j.id && !isServiced(e) && isDeadBooking(e) && Date.parse(e.closedAt || e.date) < closedMs - 60000 && titlesMatch(e.car, j.car))
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0] || null;
}
function findPossibleReschedules(db, days = 7) {
  const cutoff = Date.now() - days * 86400000;
  const byKey = customerIndex(db);
  const out = [];
  db.sales.forEach((j) => {
    if (j.isReschedule || j.rescheduleDismissed || j.status === "cancelled" || !j.salesRepId || !afterRevenueStart(j, db)) return;
    const closedMs = Date.parse(j.closedAt || j.date);
    if (!(closedMs >= cutoff)) return;
    const earlier = reschedulePartnerOf(db, j, byKey);
    if (!earlier) return;
    const rep = db.salesReps.find((r) => r.id === j.salesRepId);
    out.push({
      saleId: j.id, car: j.car, customerName: j.customerName, repName: rep ? rep.name : "Removed rep", closedAt: j.closedAt || j.date, date: j.date,
      basePrice: parseFloat(j.basePrice) || 0, status: j.status || "pending", canMerge: !liveJobWorked(j),
      earlier: { id: earlier.id, car: earlier.car, date: earlier.date, status: earlier.status || "pending", closedAt: earlier.closedAt || earlier.date, basePrice: parseFloat(earlier.basePrice) || 0 },
    });
  });
  return out.sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
}
// The team types "RESCHEDULED" into the title of a booking that replaces an earlier one. That is a person telling us what it is, so
// when the same customer really does have an earlier dead booking for the same car, flag it as "not a new close" right away instead of
// waiting for the owner to tap it in Cleanup. Both things are required: with the word but NO earlier booking it is just an
// appointment that was moved (one record, and the genuine close), and flagging that would wrongly erase a real sale. Anything the
// owner has already looked at is left alone: a booking marked "not a reschedule" is never flagged, and one put back as a close stays that way.
// It never merges or deletes anything.
function autoFlagRescheduleFromTitle(db, onlyJob) {
  const cutoff = Date.now() - 14 * 86400000;
  const byKey = customerIndex(db);
  let flagged = 0;
  (onlyJob ? [onlyJob] : db.sales).forEach((j) => {
    if (j.isReschedule || j.rescheduleDismissed || j.status === "cancelled" || !j.salesRepId || !afterRevenueStart(j, db)) return;
    if (!titleSaysReschedule(j.car)) return;
    if (!(Date.parse(j.closedAt || j.date) >= cutoff)) return;
    const partner = reschedulePartnerOf(db, j, byKey);
    if (!partner) return;
    j.isReschedule = true;
    j.rescheduleAutoFlagged = true;
    if (!db.auditLog) db.auditLog = [];
    db.auditLog.unshift({ id: newId(), timestamp: new Date().toISOString(), actor: "Auto (title says rescheduled)", saleId: j.id, car: j.car, field: "Reschedule (not a new close)", oldValue: false, newValue: true });
    db.auditLog = db.auditLog.slice(0, 1000);
    flagged += 1;
  });
  return flagged;
}
// Bookings already marked as reschedules in the last month, so there's always a way to put one back.
function recentLeftOut(db, days = 30) {
  const cutoff = Date.now() - days * 86400000;
  return db.sales.filter((s) => s.isReschedule && Date.parse(s.closedAt || s.date) >= cutoff).map((s) => {
    const rep = db.salesReps.find((r) => r.id === s.salesRepId);
    return { saleId: s.id, auto: !!s.rescheduleAutoFlagged, car: s.car, customerName: s.customerName, repName: rep ? rep.name : (s.salesRepName || "Unassigned"), closedAt: s.closedAt || s.date, date: s.date, basePrice: parseFloat(s.basePrice) || 0, status: s.status || "pending" };
  }).sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
}
app.get("/api/owner/possible-reschedules", requireOwner, (req, res) => {
  const db = loadDB();
  res.json({ possibleReschedules: findPossibleReschedules(db), leftOut: recentLeftOut(db) });
});

// The rep tracker's way to merge two of a location's bookings. The merge function does every safety check itself.
app.post("/api/cross-location/job-merge", (req, res) => {
  if (req.query.secret !== CROSS_LOCATION_SECRET) return res.status(401).json({ error: "Bad secret." });
  const { saleId, earlierId } = req.body || {};
  if (!saleId || !earlierId) return res.status(400).json({ error: "Both jobs are needed." });
  const db = loadDB();
  req.auth = { role: "owner", id: "rep-tracker", label: "Rep tracker (owner)" };
  const result = mergeJobPair(db, req, saleId, earlierId);
  if (result.error) return res.status(result.status).json({ error: result.error });
  saveDB(db);
  res.json(result);
});
app.post("/api/owner/jobs/:id/merge-earlier", requireOwner, (req, res) => {
  const db = loadDB();
  const result = mergeBackIntoEarlier(db, req, req.params.id);
  if (result.error) return res.status(result.status).json({ error: result.error });
  saveDB(db);
  res.json(result);
});

app.post("/api/owner/jobs/:id/split-earlier", requireOwner, (req, res) => {
  const db = loadDB();
  const originalIso = normalizeDate(req.body.originalDate);
  if (!originalIso) return res.status(400).json({ error: "Enter the original appointment date and time." });
  let originalRep = null;
  if (req.body.originalSalesRepId) {
    originalRep = db.salesReps.find((r) => r.id === req.body.originalSalesRepId);
    if (!originalRep) return res.status(400).json({ error: "That sales rep doesn't exist." });
  }
  let newClosedIso = null;
  if (req.body.newClosedAt) {
    newClosedIso = normalizeDate(req.body.newClosedAt);
    if (!newClosedIso) return res.status(400).json({ error: "Enter a valid close time for the new booking." });
  }
  const result = splitEarlierAppointment(db, req, req.params.id, originalIso, String(req.body.originalCar || "").trim(), { originalRep, newClosedIso });
  if (!result) return res.status(404).json({ error: "Job not found." });
  saveDB(db);
  res.json({ ok: true, ...result });
});

app.get("/api/manager/jobs", requireManager, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const jobs = db.sales.filter((s) => inRange(s.date, start, end));
  const tipsBySale = {};
  db.tips.forEach((t) => { (tipsBySale[t.saleId] = tipsBySale[t.saleId] || []).push(t); });
  const cashBySale = {};
  db.cashEntries.forEach((e) => { if (e.autoFromJob && e.saleId) cashBySale[e.saleId] = (cashBySale[e.saleId] || 0) + e.amount; });
  res.json(jobs.map((s) => ({
    id: s.id, date: s.date, customerName: s.customerName, customerPhone: s.customerPhone, car: s.car,
    cashPaidAmount: cashBySale[s.id] || 0, isReschedule: !!s.isReschedule, closedAtCheck: !!s.closedAtCheck,
    employeeIds: saleEmployeeIds(s), employeeNames: s.employeeNames || "Unassigned", baseService: s.baseService,
    managerHelperIds: s.managerHelperIds || [], managerHelperNames: s.managerHelperNames || "",
    salesRepId: s.salesRepId || null, salesRepName: s.salesRepName || "Unassigned", isWalkIn: !!s.isWalkIn,
    walkInClosedByType: s.walkInClosedByType || null, walkInClosedById: s.walkInClosedById || null, walkInClosedByName: s.walkInClosedByName || null,
    basePrice: s.basePrice || 0, total: saleTotal(s), upsellTotal: saleUpsellTotal(s), upsells: resolveUpsellNames(s.upsells, db),
    isRedo: !!s.isRedo, redoAuto: !!s.redoAuto, noPaymentNeeded: redoFree(s), titlePrice: s.titlePrice == null ? null : s.titlePrice, depositAmount: depositOf(s), balanceDue: depositOf(s) > 0 ? balanceDueOf(s) : null, ghlValue: s.ghlValue == null ? null : s.ghlValue, priceSource: s.priceSource || null, priceLocked: !!s.priceLocked,
    status: s.status || (s.arrived ? "arrived" : "pending"), completed: !!s.completed, paid: !!s.paid, paymentMethod: s.paymentMethod || null, paidCash: !!s.paidCash, paidCard: !!s.paidCard,
    photos: s.photos || { before: {}, after: {} }, notes: s.notes || [], tips: (tipsBySale[s.id] || []).map((t) => tipView(db, t, true)),
  })));
});

// The shop's own job editor. Named so the combined rep tracker's edit endpoint can run the exact same code.
function patchJobHandler(req, res) {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.id);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  // "This is a reschedule, not a new close": keeps the job out of closing activity (the audit, the rep tracker's
  // closes, Statistics) while leaving it fully in payroll. Owner only, and always logged.
  if (req.body.isReschedule !== undefined) {
    if (req.auth.role !== "owner") return res.status(403).json({ error: "Only the owner can change this." });
    const flag = !!req.body.isReschedule;
    logAudit(db, req, sale, "Reschedule (not a new close)", !!sale.isReschedule, flag);
    // Put back as a close after the tracker flagged it by itself: that is the owner's decision, so the title is never allowed to flag it again.
    if (!flag && sale.rescheduleAutoFlagged) sale.rescheduleDismissed = true;
    sale.rescheduleAutoFlagged = false;
    sale.isReschedule = flag;
  }
  // "Not a reschedule": the owner looked at a Cleanup suggestion and says it's a genuinely separate deal.
  if (req.body.rescheduleDismissed !== undefined) {
    if (req.auth.role !== "owner") return res.status(403).json({ error: "Only the owner can change this." });
    const flag = !!req.body.rescheduleDismissed;
    logAudit(db, req, sale, "Reschedule suggestion dismissed", !!sale.rescheduleDismissed, flag);
    sale.rescheduleDismissed = flag;
  }
  // Manual price correction — the price GHL/sync captured isn't always final; a customer
  // can negotiate down after the fact. This flows through to every downstream number
  // automatically (total, commission math), since everything reads from this one field.
  if (req.body.basePrice !== undefined) {
    const newPrice = parseFloat(req.body.basePrice) || 0;
    logAudit(db, req, sale, "Base price", sale.basePrice, newPrice);
    sale.basePrice = newPrice;
    // Typed in by hand: from now on neither GHL's value nor the title overrides it (until "Use the title's price" is tapped).
    sale.priceLocked = true;
    sale.priceSource = "manual";
  }
  if (req.body.isRedo !== undefined) {
    const flag = !!req.body.isRedo;
    logAudit(db, req, sale, "Redo (no charge)", !!sale.isRedo, flag);
    sale.isRedo = flag; sale.redoAuto = false;
    if (flag) {
      sale.redoDismissed = false;
      applyRedoRules(db, sale, { force: true, silent: true });
      // Pressing the Redo button yourself is an explicit decision, so it wins even when the title carries a price (almost every title does):
      // the job becomes free and stays free (its price is held at $0 until someone unmarks it). A job that has already been paid is never zeroed.
      if (!sale.paid && !sale.priceLocked && (parseFloat(sale.basePrice) || 0) > 0) {
        sale.basePrice = 0; sale.priceLocked = true; sale.redoPriceLocked = true; sale.priceSource = "redo";
      }
    } else {
      sale.redoDismissed = true;                       // the word in the title is never allowed to flag it again
      if (sale.priceSource === "redo" && (!sale.priceLocked || sale.redoPriceLocked)) {        // put back the price the redo rule took away
        if (sale.redoPriceLocked) { sale.priceLocked = false; sale.redoPriceLocked = false; }
        const tp = parseTitlePricing(sale.car);
        sale.basePrice = tp ? tp.total : (sale.ghlValue != null ? sale.ghlValue : 0);
        sale.priceSource = tp ? "title" : "ghl";
      }
    }
  }
  if (req.body.dismissPriceMismatch === true) sale.priceMismatchDismissed = true;
  if (req.body.useTitlePrice === true) {
    const tp = parseTitlePricing(sale.car);
    if (!tp) return res.status(400).json({ error: "There's no price in this job's title to use." });
    const before = parseFloat(sale.basePrice) || 0;
    sale.priceLocked = false;
    applyTitlePricing(db, sale, { force: true, silent: true });
    if (Math.abs(before - sale.basePrice) >= 0.005) logAudit(db, req, sale, "Base price (from the title)", before, sale.basePrice);
  }
  // Which service this actually is — needed for the Window Tint / Ceramic Coating / PPF
  // column split, and previously had no way to set or fix it anywhere in the app.
  if (req.body.baseService !== undefined) {
    logAudit(db, req, sale, "Service", sale.baseService, req.body.baseService);
    sale.baseService = req.body.baseService;
  }
  // GHL doesn't reliably notify us when someone just edits an appointment's title after
  // booking (no trigger fires for a plain edit) — this makes the manual fix a quick inline
  // correction instead of something requiring a database edit.
  if (req.body.car !== undefined && req.body.car.trim()) {
    const newTitle = req.body.car.trim();
    if (newTitle !== sale.car) {
      logAudit(db, req, sale, "Car/Title", sale.car, newTitle);
      sale.car = newTitle;
      // A title someone corrected by hand is theirs: neither the background sync nor a later GHL event may change it back.
      // (A title picked straight from GHL's own appointment list isn't hand-typed, so it stays free to follow GHL.)
      sale.titleLocked = !req.body.titleFromGhl;
      applyTitleRules(db, sale);
      autoFlagRescheduleFromTitle(db, sale);
    } else if (req.body.titleFromGhl) {
      sale.titleLocked = false;
    }
  }
  // Manual date/time correction — for the rare case an appointment's real time needs fixing
  // directly (a reschedule that didn't sync correctly, a data entry mistake, etc). Uses the
  // same wall-clock-to-UTC conversion as everything else, so this stays correct across DST.
  if (req.body.date !== undefined && req.body.date) {
    const normalized = normalizeDate(req.body.date);
    if (normalized) {
      // If this job has never had a real closedAt, this edit IS a reschedule of whatever
      // the date currently is - capture that current value now, before it's overwritten,
      // so this appointment's original scheduled time is preserved as its close date
      // forever, rather than drifting to match every future reschedule.
      if (!sale.closedAt && sale.date) sale.closedAt = sale.date;
      logAudit(db, req, sale, "Date/Time", sale.date, normalized);
      sale.date = normalized;
    }
  }
  // Manual correction for when the deal was actually closed — this directly decides which
  // commission rate applies (in-hours vs after-hours), so a wrong value here has real
  // dollar consequences. Same Eastern-aware parsing as the appointment date/time above.
  if (req.body.closedAt !== undefined && req.body.closedAt) {
    const normalized = normalizeDate(req.body.closedAt);
    if (normalized) {
      logAudit(db, req, sale, "Closed At", sale.closedAt, normalized);
      sale.closedAt = normalized;
      sale.closedAtCheck = false;          // someone has now looked at it and set it
      sale.closedAtSource = "owner";
    }
  }
  const statusBefore = sale.status || "pending";
  if (req.body.status !== undefined) { sale.status = req.body.status; sale.arrivedByComplete = false; }      // someone chose the status themselves
  if (req.body.status !== undefined && (sale.status === "no_show" || sale.status === "cancelled") && statusBefore !== sale.status) maybeQueueMissedText(db, sale, sale.status);
  if (req.body.completed !== undefined) {
    // A car can't be serviced without having shown up, so marking Service complete also marks a still-waiting car as Arrived. A sales rep's commission
    // (and the TV, and every total) all go off "arrived", so this keeps them agreeing. It is remembered, so undoing the Service complete (a mis-tap)
    // puts the car back as it was; if someone chose Arrived themselves, that stays put.
    const wasCompleted = !!sale.completed;
    sale.completed = !!req.body.completed;
    if (sale.completed && !wasCompleted && (!sale.status || sale.status === "pending" || sale.status === "unconfirmed")) {
      logAudit(db, req, sale, "Status", sale.status || "pending", "arrived (service complete)");
      sale.status = "arrived"; sale.arrivedByComplete = true;
    } else if (!sale.completed && wasCompleted && sale.arrivedByComplete && sale.status === "arrived") {
      logAudit(db, req, sale, "Status", "arrived", "pending (service complete undone)");
      sale.status = "pending"; sale.arrivedByComplete = false;
    }
  }
  // How much of the payment was actually cash - validated before anything is changed, so a
  // bad value can never leave a half-applied update behind.
  let cashAmountRequested;
  if (req.body.cashPaidAmount !== undefined) {
    const amt = Math.round(parseFloat(req.body.cashPaidAmount) * 100) / 100;
    if (!(amt > 0)) return res.status(400).json({ error: "Enter a real cash amount." });
    cashAmountRequested = amt;
  }
  if (req.body.paid !== undefined) {
    sale.paid = !!req.body.paid;
    if (!sale.paid) { sale.paidCash = false; sale.paidCard = false; sale.paymentMethod = null; }
  }
  // Cash and card are independent toggles now, not mutually exclusive — a customer can
  // genuinely pay part cash, part card, and both need to be markable at once.
  if (req.body.paidCash !== undefined) sale.paidCash = !!req.body.paidCash;
  if (req.body.paidCard !== undefined) sale.paidCard = !!req.body.paidCard;
  if (req.body.paidCash !== undefined || req.body.paidCard !== undefined) {
    sale.paid = !!(sale.paidCash || sale.paidCard);
    sale.paymentMethod = sale.paidCash && sale.paidCard ? "both" : sale.paidCash ? "cash" : sale.paidCard ? "card" : null;
  }
  // Every path that can change cash (paidCash, paid:false which clears it, or an amount
  // edit) funnels through here, so the Cash & Expenses log always matches.
  if (req.body.paid !== undefined || req.body.paidCash !== undefined || req.body.paidCard !== undefined || cashAmountRequested !== undefined) {
    reconcileCashPayment(db, req, sale, cashAmountRequested);
  }
  if (req.body.employeeIds !== undefined) {
    sale.employeeIds = req.body.employeeIds;
    const names = req.body.employeeIds.map((id) => (db.employees.find((e) => e.id === id) || {}).name).filter(Boolean);
    sale.employeeNames = names.join(", ") || "Unassigned";
  }
  // Managers sometimes physically help with the work too — tracked separately from techs.
  if (req.body.managerHelperIds !== undefined) {
    sale.managerHelperIds = req.body.managerHelperIds;
    const names = req.body.managerHelperIds.map((id) => (db.managers.find((m) => m.id === id) || {}).name).filter(Boolean);
    sale.managerHelperNames = names.join(", ");
  }
  if (req.body.salesRepId !== undefined) {
    const rep = db.salesReps.find((r) => r.id === req.body.salesRepId);
    logAudit(db, req, sale, "Sales rep", sale.salesRepName, rep ? rep.name : "Unassigned");
    sale.salesRepId = req.body.salesRepId;
    sale.salesRepName = rep ? rep.name : "Unassigned";
    sale.isWalkIn = false;
    sale.isOnlineBooking = false;
  }
  // Manual override — mark any job as a walk-in/staff-booked appointment, no sales rep
  // commission applies regardless of what GHL says.
  if (req.body.isWalkIn !== undefined) {
    sale.isWalkIn = !!req.body.isWalkIn;
    if (sale.isWalkIn) { sale.salesRepId = null; sale.salesRepName = "Walk-in (booked by staff)"; sale.isOnlineBooking = false; }
    else { sale.walkInClosedByType = null; sale.walkInClosedById = null; sale.walkInClosedByName = null; }
  }
  // A genuine website self-booking — nobody actually closed this, so it correctly gets no
  // sales rep credit and no commission, but it shouldn't sit in Cleanup forever looking
  // like something's missing. This is its own real, resolved category, not an error state.
  if (req.body.isOnlineBooking !== undefined) {
    sale.isOnlineBooking = !!req.body.isOnlineBooking;
    if (sale.isOnlineBooking) {
      logAudit(db, req, sale, "Sales rep", sale.salesRepName, "Online Booking");
      sale.salesRepId = null; sale.salesRepName = "Online Booking"; sale.isWalkIn = false;
      sale.walkInClosedByType = null; sale.walkInClosedById = null; sale.walkInClosedByName = null;
    }
  }
  // Assign or change who actually closed a walk-in — attribution/tracking only, not tied
  // to any commission calculation.
  if (req.body.walkInClosedByType !== undefined && req.body.walkInClosedById !== undefined) {
    const person = req.body.walkInClosedByType === "manager"
      ? db.managers.find((m) => m.id === req.body.walkInClosedById)
      : db.employees.find((e) => e.id === req.body.walkInClosedById);
    sale.walkInClosedByType = req.body.walkInClosedByType;
    sale.walkInClosedById = req.body.walkInClosedById;
    sale.walkInClosedByName = person ? person.name : "Unknown";
  }
  saveDB(db);
  res.json({ ok: true });
}
app.patch("/api/manager/jobs/:id", requireManager, patchJobHandler);

// ---------- upsells ----------
app.post("/api/sales/:id/upsells", requireAnyStaff, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.id);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  // Deliberately NOT restricted to techs assigned to the car — assignment tracks who did the
  // labor, upselling is separate. Anyone logged in can upsell any car on the schedule.
  const { name, price } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Upsell name is required." });
  sale.upsells = sale.upsells || [];
  const upsell = { id: newId(), name: name.trim(), price: parseFloat(price) || 0, employeeId: null, managerId: null, salesRepId: null };
  if (req.auth.role === "employee") upsell.employeeId = req.auth.id;
  else if (req.auth.role === "manager") upsell.managerId = req.auth.id;
  else if (req.auth.role === "sales") {
    // A rep upselling over the phone - an online booking with no assigned rep, or a
    // callback on an existing customer to add something on before they arrive.
    const rep = db.salesReps.find((r) => r.id === req.auth.id);
    upsell.salesRepId = req.auth.id;
    upsell.salesRepName = rep ? rep.name : null;
    upsell.createdAt = new Date().toISOString(); upsell.addedVia = "shop"; upsell.addedBy = rep ? rep.name : "";
  }
  else if (req.body.employeeId) upsell.employeeId = req.body.employeeId;
  else if (req.body.managerId) upsell.managerId = req.body.managerId;
  sale.upsells.push(upsell);
  saveDB(db);
  res.json({ ok: true });
});

// A shared note log on the appointment — tech, manager, and owner can all see and add to
// it. Useful for things like "customer wants extra wax" or "called to confirm" that
// multiple people might need to know, not tied to any one person's own view.
function noteAuthorInfo(req, db) {
  if (req.auth.role === "owner") return "Owner";
  if (req.auth.role === "manager") {
    const mgr = db.managers.find((m) => m.id === req.auth.id);
    return `${mgr ? mgr.name : "Removed manager"} (manager)`;
  }
  if (req.auth.role === "sales") {
    const rep = db.salesReps.find((r) => r.id === req.auth.id);
    return `${rep ? rep.name : "Removed rep"} (sales)`;
  }
  const emp = db.employees.find((e) => e.id === req.auth.id);
  return emp ? emp.name : "Removed employee";
}

app.post("/api/sales/:id/notes", requireAnyStaff, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.id);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: "Note text is required." });
  sale.notes = sale.notes || [];
  sale.notes.push({ id: newId(), text: text.trim(), authorName: noteAuthorInfo(req, db), timestamp: new Date().toISOString() });
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/sales/:id/notes/:noteId", requireAnyStaff, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.id);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  sale.notes = (sale.notes || []).filter((n) => n.id !== req.params.noteId);
  saveDB(db);
  res.json({ ok: true });
});

// Fix a mistake on an upsell already logged — wrong price, wrong name typed in, whatever.
// Manager/owner only. Keeps the original attribution (who gets credit) intact, unlike
// deleting and re-adding it, which would change who it's credited to.
app.patch("/api/sales/:saleId/upsells/:upsellId", requireManager, (req, res) => {
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.saleId);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  const upsell = (sale.upsells || []).find((u) => u.id === req.params.upsellId);
  if (!upsell) return res.status(404).json({ error: "Upsell not found." });
  if (req.body.name !== undefined && req.body.name.trim()) upsell.name = req.body.name.trim();
  if (req.body.price !== undefined) upsell.price = parseFloat(req.body.price) || 0;
  // Who gets credit for this upsell is ONE choice across everyone in the system — an
  // employee, a manager, or a sales rep — not separate bolted-on fields. Setting one
  // clears the others, so credit is never ambiguous or double-counted.
  if (req.body.creditType !== undefined) {
    upsell.employeeId = null; upsell.managerId = null; upsell.salesRepId = null; upsell.salesRepName = null;
    if (req.body.creditType === "employee" && req.body.creditId) {
      upsell.employeeId = req.body.creditId;
    } else if (req.body.creditType === "manager" && req.body.creditId) {
      upsell.managerId = req.body.creditId;
    } else if (req.body.creditType === "salesrep" && req.body.creditId) {
      const rep = db.salesReps.find((r) => r.id === req.body.creditId);
      upsell.salesRepId = req.body.creditId;
      upsell.salesRepName = rep ? rep.name : null;
    }
    // creditType === "none" (or an unmatched value) leaves it fully unassigned.
  }
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
      customerName: s.customerName || "",
      customerPhone: s.customerPhone || "",
      baseService: s.baseService,
      employeeNames: s.employeeNames || "Unassigned",
      managerHelperNames: s.managerHelperNames || "",
      status: s.status || "pending",
      // Every upsell on this car is visible to any tech working it, so someone tag-teaming
      // a job (like Nick alongside Gio) can see what's already been upsold, even though
      // commission credit still only goes to whoever actually logged it.
      upsells: resolveUpsellNames(s.upsells || [], db),
      photos: s.photos || { before: {}, after: {} }, notes: s.notes || [],
      // A tech sees ONLY a tip they logged themselves a moment ago (so they can take back a mis-tap). Other people's tips, and who got what, stay private.
      myTips: db.tips.filter((t) => t.saleId === s.id && t.loggedById === myId && t.loggedByRole === req.auth.role && Date.now() - Date.parse(t.timestamp) <= TIP_SELF_UNDO_MS).map((t) => ({ id: t.id, amount: t.amount, timestamp: t.timestamp })),
      // basePrice and total sale $ intentionally NOT sent to employees
    }));
  res.json(jobs);
});

app.get("/api/my/performance", requireEmployee, (req, res) => {
  const db = loadDB();
  const employeeId = req.auth.role === "owner" && req.query.employeeId ? req.query.employeeId : req.auth.id;
  const { start, end } = dateRangeFor(req.query);
  const emp = db.employees.find((e) => e.id === employeeId);
  const mine = db.sales.filter((s) => saleEmployeeIds(s).includes(employeeId) && inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db));

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

  // Walk-in closer commission is separate from the tech-assignment filter above — closing
  // a walk-in isn't the same thing as being assigned to physically work the car.
  const myWalkIns = db.sales.filter((s) => s.walkInClosedByType === "employee" && s.walkInClosedById === employeeId && inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db));
  const walkInClosedCount = myWalkIns.length;
  const walkInArrivedPaidCount = myWalkIns.filter((s) => s.status === "arrived" && s.paid).length;
  const walkInRevenue = myWalkIns.filter((s) => s.status === "arrived" && s.paid).reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
  const walkInCommission = myWalkIns.reduce((a, s) => a + walkInCommissionForSale(emp, s), 0);

  const myAttendance = db.attendance.filter((a) => a.personType === "employee" && a.personId === employeeId && a.date >= start.slice(0, 10) && a.date <= endDateStringFor(end));
  const basePay = emp ? calculateBasePay(emp, myAttendance, mine) : { amount: 0, configured: false, carDetails: [] };
  const myTips = db.tips.filter((t) => inRange(t.date, start, end) && t.split.some((sp) => sp.personType === "employee" && sp.personId === employeeId));
  const tipsTotal = myTips.reduce((a, t) => a + t.split.find((sp) => sp.personType === "employee" && sp.personId === employeeId).amount, 0);
  const tipDetails = myTips.map((t) => ({ id: t.id, car: t.car, date: t.date, totalAmount: t.amount, yourShare: t.split.find((sp) => sp.personType === "employee" && sp.personId === employeeId).amount, splitCount: t.split.length }));

  res.json({
    cars, attachRate, upsellRevenue: upsellRev,
    top: sorted.slice(0, 2), growthArea: sorted.length > 1 ? sorted[sorted.length - 1] : null,
    commissionRate: emp ? emp.commissionRate : 0, commission,
    walkInCommissionRate: emp ? emp.walkInCommissionRate || 0 : 0, walkInClosedCount, walkInArrivedPaidCount, walkInCommission, walkInRevenue,
    payType: emp ? emp.payType : null, salaryPerPeriod: emp ? emp.salaryPerPeriod || 0 : 0, hourlyRate: emp ? emp.hourlyRate || 0 : 0, carCommissionRate: emp ? emp.carCommissionRate || 0 : 0, basePay,
    tipsTotal, tipDetails,
    totalPay: commission + walkInCommission + basePay.amount + tipsTotal,
  });
});

// ---------- manager's own upsell performance — managers upsell too, and get credited personally ----------
app.get("/api/manager/performance", requireManager, (req, res) => {
  const db = loadDB();
  const managerId = req.auth.role === "owner" && req.query.managerId ? req.query.managerId : req.auth.id;
  const { start, end } = dateRangeFor(req.query);
  const mgr = db.managers.find((m) => m.id === managerId);

  const myUpsells = (s) => (s.upsells || []).filter((u) => u.managerId === managerId);
  const relevant = db.sales.filter((s) => inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db) && myUpsells(s).length > 0);
  const upsellRev = relevant.reduce((a, s) => a + myUpsells(s).reduce((x, u) => x + (parseFloat(u.price) || 0), 0), 0);
  const cars = relevant.length;      // cars they UPSOLD
  const carsWorked = db.sales.filter((s) => inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db) && (s.managerHelperIds || []).includes(managerId)).length;   // cars they WORKED hands-on

  const breakdown = {};
  relevant.forEach((s) => myUpsells(s).forEach((u) => {
    const k = u.name.trim();
    breakdown[k] = breakdown[k] || { name: k, count: 0, revenue: 0 };
    breakdown[k].count += 1;
    breakdown[k].revenue += parseFloat(u.price) || 0;
  }));
  const sorted = Object.values(breakdown).sort((a, b) => b.revenue - a.revenue);
  const commission = mgr && mgr.commissionRate ? upsellRev * (mgr.commissionRate / 100) : 0;

  const myWalkIns = db.sales.filter((s) => s.walkInClosedByType === "manager" && s.walkInClosedById === managerId && inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db));
  const walkInClosedCount = myWalkIns.length;
  const walkInArrivedPaidCount = myWalkIns.filter((s) => s.status === "arrived" && s.paid).length;
  const walkInRevenue = myWalkIns.filter((s) => s.status === "arrived" && s.paid).reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
  const walkInCommission = myWalkIns.reduce((a, s) => a + walkInCommissionForSale(mgr, s), 0);

  const myAttendance = db.attendance.filter((a) => a.personType === "manager" && a.personId === managerId && a.date >= start.slice(0, 10) && a.date <= endDateStringFor(end));
  const periodSales = db.sales.filter((s) => inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db));
  const basePay = mgr ? calculateBasePay(mgr, myAttendance, periodSales) : { amount: 0, configured: false, carDetails: [] };
  const myTips = db.tips.filter((t) => inRange(t.date, start, end) && t.split.some((sp) => sp.personType === "manager" && sp.personId === managerId));
  const tipsTotal = myTips.reduce((a, t) => a + t.split.find((sp) => sp.personType === "manager" && sp.personId === managerId).amount, 0);
  const tipDetails = myTips.map((t) => ({ id: t.id, car: t.car, date: t.date, totalAmount: t.amount, yourShare: t.split.find((sp) => sp.personType === "manager" && sp.personId === managerId).amount, splitCount: t.split.length }));

  res.json({
    cars, carsWorked, upsellRevenue: upsellRev,
    top: sorted.slice(0, 2), growthArea: sorted.length > 1 ? sorted[sorted.length - 1] : null,
    commissionRate: mgr ? mgr.commissionRate : 0, commission,
    walkInCommissionRate: mgr ? mgr.walkInCommissionRate || 0 : 0, walkInClosedCount, walkInArrivedPaidCount, walkInCommission, walkInRevenue,
    payType: mgr ? mgr.payType : null, salaryPerPeriod: mgr ? mgr.salaryPerPeriod || 0 : 0, hourlyRate: mgr ? mgr.hourlyRate || 0 : 0, carCommissionRate: mgr ? mgr.carCommissionRate || 0 : 0, basePay,
    tipsTotal, tipDetails,
    totalPay: commission + walkInCommission + basePay.amount + tipsTotal,
    jobs: relevant.map((s) => ({
      id: s.id, date: s.date, car: s.car, customerName: s.customerName,
      upsells: myUpsells(s).map((u) => ({ name: u.name, price: u.price })),
    })).sort((a, b) => (a.date < b.date ? 1 : -1)),
  });
});

// The whole shop's upsell and walk-in performance, for every manager (the screen above this one shows only a manager's own).
// Deliberately NOT included: commission, pay, tips or any other person's earnings. That stays private to each person and the owner.
// Revenue figures use the same basis as the owner's Dashboard so the numbers agree: upsells are counted as SOLD on any non-cancelled job
// (with how much of it has been collected shown separately), and walk-in revenue is what the customer actually paid, upsells included.
app.get("/api/manager/shop-performance", requireManager, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const sales = revenueEligible(db.sales.filter((s) => inRange(s.date, start, end)), db);
  const r2 = (n) => Math.round((n || 0) * 100) / 100;
  const price = (u) => parseFloat(u.price) || 0;

  // ---- upsells, credited to whoever sold them (a tech, a manager or a sales rep) ----
  const people = {}, items = {};
  const person = (key, name, role) => (people[key] = people[key] || { key, name, role, count: 0, revenue: 0, carIds: new Set() });
  db.managers.forEach((m) => person("m:" + m.id, m.name, "Manager"));
  db.employees.forEach((e) => person("e:" + e.id, e.name, "Tech"));
  let soldRevenue = 0, soldCount = 0, collectedRevenue = 0;
  sales.forEach((s) => (s.upsells || []).forEach((u) => {
    soldRevenue += price(u); soldCount += 1; if (s.paid) collectedRevenue += price(u);
    let p;
    if (u.managerId) p = person("m:" + u.managerId, (db.managers.find((m) => m.id === u.managerId) || {}).name || "Removed manager", "Manager");
    else if (u.employeeId) p = person("e:" + u.employeeId, (db.employees.find((e) => e.id === u.employeeId) || {}).name || "Removed employee", "Tech");
    else if (u.salesRepId) p = person("r:" + u.salesRepId, u.salesRepName || "Removed rep", "Sales rep");
    else p = person("none", "Unassigned", "");
    p.count += 1; p.revenue += price(u); p.carIds.add(s.id);
    const k = String(u.name || "").trim().toLowerCase();
    items[k] = items[k] || { name: String(u.name || "").trim(), count: 0, revenue: 0 };
    items[k].count += 1; items[k].revenue += price(u);
  }));
  const completed = sales.filter((s) => s.completed);
  const carsWithUpsell = sales.filter((s) => (s.upsells || []).length > 0).length;
  const upsells = {
    soldRevenue: r2(soldRevenue), soldCount, collectedRevenue: r2(collectedRevenue), carsWithUpsell,
    carsServiced: completed.length,
    attachRate: completed.length ? (completed.filter((s) => (s.upsells || []).length > 0).length / completed.length) * 100 : 0,
    byPerson: Object.values(people).map((p) => ({ key: p.key, name: p.name, role: p.role, count: p.count, revenue: r2(p.revenue), cars: p.carIds.size }))
      .sort((a, b) => b.revenue - a.revenue || b.count - a.count || a.name.localeCompare(b.name)),
    byItem: Object.values(items).map((i) => ({ name: i.name, count: i.count, revenue: r2(i.revenue) })).sort((a, b) => b.revenue - a.revenue || b.count - a.count),
  };

  // ---- walk-ins ----
  const walk = sales.filter((s) => s.isWalkIn);
  const paidWalk = walk.filter((s) => s.paid);
  const walkRevenue = paidWalk.reduce((a, s) => a + saleTotal(s), 0);
  const closers = {}, services = {};
  walk.forEach((s) => {
    const key = s.walkInClosedById ? `${s.walkInClosedByType}:${s.walkInClosedById}` : "none";
    const c = (closers[key] = closers[key] || { key, name: s.walkInClosedById ? (s.walkInClosedByName || "Unknown") : "No closer recorded", role: s.walkInClosedByType === "manager" ? "Manager" : s.walkInClosedByType === "employee" ? "Tech" : "", closed: 0, arrivedPaid: 0, revenue: 0 });
    c.closed += 1;
    if (s.status === "arrived" && s.paid) c.arrivedPaid += 1;
    if (s.paid) c.revenue += saleTotal(s);
    const svc = s.baseService || "No service set";
    const v = (services[svc] = services[svc] || { service: svc, count: 0, revenue: 0 });
    v.count += 1; if (s.paid) v.revenue += saleTotal(s);
  });
  const walkIns = {
    total: walk.length, arrived: walk.filter((s) => s.status === "arrived").length, paid: paidWalk.length,
    revenue: r2(walkRevenue), avgTicket: paidWalk.length ? r2(walkRevenue / paidWalk.length) : 0,
    sharePercent: sales.length ? (walk.length / sales.length) * 100 : 0, allJobs: sales.length,
    needsCloser: walk.filter((s) => !s.walkInClosedById).length,
    byCloser: Object.values(closers).map((c) => ({ ...c, revenue: r2(c.revenue) })).sort((a, b) => b.closed - a.closed || b.revenue - a.revenue),
    byService: Object.values(services).map((v) => ({ ...v, revenue: r2(v.revenue) })).sort((a, b) => b.count - a.count || b.revenue - a.revenue),
    recent: walk.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 30).map((s) => ({
      id: s.id, date: s.date, car: s.car, customerName: s.customerName || "", service: s.baseService || "", total: r2(saleTotal(s)),
      status: s.status || "pending", paid: !!s.paid, completed: !!s.completed, closerName: s.walkInClosedById ? (s.walkInClosedByName || "Unknown") : null,
    })),
  };
  res.json({ you: { role: req.auth.role, id: req.auth.id }, upsells, walkIns });
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
// Walk-in closer commission — a DIFFERENT rule than sales reps. This requires the job to
// be both arrived AND marked paid, not just arrived. It's on the base price, only for
// whoever is recorded as having personally closed that specific walk-in.
function walkInCommissionForSale(person, sale) {
  if (!person || !sale.isWalkIn || sale.status !== "arrived" || !sale.paid) return 0;
  const rate = person.walkInCommissionRate || 0;
  return (parseFloat(sale.basePrice) || 0) * (rate / 100);
}

app.get("/api/my/sales-schedule", requireSales, (req, res) => {
  const db = loadDB();
  const repId = req.auth.role === "owner" && req.query.salesRepId ? req.query.salesRepId : req.auth.id;
  const { start, end } = dateRangeFor(req.query);
  const jobs = db.sales
    .filter((s) => s.salesRepId === repId && inRange(s.date, start, end))
    .map((s) => ({
      id: s.id, date: s.date, car: s.car, customerName: s.customerName, baseService: s.baseService,
      basePrice: s.basePrice, status: s.status || "pending", notes: s.notes || [],
      upsells: resolveUpsellNames(s.upsells || [], db),
      // No price/status editing here — this is a read-only view of what THEY sold and whether it showed.
    }));
  res.json(jobs);
});

// The full shop schedule — every job, not just their own bookings. No price shown, same
// privacy rule as employees. Read-only: sales reps can see arrival/completion status,
// never set it.
app.get("/api/sales/full-schedule", requireSales, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const jobs = db.sales.filter((s) => inRange(s.date, start, end)).map((s) => ({
    id: s.id, date: s.date, car: s.car, baseService: s.baseService,
    employeeNames: workedByLabel(s),
    status: s.status || "pending", completed: !!s.completed, notes: s.notes || [],
    upsells: resolveUpsellNames(s.upsells || [], db),
  }));
  res.json(jobs);
});

// Owner-wide commission audit — every appointment attributed to any sales rep, regardless
// of status (pending, arrived, no-show), with exactly when it closed and why it got the
// rate it did. This is the full-system version of the per-rep audit trail below.
app.get("/api/owner/commission-audit", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  // Must match Payroll's own filtering exactly (excludingCancelled + the revenue start
  // date cutoff) - otherwise these two pages can silently disagree on the same numbers,
  // specifically when a revenue start date has been set to exclude old pre-tracking jobs.
  const relevant = revenueEligible(db.sales.filter((s) => s.salesRepId && inRange(s.date, start, end)), db);
  const rows = relevant.map((s) => {
    const rep = db.salesReps.find((r) => r.id === s.salesRepId);
    const closedAtRaw = s.closedAt || s.date;
    const closedDate = new Date(closedAtRaw);
    const easternLabel = isNaN(closedDate.getTime()) ? "unknown" : closedDate.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const duringHours = isDuringBusinessHours(closedAtRaw);
    const rateApplied = duringHours ? (rep ? rep.commissionRate || 0 : 0) : (rep ? rep.afterHoursCommissionRate || 0 : 0);
    // Projected, not actual — this section answers "if every appointment currently
    // scheduled in this period shows up as planned, what's the commission total," which is
    // a genuinely different question from Payroll's number (actual commission owed, only
    // counting jobs that have actually arrived so far). A no-show or reschedule will change
    // this from what actually gets paid out - that's expected, not a bug.
    const commissionAmount = rep ? (parseFloat(s.basePrice) || 0) * (rateApplied / 100) : 0;
    return {
      saleId: s.id, car: s.car, customerName: s.customerName, basePrice: parseFloat(s.basePrice) || 0,
      salesRepName: rep ? rep.name : "Removed rep", status: s.status || "pending",
      closedAtRaw, closedAtEastern: easternLabel, duringHours, rateApplied, commissionAmount, isReschedule: !!s.isReschedule, closedAtCheck: !!s.closedAtCheck,
    };
  }).sort((a, b) => (a.closedAtRaw < b.closedAtRaw ? 1 : -1));
  res.json(rows);
});

// Closing activity — how much a sales rep actually CLOSED on a given day or week,
// regardless of what day the appointment is scheduled for. This is a genuinely different
// question than the audit above (which tracks appointments happening within a date range,
// and only counts commission once the customer actually shows). A deal closed today might
// be scheduled two weeks out — this measures the calling activity itself, showing what
// that activity is worth in projected commission if it holds, not what's been earned yet.
app.get("/api/owner/closing-activity", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  // A booking the owner marked as a RESCHEDULE is the same deal moved to a new day, not a new sale, so it stays out
  // of closing activity (it's listed separately as "left out", with a way to undo). It is NOT left out of payroll or
  // the appointment lists: when the client shows up, the rep is paid exactly as normal.
  const inClosingRange = db.sales.filter((s) => s.salesRepId && inRange(s.closedAt || s.date, start, end));
  const relevant = revenueEligible(inClosingRange.filter((s) => !s.isReschedule && !redoFree(s)), db);
  const leftOut = revenueEligible(inClosingRange.filter((s) => s.isReschedule), db).map((s) => {
    const r = db.salesReps.find((x) => x.id === s.salesRepId);
    return { saleId: s.id, auto: !!s.rescheduleAutoFlagged, car: s.car, customerName: s.customerName, date: s.date, closedAt: s.closedAt || s.date, basePrice: parseFloat(s.basePrice) || 0, repName: r ? r.name : "Removed rep", status: s.status || "pending" };
  });
  const byRep = {};
  relevant.forEach((s) => {
    const rep = db.salesReps.find((r) => r.id === s.salesRepId);
    const repName = rep ? rep.name : "Removed rep";
    if (!byRep[repName]) byRep[repName] = { name: repName, closeCount: 0, projectedCommission: 0, totalValue: 0, arrivedCount: 0, pendingCount: 0, noShowCount: 0, closes: [] };
    const duringHours = isDuringBusinessHours(s.closedAt || s.date);
    const rate = rep ? (duringHours ? (rep.commissionRate || 0) : (rep.afterHoursCommissionRate || 0)) : 0;
    const basePrice = parseFloat(s.basePrice) || 0;
    const projectedAmount = basePrice * (rate / 100);
    byRep[repName].closeCount += 1;
    byRep[repName].totalValue += basePrice;
    byRep[repName].projectedCommission += projectedAmount;
    if (s.status === "arrived") byRep[repName].arrivedCount += 1;
    else if (s.status === "no_show") byRep[repName].noShowCount += 1;
    else byRep[repName].pendingCount += 1;
    // Individual close detail - so a $0 value is immediately visible and traceable back
    // to a specific job that just needs its price filled in via Cleanup.
    byRep[repName].closes.push({
      saleId: s.id, car: s.car, customerName: s.customerName, date: s.date, closedAt: s.closedAt || s.date,
      basePrice, projectedCommission: projectedAmount, status: s.status || "pending", missingPrice: !s.basePrice,
    });
  });
  const perRep = Object.values(byRep).sort((a, b) => b.closeCount - a.closeCount);
  perRep.forEach((r) => r.closes.sort((a, b) => (a.date < b.date ? 1 : -1)));
  res.json({
    totalCloses: relevant.length,
    totalProjectedCommission: perRep.reduce((a, r) => a + r.projectedCommission, 0),
    totalValue: perRep.reduce((a, r) => a + r.totalValue, 0),
    perRep, leftOut,
  });
});

app.get("/api/my/sales-performance", requireSales, (req, res) => {
  const db = loadDB();
  const repId = req.auth.role === "owner" && req.query.salesRepId ? req.query.salesRepId : req.auth.id;
  const { start, end } = dateRangeFor(req.query);
  const rep = db.salesReps.find((r) => r.id === repId);
  const mine = db.sales.filter((s) => s.salesRepId === repId && inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db));

  const totalBooked = mine.length;
  const totalBookedValue = mine.reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
  const showed = mine.filter((s) => s.status === "arrived");
  const showedValue = showed.reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
  const noShowCount = mine.filter((s) => s.status === "no_show").length;
  const pending = mine.filter((s) => !s.status || s.status === "pending");
  const pendingCount = pending.length;
  const pendingValue = pending.reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);

  let commission = 0, duringHoursValue = 0, afterHoursValue = 0, duringHoursCount = 0, afterHoursCount = 0;
  const commissionAudit = [];
  showed.forEach((s) => {
    const c = salesRepCommissionForSale(rep, s);
    commission += c.amount;
    if (c.duringHours) { duringHoursValue += parseFloat(s.basePrice) || 0; duringHoursCount += 1; }
    else { afterHoursValue += parseFloat(s.basePrice) || 0; afterHoursCount += 1; }
    // A real, per-job audit line — exactly when it closed, which bucket it landed in, and
    // why — so nobody ever has to manually reconstruct this by hand.
    const closedAtRaw = s.closedAt || s.date;
    const closedDate = new Date(closedAtRaw);
    const easternLabel = isNaN(closedDate.getTime()) ? "unknown" : closedDate.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    commissionAudit.push({
      saleId: s.id, car: s.car, basePrice: parseFloat(s.basePrice) || 0,
      closedAtRaw, closedAtEastern: easternLabel,
      duringHours: c.duringHours, rateApplied: c.duringHours ? (rep ? rep.commissionRate || 0 : 0) : (rep ? rep.afterHoursCommissionRate || 0 : 0),
      commissionAmount: c.amount,
    });
  });
  commissionAudit.sort((a, b) => (a.closedAtRaw < b.closedAtRaw ? 1 : -1));

  // Upsells this rep personally closed — tracked for visibility, e.g. a phone upsell on
  // someone else's booking. Separate from the base-sale commission above; shown, not
  // auto-paid, until a specific rate/rule for it is decided.
  const myUpsells = [];
  db.sales.filter((s) => inRange(s.date, start, end) && s.status !== "cancelled" && afterRevenueStart(s, db)).forEach((s) => {
    (s.upsells || []).forEach((u) => { if (u.salesRepId === repId) myUpsells.push({ id: u.id, name: u.name, price: u.price, car: s.car, date: s.date, saleId: s.id }); });
  });
  const upsellsClosedValue = myUpsells.reduce((a, u) => a + (parseFloat(u.price) || 0), 0);

  res.json({
    totalBooked, totalBookedValue, showedCount: showed.length, showedValue,
    noShowCount, pendingCount, pendingValue, commission,
    commissionRate: rep ? rep.commissionRate || 0 : 0,
    afterHoursCommissionRate: rep ? rep.afterHoursCommissionRate || 0 : 0,
    duringHoursCount, duringHoursValue, afterHoursCount, afterHoursValue,
    upsellsClosedCount: myUpsells.length, upsellsClosedValue, upsellsClosed: myUpsells,
    commissionAudit,
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
      employeeNames: s.employeeNames, managerHelperNames: s.managerHelperNames || "", baseService: s.baseService,
      basePrice: s.basePrice || 0, total: saleTotal(s), status: s.status, completed: !!s.completed, paid: !!s.paid, paymentMethod: s.paymentMethod || null,
      salesRepName: s.salesRepName || null, isWalkIn: !!s.isWalkIn, isOnlineBooking: !!s.isOnlineBooking,
      upsells: resolveUpsellNames(s.upsells, db), notes: s.notes || [], photos: s.photos || { before: {}, after: {} },
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

// Serviced Cars — only jobs actually marked Service Complete, regardless of payment status.
// This is the "work actually done" view, distinct from the schedule/booking pipeline.
app.get("/api/owner/serviced-cars", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const sales = db.sales.filter((s) => inRange(s.date, start, end) && s.completed && s.status !== "cancelled");
  res.json(sales.map((s) => ({ ...s, total: saleTotal(s), upsellTotal: saleUpsellTotal(s), upsells: resolveUpsellNames(s.upsells, db) })));
});

// A genuinely separate question from Serviced Cars - a car can arrive without the work
// being finished yet, so this counts by arrival, not completion.
app.get("/api/owner/cars-arrived", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = dateRangeFor(req.query);
  const sales = db.sales.filter((s) => inRange(s.date, start, end) && s.status === "arrived");
  res.json(sales.map((s) => ({ ...s, total: saleTotal(s), upsellTotal: saleUpsellTotal(s), upsells: resolveUpsellNames(s.upsells, db) })));
});

// Payroll view — every person's own upsells grouped together (for paying commission),
// plus the shop-wide combined total for comparison. Owner-only.
// Base pay — salary or hourly, reduced for absences and half days. A full pay period
// is assumed to be 12 workdays (Mon-Sat x 2 weeks), so a salaried person's daily rate is
// their period salary divided by 12. An hourly person without specific start/end times
// entered for a given day (just a normal day, nothing unusual) is assumed to have worked
// a standard 9-hour day, matching this shop's actual business hours (8am-6pm minus a
// lunch hour) - real times entered for that day always override this assumption.
const FULL_PERIOD_WORKDAYS = 12;
const DEFAULT_HOURLY_DAY_HOURS = 9;
function timeStringToHours(t) {
  if (!t) return null;
  const parts = String(t).split(":");
  const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h + m / 60;
}
// "End of day Eastern" converted to UTC can land in the next UTC calendar day (e.g.
// 11:59:59pm Eastern is already past 3am UTC the next day) — slicing that ISO string
// directly would silently pull in one extra day at the end of every attendance range.
// Pulling back a safe margin before slicing corrects it to the actual intended last day.
function endDateStringFor(endIso) {
  return new Date(new Date(endIso).getTime() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function calculateBasePay(person, attendanceRecords, sales) {
  if (!person.payType) return { amount: 0, daysPresent: 0, daysHalf: 0, daysAbsent: 0, hoursCounted: 0, dailyRate: 0, configured: false, carDetails: [] };
  if (person.payType === "salary") {
    const dailyRate = (person.salaryPerPeriod || 0) / FULL_PERIOD_WORKDAYS;
    let amount = 0, daysPresent = 0, daysHalf = 0, daysAbsent = 0;
    attendanceRecords.forEach((a) => {
      if (a.status === "present") { amount += dailyRate; daysPresent++; }
      else if (a.status === "half_day") { amount += dailyRate / 2; daysHalf++; }
      else if (a.status === "absent") { daysAbsent++; }
    });
    return { amount, daysPresent, daysHalf, daysAbsent, hoursCounted: 0, dailyRate, configured: true, carDetails: [] };
  }
  if (person.payType === "commission") {
    // A % of the car's base price, split evenly among everyone who worked it - techs
    // (employeeIds) and any manager who helped hands-on (managerHelperIds) both count,
    // both toward the split total and toward their own share. Same split math as tips,
    // just automatic and tied to the job's price instead of a manually entered amount.
    // Only counts once a car has actually arrived and been paid, same rule walk-in
    // commission already uses, so this reflects money actually collected.
    const allWorkers = (s) => [...(saleEmployeeIds(s) || []), ...(s.managerHelperIds || [])];
    const myCars = (sales || []).filter((s) => allWorkers(s).includes(person.id) && s.status === "arrived" && s.paid);
    let amount = 0;
    const carDetails = myCars.map((s) => {
      const splitCount = allWorkers(s).length;
      const basePrice = parseFloat(s.basePrice) || 0;
      const share = Math.round((basePrice * (person.carCommissionRate || 0) / 100 / splitCount) * 100) / 100;
      amount += share;
      return { id: s.id, car: s.car, basePrice, splitCount, yourShare: share };
    });
    return { amount, daysPresent: 0, daysHalf: 0, daysAbsent: 0, hoursCounted: 0, dailyRate: 0, configured: true, carDetails };
  }
  // hourly
  let amount = 0, hoursCounted = 0, daysPresent = 0, daysHalf = 0, daysAbsent = 0;
  attendanceRecords.forEach((a) => {
    if (a.status === "absent") { daysAbsent++; return; }
    if (!a.status) return;
    const startH = timeStringToHours(a.startTime), endH = timeStringToHours(a.endTime);
    let hours;
    if (startH !== null && endH !== null && endH > startH) hours = endH - startH;
    else hours = a.status === "half_day" ? DEFAULT_HOURLY_DAY_HOURS / 2 : DEFAULT_HOURLY_DAY_HOURS;
    amount += hours * (person.hourlyRate || 0);
    hoursCounted += hours;
    if (a.status === "half_day") daysHalf++; else daysPresent++;
  });
  return { amount, daysPresent, daysHalf, daysAbsent, hoursCounted, dailyRate: 0, configured: true, carDetails: [] };
}

// The payroll calculation, lifted out of the route so a payroll RUN uses exactly the same numbers the Payroll screen shows.
function buildPayroll(db, query) {
  const { start, end } = dateRangeFor(query);
  const sales = revenueEligible(db.sales.filter((s) => inRange(s.date, start, end)), db);
  const shopTotalUpsellRevenue = sales.reduce((a, s) => a + saleUpsellTotal(s), 0);
  const duplicateSaleIds = findDuplicateSaleIds(sales);

  function personBreakdown(idField, id) {
    const mine = [];
    sales.forEach((s) => (s.upsells || []).forEach((u) => { if (u[idField] === id) mine.push({ ...u, saleId: s.id, car: s.car, date: s.date }); }));
    const revenue = mine.reduce((a, u) => a + (parseFloat(u.price) || 0), 0);
    const grouped = {};
    mine.forEach((u) => {
      const k = u.name.trim();
      grouped[k] = grouped[k] || { name: k, count: 0, revenue: 0 };
      grouped[k].count += 1;
      grouped[k].revenue += parseFloat(u.price) || 0;
    });
    return {
      revenue, count: mine.length, items: Object.values(grouped).sort((a, b) => b.revenue - a.revenue),
      individual: mine.slice().sort((a, b) => (a.date < b.date ? 1 : -1)),
    };
  }

  const employees = db.employees.map((emp) => {
    const b = personBreakdown("employeeId", emp.id);
    const carsWorked = sales.filter((s) => saleEmployeeIds(s).includes(emp.id)).length;
    const commission = emp.commissionRate ? b.revenue * (emp.commissionRate / 100) : 0;
    // Walk-ins this tech personally closed — a separate pay source from upsell commission,
    // only counted once a job is BOTH arrived and paid. This was missing from Payroll
    // even though it already worked correctly on the tech's own performance page.
    const myWalkIns = sales.filter((s) => s.walkInClosedByType === "employee" && s.walkInClosedById === emp.id);
    const walkInClosedCount = myWalkIns.length;
    const walkInArrivedPaidCount = myWalkIns.filter((s) => s.status === "arrived" && s.paid).length;
  const walkInRevenue = myWalkIns.filter((s) => s.status === "arrived" && s.paid).reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
    const walkInCommission = myWalkIns.reduce((a, s) => a + walkInCommissionForSale(emp, s), 0);
    // Individual walk-in details - same drill-down pattern already used for upsells and
    // sales rep arrivals, so a tech's walk-in total isn't just an opaque aggregate.
    const walkInDetails = myWalkIns.map((s) => ({
      id: s.id, car: s.car, customerName: s.customerName, date: s.date, basePrice: parseFloat(s.basePrice) || 0,
      status: s.status || "pending", paid: !!s.paid, commissionAmount: walkInCommissionForSale(emp, s),
    }));
    const myAttendance = db.attendance.filter((a) => a.personType === "employee" && a.personId === emp.id && a.date >= start.slice(0, 10) && a.date <= endDateStringFor(end));
    const basePay = calculateBasePay(emp, myAttendance, sales);
    // Tips - matched to whichever pay period the JOB happened in, not when the tip was
    // logged, so this stays consistent with how every other number on this page works.
    const myTips = db.tips.filter((t) => inRange(t.date, start, end) && t.split.some((sp) => sp.personType === "employee" && sp.personId === emp.id));
    const tipsTotal = myTips.reduce((a, t) => a + t.split.find((sp) => sp.personType === "employee" && sp.personId === emp.id).amount, 0);
    const tipDetails = myTips.map((t) => ({ id: t.id, car: t.car, date: t.date, totalAmount: t.amount, yourShare: t.split.find((sp) => sp.personType === "employee" && sp.personId === emp.id).amount, splitCount: t.split.length }));
    return {
      id: emp.id, name: emp.name, commissionRate: emp.commissionRate || 0, carsWorked, upsellRevenue: b.revenue, upsellCount: b.count, commission, upsells: b.items, individualUpsells: b.individual,
      walkInCommissionRate: emp.walkInCommissionRate || 0, walkInClosedCount, walkInArrivedPaidCount, walkInCommission, walkInRevenue, walkInDetails,
      payType: emp.payType || null, salaryPerPeriod: emp.salaryPerPeriod || 0, hourlyRate: emp.hourlyRate || 0, carCommissionRate: emp.carCommissionRate || 0, basePay,
      tipsTotal, tipDetails,
      totalPay: commission + walkInCommission + basePay.amount + tipsTotal,
    };
  });
  const managers = db.managers.map((mgr) => {
    const b = personBreakdown("managerId", mgr.id);
    const carsWorked = sales.filter((s) => (s.managerHelperIds || []).includes(mgr.id)).length;      // cars the manager worked hands-on, counted like a tech's
    const commission = mgr.commissionRate ? b.revenue * (mgr.commissionRate / 100) : 0;
    const myWalkIns = sales.filter((s) => s.walkInClosedByType === "manager" && s.walkInClosedById === mgr.id);
    const walkInClosedCount = myWalkIns.length;
    const walkInArrivedPaidCount = myWalkIns.filter((s) => s.status === "arrived" && s.paid).length;
  const walkInRevenue = myWalkIns.filter((s) => s.status === "arrived" && s.paid).reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
    const walkInCommission = myWalkIns.reduce((a, s) => a + walkInCommissionForSale(mgr, s), 0);
    const walkInDetails = myWalkIns.map((s) => ({
      id: s.id, car: s.car, customerName: s.customerName, date: s.date, basePrice: parseFloat(s.basePrice) || 0,
      status: s.status || "pending", paid: !!s.paid, commissionAmount: walkInCommissionForSale(mgr, s),
    }));
    const myAttendance = db.attendance.filter((a) => a.personType === "manager" && a.personId === mgr.id && a.date >= start.slice(0, 10) && a.date <= endDateStringFor(end));
    const basePay = calculateBasePay(mgr, myAttendance, sales);
    const myTips = db.tips.filter((t) => inRange(t.date, start, end) && t.split.some((sp) => sp.personType === "manager" && sp.personId === mgr.id));
    const tipsTotal = myTips.reduce((a, t) => a + t.split.find((sp) => sp.personType === "manager" && sp.personId === mgr.id).amount, 0);
    const tipDetails = myTips.map((t) => ({ id: t.id, car: t.car, date: t.date, totalAmount: t.amount, yourShare: t.split.find((sp) => sp.personType === "manager" && sp.personId === mgr.id).amount, splitCount: t.split.length }));
    return {
      id: mgr.id, name: mgr.name, commissionRate: mgr.commissionRate || 0, carsWorked, upsellRevenue: b.revenue, upsellCount: b.count, commission, upsells: b.items, individualUpsells: b.individual,
      walkInCommissionRate: mgr.walkInCommissionRate || 0, walkInClosedCount, walkInArrivedPaidCount, walkInCommission, walkInRevenue, walkInDetails,
      payType: mgr.payType || null, salaryPerPeriod: mgr.salaryPerPeriod || 0, hourlyRate: mgr.hourlyRate || 0, carCommissionRate: mgr.carCommissionRate || 0, basePay,
      tipsTotal, tipDetails,
      totalPay: commission + walkInCommission + basePay.amount + tipsTotal,
    };
  });
  // Sales reps are a different pay structure entirely — commission on the base sale, only
  // when the manager marked it arrived. Not tied to upsells at all.
  const salesReps = db.salesReps.map((rep) => {
    const mine = sales.filter((s) => s.salesRepId === rep.id && !redoFree(s));
    const showed = mine.filter((s) => s.status === "arrived");
    const noShow = mine.filter((s) => s.status === "no_show");
    const resolved = showed.length + noShow.length; // excludes still-pending future bookings
    const noShowRate = resolved > 0 ? (noShow.length / resolved) * 100 : 0;
    const showedValue = showed.reduce((a, s) => a + (parseFloat(s.basePrice) || 0), 0);
    let commission = 0, duringHoursCount = 0, afterHoursCount = 0;
    const duplicateWarnings = [];
    showed.forEach((s) => {
      const c = salesRepCommissionForSale(rep, s);
      commission += c.amount;
      if (c.duringHours) duringHoursCount += 1; else afterHoursCount += 1;
      if (duplicateSaleIds.has(s.id)) duplicateWarnings.push({ id: s.id, car: s.car, date: s.date, basePrice: s.basePrice, commissionAmount: c.amount });
    });
    // Individual arrived/no-show details - lets Payroll show a real drill-down instead of
    // just the aggregate counts, so you can see exactly which cars are behind each number.
    const arrivedDetails = showed.map((s) => ({ id: s.id, car: s.car, customerName: s.customerName, date: s.date, basePrice: parseFloat(s.basePrice) || 0, commissionAmount: salesRepCommissionForSale(rep, s).amount }));
    const noShowDetails = noShow.map((s) => ({ id: s.id, car: s.car, customerName: s.customerName, date: s.date, basePrice: parseFloat(s.basePrice) || 0 }));
    return { id: rep.id, name: rep.name, commissionRate: rep.commissionRate || 0, afterHoursCommissionRate: rep.afterHoursCommissionRate || 0, totalBooked: mine.length, showedCount: showed.length, showedValue, duringHoursCount, afterHoursCount, commission, noShowCount: noShow.length, noShowRate, duplicateWarnings, arrivedDetails, noShowDetails };
  });

  return { shopTotalUpsellRevenue, employees, managers, salesReps };
}
app.get("/api/owner/payroll", requireOwner, (req, res) => res.json(buildPayroll(loadDB(), req.query)));

// =====================================================================================================================================
// PAYROLL RUNS for techs and managers (sales reps are not part of this and are left exactly as they were).
// One schedule (see payschedule.js), one button. "Run payroll" works out everyone for a period using the SAME calculation the Payroll
// screen shows, saves a frozen register of what was calculated, and the screen moves on to the next period. Periods are run in order.
// Nothing runs by itself: a day nobody marked pays $0, so a person looks at the checklist and presses the button.
// =====================================================================================================================================
const paySchedule = require("./payschedule");
function trackerToday() { return process.env.TRACKER_TODAY || EASTERN_DAY_FMT.format(new Date()); } // the override exists only so tests can set the date
const payRound = (n) => Math.round((Number(n) || 0) * 100) / 100;
const payRuns = (db) => (db.payrollRuns = db.payrollRuns || []);
const payAdjustments = (db) => (db.payrollAdjustments = db.payrollAdjustments || []);
const payKey = (type, id) => `${type}:${id}`;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const payShortDate = (ymd) => `${MONTHS_SHORT[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}`;
const payPlural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

// Every tech and manager's pay for a period: exactly what the Payroll screen shows, split into the pieces a payroll provider asks for.
function teamPayrollLines(db, period) {
  const data = buildPayroll(db, { period: "custom", startDate: period.start, endDate: period.end });
  const line = (type, p) => {
    const upsell = payRound(p.commission), walkIn = payRound(p.walkInCommission), tips = payRound(p.tipsTotal);
    const subtotal = payRound(p.totalPay);                     // the same total the Payroll screen shows for this person
    const base = payRound(subtotal - upsell - walkIn - tips);   // a stray cent of rounding lands here, so the pieces always add up to the total
    return { key: payKey(type, p.id), personType: type, personId: p.id, name: p.name, payType: p.payType || null, base, upsellCommission: upsell, walkInCommission: walkIn, tips, subtotal,
      daysPresent: p.basePay.daysPresent || 0, daysHalf: p.basePay.daysHalf || 0, daysAbsent: p.basePay.daysAbsent || 0, hours: payRound(p.basePay.hoursCounted || 0) };
  };
  return [...data.employees.map((e) => line("employee", e)), ...data.managers.map((m) => line("manager", m))];
}

// What to look at before pressing the button.
function payrollPreview(db, period) {
  const warnings = [];
  const days = [];
  for (let d = period.start; d <= period.end; d = paySchedule.add(d, 1)) if (paySchedule.dow(d) !== 0) days.push(d);   // closed Sundays
  const people = [...db.employees.map((p) => ({ type: "employee", p })), ...db.managers.map((p) => ({ type: "manager", p }))].filter((x) => x.p.payType === "salary" || x.p.payType === "hourly");
  const gaps = [];
  people.forEach(({ type, p }) => {
    const have = new Set(db.attendance.filter((a) => a.personType === type && a.personId === p.id && a.status).map((a) => a.date));
    const missing = days.filter((d) => !have.has(d));
    if (missing.length) gaps.push({ name: p.name, days: missing });
  });
  if (gaps.length) {
    const total = gaps.reduce((a, g) => a + g.days.length, 0);
    warnings.push({ code: "attendance", count: total, text: `${payPlural(total, "work day")} with no attendance marked (${payPlural(gaps.length, "person", "people")}). A day nobody marked pays $0.`, items: gaps.slice(0, 12).map((g) => `${g.name}: ${g.days.slice(0, 8).map(payShortDate).join(", ")}${g.days.length > 8 ? "…" : ""}`) });
  }
  const range = dateRangeFor({ period: "custom", startDate: period.start, endDate: period.end });
  const jobs = revenueEligible(db.sales.filter((s) => inRange(s.date, range.start, range.end)), db);
  const jobLine = (s) => `${s.car} (${String(s.date).slice(0, 10)})`;
  const unpaid = jobs.filter((s) => s.status === "arrived" && !s.paid && !redoFree(s));
  if (unpaid.length) warnings.push({ code: "unpaid", count: unpaid.length, text: `${payPlural(unpaid.length, "job")} dated in this period arrived but ${unpaid.length === 1 ? "isn't" : "aren't"} marked paid. Commissions only count paid jobs.`, items: unpaid.slice(0, 8).map(jobLine) });
  const unmarked = jobs.filter((s) => !s.status || s.status === "pending" || s.status === "unconfirmed");
  if (unmarked.length) warnings.push({ code: "unmarked", count: unmarked.length, text: `${payPlural(unmarked.length, "job")} dated in this period ${unmarked.length === 1 ? "was" : "were"} never marked arrived or no-show.`, items: unmarked.slice(0, 8).map(jobLine) });
  const messy = jobs.filter((s) => !redoFree(s) && (!s.basePrice || !s.baseService || (!s.salesRepId && !s.isWalkIn && !s.isOnlineBooking)));
  if (messy.length) warnings.push({ code: "cleanup", count: messy.length, text: `${payPlural(messy.length, "job")} ${messy.length === 1 ? "is" : "are"} missing a price, service or sales rep (see Cleanup).`, items: messy.slice(0, 8).map(jobLine) });
  // Corrections made to an EARLIER check after it was run that nobody has put on a check yet: say so now, so an underpayment isn't forgotten.
  payRuns(db).filter((r) => !r.skipped && r.end < period.start).sort((x, y) => (x.start < y.start ? -1 : 1)).forEach((r) => {
    const d = payrollDiff(db, r);
    if (d.under.length) warnings.push({ code: "corrections", count: d.under.length, text: `${payShortDate(r.start)} - ${payShortDate(r.end)} payroll has ${payPlural(d.under.length, "correction")} since it was run that no check has picked up yet. Go back to that period and press "Add the underpayments to the next check".`, items: d.under.map((x) => `${x.name}: +$${x.delta.toFixed(2)}`) });
  });
  return { warnings, workDays: days.length };
}

function payrollStatus(db, period) {
  const runs = payRuns(db), today = trackerToday();
  const run = runs.find((r) => r.periodId === period.id) || null;
  const over = period.end < today;
  const blockedBy = paySchedule.isRunnableKind(period)
    ? paySchedule.periods().find((p) => paySchedule.isRunnableKind(p) && p.start < period.start && !runs.some((r) => r.periodId === p.id)) || null
    : null;
  return { run, over, blockedBy, runnable: paySchedule.isRunnableKind(period) && !run && over && !blockedBy };
}

// After a period has been run, things can still change (attendance corrected, a job marked paid late, a tip added). This is what is
// different now compared with what was calculated, per person. Anything already carried forward to a later check is not counted again.
function payrollDiff(db, run) {
  if (run.skipped) return { under: [], over: [] };
  const period = paySchedule.periodByRange(run.start, run.end);
  const live = new Map(teamPayrollLines(db, period).map((l) => [l.key, l]));
  const exists = new Set([...db.employees.map((e) => payKey("employee", e.id)), ...db.managers.map((m) => payKey("manager", m.id))]);
  const snap = new Map(run.lines.map((l) => [l.key, l]));
  const out = { under: [], over: [] };
  new Set([...snap.keys(), ...live.keys()]).forEach((k) => {
    if (!exists.has(k)) return;                                   // someone removed since: nothing to pay or flag
    const l = live.get(k), sn = snap.get(k), ref = l || sn;
    const delta = payRound((l ? l.subtotal : 0) - (sn ? sn.subtotal : 0) - ((run.carried && run.carried[k]) || 0));
    if (Math.abs(delta) < 0.01) return;
    (delta > 0 ? out.under : out.over).push({ key: k, personType: ref.personType, personId: ref.personId, name: ref.name, calculated: sn ? sn.subtotal : 0, now: l ? l.subtotal : 0, delta });
  });
  return out;
}

app.get("/api/owner/pay-schedule", requireOwner, (req, res) => {
  const db = loadDB(), today = trackerToday(), runs = payRuns(db);
  const periods = paySchedule.periods().map((p) => { const r = runs.find((x) => x.periodId === p.id); return { ...p, closedRunId: r ? r.id : null, skipped: !!(r && r.skipped) }; });
  const inside = periods.findIndex((p) => p.start <= today && today <= p.end);
  const first = periods.findIndex((p) => paySchedule.isRunnableKind(p) && !p.closedRunId);
  res.json({ today, periods, containingIndex: inside >= 0 ? inside : periods.findIndex((p) => p.start > today), runnableIndex: first >= 0 && periods[first].end < today ? first : -1 });
});

app.get("/api/owner/payroll-run-status", requireOwner, (req, res) => {
  const db = loadDB();
  const period = paySchedule.periodByRange(req.query.start, req.query.end);
  if (!period || !paySchedule.isRunnableKind(period)) return res.json({ period: null });
  const st = payrollStatus(db, period);
  const pending = payAdjustments(db).filter((a) => !a.appliedRunId);
  const body = {
    period, today: trackerToday(), over: st.over, runnable: st.runnable,
    blockedBy: st.blockedBy ? { id: st.blockedBy.id, start: st.blockedBy.start, end: st.blockedBy.end, name: st.blockedBy.name } : null,
    run: st.run, pending,
  };
  if (!st.run) {
    body.preview = payrollPreview(db, period);
    const firstRunnable = paySchedule.periods().find(paySchedule.isRunnableKind);
    if (firstRunnable && firstRunnable.id === period.id) body.trueUp = paySchedule.FIRST_TRUE_UP;
  } else if (!st.run.skipped) { body.diff = payrollDiff(db, st.run); body.afterPayday = !!st.run.paid && trackerToday() > st.run.paid; }
  res.json(body);
});

app.post("/api/owner/payroll-run", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end, confirmWarnings } = req.body || {};
  const period = paySchedule.periodByRange(start, end);
  if (!period || !paySchedule.isRunnableKind(period)) return res.status(400).json({ error: "That isn't one of the pay periods on the schedule." });
  const st = payrollStatus(db, period);
  if (st.run) return res.status(409).json({ error: `Payroll for ${payShortDate(period.start)} - ${payShortDate(period.end)} was already run.` });
  if (!st.over) return res.status(400).json({ error: `This pay period isn't over yet. It ends ${payShortDate(period.end)}, so it can be run from ${payShortDate(paySchedule.add(period.end, 1))}.` });
  if (st.blockedBy) return res.status(400).json({ error: `Run ${payShortDate(st.blockedBy.start)} - ${payShortDate(st.blockedBy.end)} first. Pay periods are run in order.` });
  const preview = payrollPreview(db, period);
  if (preview.warnings.length > 0 && !confirmWarnings) return res.status(409).json({ needsConfirm: true, error: "There are things to check before running this payroll.", warnings: preview.warnings });

  const lines = teamPayrollLines(db, period).map((l) => ({ ...l, adjustments: [], adjustmentsTotal: 0, total: l.subtotal }));
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const applied = [];
  payAdjustments(db).filter((a) => !a.appliedRunId).forEach((a) => {
    const k = payKey(a.personType, a.personId);
    let l = byKey.get(k);
    if (!l) { l = { key: k, personType: a.personType, personId: a.personId, name: a.personName, payType: null, base: 0, upsellCommission: 0, walkInCommission: 0, tips: 0, subtotal: 0, daysPresent: 0, daysHalf: 0, daysAbsent: 0, hours: 0, adjustments: [], adjustmentsTotal: 0, total: 0 }; lines.push(l); byKey.set(k, l); }
    l.adjustments.push({ id: a.id, note: a.note, amount: a.amount, source: a.source });
    l.adjustmentsTotal = payRound(l.adjustmentsTotal + a.amount);
    l.total = payRound(l.subtotal + l.adjustmentsTotal);
    applied.push(a);
  });
  const kept = lines.filter((l) => l.subtotal !== 0 || l.adjustments.length > 0 || l.payType);
  const sum = (f) => payRound(kept.reduce((a, l) => a + f(l), 0));
  const run = {
    id: newId(), periodId: period.id, start: period.start, end: period.end, name: period.name, kind: period.kind, workDays: period.workDays,
    submit: period.submit, paid: period.paid, ...(period.note ? { note: period.note } : {}),
    closedAt: new Date().toISOString(), closedBy: "Owner", ranWithWarnings: preview.warnings.map((w) => w.code),
    lines: kept,
    totals: { base: sum((l) => l.base), upsellCommission: sum((l) => l.upsellCommission), walkInCommission: sum((l) => l.walkInCommission), tips: sum((l) => l.tips), adjustments: sum((l) => l.adjustmentsTotal), total: sum((l) => l.total) },
    carried: {},
  };
  applied.forEach((a) => { a.appliedRunId = run.id; });
  payRuns(db).unshift(run);
  saveDB(db);
  res.json(run);
});

// "We paid this period another way, outside the tracker": lets the next one be run (periods go in order) without making up numbers.
app.post("/api/owner/payroll-run/skip", requireOwner, (req, res) => {
  const db = loadDB();
  const { start, end } = req.body || {};
  const period = paySchedule.periodByRange(start, end);
  if (!period || !paySchedule.isRunnableKind(period)) return res.status(400).json({ error: "That isn't one of the pay periods on the schedule." });
  const st = payrollStatus(db, period);
  if (st.run) return res.status(409).json({ error: "That period was already run." });
  if (!st.over) return res.status(400).json({ error: "That pay period isn't over yet." });
  if (st.blockedBy) return res.status(400).json({ error: `Deal with ${payShortDate(st.blockedBy.start)} - ${payShortDate(st.blockedBy.end)} first. Pay periods go in order.` });
  const run = { id: newId(), periodId: period.id, start: period.start, end: period.end, name: period.name, kind: period.kind, workDays: period.workDays, submit: period.submit, paid: period.paid, closedAt: new Date().toISOString(), closedBy: "Owner", skipped: true, lines: [], totals: { base: 0, upsellCommission: 0, walkInCommission: 0, tips: 0, adjustments: 0, total: 0 }, carried: {} };
  payRuns(db).unshift(run);
  saveDB(db);
  res.json(run);
});

// Anything that turned out UNDERPAID since a period was run goes on the next check as an adjustment. Anything that looks OVERPAID is only flagged:
// it is never deducted automatically (many states require written permission to deduct from pay).
app.post("/api/owner/payroll-run/:id/carry-forward", requireOwner, (req, res) => {
  const db = loadDB();
  const run = payRuns(db).find((r) => r.id === req.params.id);
  if (!run || run.skipped) return res.status(404).json({ error: "Payroll run not found." });
  const diff = payrollDiff(db, run);
  if (diff.under.length === 0) return res.status(400).json({ error: "Nobody is owed anything extra for this period right now." });
  run.carried = run.carried || {};
  const created = diff.under.map((d) => {
    run.carried[d.key] = payRound((run.carried[d.key] || 0) + d.delta);
    const adj = { id: newId(), personType: d.personType, personId: d.personId, personName: d.name, amount: d.delta, note: `Change since ${payShortDate(run.start)} - ${payShortDate(run.end)} payroll was run`, source: "carried", fromRunId: run.id, createdAt: new Date().toISOString(), createdBy: "Owner", appliedRunId: null };
    payAdjustments(db).push(adj);
    return adj;
  });
  saveDB(db);
  res.json({ created, stillOver: diff.over });
});

// RE-RUN a payroll that has already been run, so the checks come out right after something was corrected (a job marked paid late, attendance fixed, a tip added).
// It rebuilds the saved register from today's numbers and keeps the adjustments that were on that check; the earlier version is kept in the run's history.
// Rules that keep anyone from being paid twice or having pay quietly taken back:
//  - if part of the change was already carried to a LATER check, it is refused (re-running would pay it twice);
//  - if it was carried but is still waiting for the next check, that carried amount is removed, because this check now includes it;
//  - adjustments added since stay on the NEXT check unless the owner asks for them to come onto this one;
//  - after the pay date the owner must confirm the checks for the period have not gone out;
//  - people who no longer exist keep the line that was recorded (they were already paid).
// "dryRun" only shows what would change. Nothing is deducted automatically either way: a lower total just means the check is smaller.
app.post("/api/owner/payroll-run/:id/rerun", requireOwner, (req, res) => {
  const db = loadDB(), { dryRun, confirmWarnings, checksNotOut, includePending } = req.body || {};
  const run = payRuns(db).find((r) => r.id === req.params.id);
  if (!run || run.skipped) return res.status(404).json({ error: "Payroll run not found." });
  const period = paySchedule.periodByRange(run.start, run.end);
  if (!period) return res.status(400).json({ error: "That isn't one of the pay periods on the schedule." });
  const adjAll = payAdjustments(db);
  const carriedAdj = adjAll.filter((a) => a.source === "carried" && a.fromRunId === run.id);
  const carriedUsed = carriedAdj.filter((a) => a.appliedRunId);
  if (carriedUsed.length) {
    const later = payRuns(db).find((r) => r.id === carriedUsed[0].appliedRunId);
    return res.status(409).json({ blocked: true, error: `Part of this period's change was already added to a later check${later ? ` (${payShortDate(later.start)} - ${payShortDate(later.end)})` : ""}. Re-running it would pay that part twice, so it can't be re-run.` });
  }
  const carriedPending = carriedAdj.filter((a) => !a.appliedRunId);
  const addNow = includePending ? adjAll.filter((a) => !a.appliedRunId && !carriedPending.includes(a)) : [];
  const afterPayday = !!run.paid && trackerToday() > run.paid;
  const exists = new Set([...db.employees.map((e) => payKey("employee", e.id)), ...db.managers.map((m) => payKey("manager", m.id))]);
  const lines = teamPayrollLines(db, period).map((l) => ({ ...l, adjustments: [], adjustmentsTotal: 0, total: l.subtotal }));
  const byKey = new Map(lines.map((l) => [l.key, l]));
  [...adjAll.filter((a) => a.appliedRunId === run.id), ...addNow].forEach((a) => {
    const k = payKey(a.personType, a.personId);
    let l = byKey.get(k);
    if (!l) { l = { key: k, personType: a.personType, personId: a.personId, name: a.personName, payType: null, base: 0, upsellCommission: 0, walkInCommission: 0, tips: 0, subtotal: 0, daysPresent: 0, daysHalf: 0, daysAbsent: 0, hours: 0, adjustments: [], adjustmentsTotal: 0, total: 0 }; lines.push(l); byKey.set(k, l); }
    l.adjustments.push({ id: a.id, note: a.note, amount: a.amount, source: a.source });
    l.adjustmentsTotal = payRound(l.adjustmentsTotal + a.amount);
    l.total = payRound(l.subtotal + l.adjustmentsTotal);
  });
  let kept = lines.filter((l) => l.subtotal !== 0 || l.adjustments.length > 0 || l.payType);
  run.lines.forEach((old) => { if (!exists.has(old.key) && !kept.some((l) => l.key === old.key)) kept.push(old); });      // someone removed since: their recorded line stays
  const sum = (f) => payRound(kept.reduce((t, l) => t + f(l), 0));
  const totals = { base: sum((l) => l.base), upsellCommission: sum((l) => l.upsellCommission), walkInCommission: sum((l) => l.walkInCommission), tips: sum((l) => l.tips), adjustments: sum((l) => l.adjustmentsTotal), total: sum((l) => l.total) };
  const was = new Map(run.lines.map((l) => [l.key, l])), now = new Map(kept.map((l) => [l.key, l])), changes = [];
  new Set([...was.keys(), ...now.keys()]).forEach((k) => {
    const o = was.get(k), n = now.get(k), ref = n || o, delta = payRound((n ? n.total : 0) - (o ? o.total : 0));
    if (Math.abs(delta) < 0.01) return;
    changes.push({ key: k, name: ref.name, oldTotal: o ? o.total : 0, newTotal: n ? n.total : 0, delta });
  });
  changes.sort((a, b) => a.name.localeCompare(b.name));
  const preview = payrollPreview(db, period);
  const body = { runId: run.id, afterPayday, payDate: run.paid || null, changes, oldTotals: run.totals, newTotals: totals, revision: run.revision || 1, warnings: preview.warnings,
    voidedCarried: carriedPending.map((a) => ({ name: a.personName, amount: a.amount })),
    pendingLeft: adjAll.filter((a) => !a.appliedRunId && !carriedPending.includes(a) && !addNow.includes(a)).map((a) => ({ name: a.personName, amount: a.amount, note: a.note })) };
  if (dryRun) return res.json({ preview: true, ...body });
  if (afterPayday && !checksNotOut) return res.status(409).json({ needsCheckConfirm: true, error: `The pay date for this period (${payShortDate(run.paid)}) has passed. Only re-run it if the checks for this period have NOT gone out yet.` });
  if (preview.warnings.length > 0 && !confirmWarnings) return res.status(409).json({ needsConfirm: true, error: "There are things to check before re-running this payroll.", warnings: preview.warnings });
  run.revisions = run.revisions || [];
  run.revisions.push({ revision: run.revision || 1, at: run.revisedAt || run.closedAt, lines: run.lines, totals: run.totals });
  run.lines = kept; run.totals = totals; run.revision = (run.revision || 1) + 1; run.revisedAt = new Date().toISOString(); run.revisedBy = "Owner"; run.revisedAfterPayday = afterPayday; run.ranWithWarnings = preview.warnings.map((w) => w.code); run.carried = {};
  carriedPending.forEach((a) => { const i = adjAll.indexOf(a); if (i >= 0) adjAll.splice(i, 1); });
  addNow.forEach((a) => { a.appliedRunId = run.id; });
  saveDB(db);
  res.json({ ok: true, ...body, run });
});

app.post("/api/owner/payroll-adjustments", requireOwner, (req, res) => {
  const db = loadDB();
  const { personType, personId, amount, note } = req.body || {};
  const person = personType === "employee" ? db.employees.find((e) => e.id === personId) : personType === "manager" ? db.managers.find((m) => m.id === personId) : null;
  if (!person) return res.status(400).json({ error: "Choose a tech or manager." });
  const amt = Number(amount);
  if (!isFinite(amt) || amt === 0 || Math.abs(amt) > 100000) return res.status(400).json({ error: "Enter an amount (plus or minus), not zero." });
  const text = String(note || "").trim();
  if (!text || text.length > 200) return res.status(400).json({ error: "Add a short note saying what this is for (up to 200 characters)." });
  const adj = { id: newId(), personType, personId, personName: person.name, amount: payRound(amt), note: text, source: "manual", createdAt: new Date().toISOString(), createdBy: "Owner", appliedRunId: null };
  payAdjustments(db).push(adj);
  saveDB(db);
  res.json(adj);
});

app.delete("/api/owner/payroll-adjustments/:id", requireOwner, (req, res) => {
  const db = loadDB();
  const adj = payAdjustments(db).find((a) => a.id === req.params.id);
  if (!adj) return res.status(404).json({ error: "Adjustment not found." });
  if (adj.appliedRunId) return res.status(400).json({ error: "That adjustment is already on a payroll that was run, so it can't be removed." });
  db.payrollAdjustments = payAdjustments(db).filter((a) => a.id !== adj.id);
  saveDB(db);
  res.json({ ok: true });
});

// Full raw backup — everyone's data, as a downloadable file the owner can save anywhere
// (their own computer, Google Drive, wherever) independent of Railway entirely.
// Checks whether the GHL import actually created duplicate jobs, or whether the running
// "imported" counter just double-counted re-processed records without creating duplicates
// (the counter increments on every upsert call, including ones that update an existing
// job rather than creating a new one — so the counter can honestly exceed the real total).
// Real audit trail for price, service, and sales rep changes - who changed what, when.
app.get("/api/owner/audit-log", requireOwner, (req, res) => {
  const db = loadDB();
  res.json((db.auditLog || []).slice(0, 200));
});

app.get("/api/owner/import-diagnostic", requireOwner, (req, res) => {
  const db = loadDB();
  const withOppId = db.sales.filter((s) => s.ghlOpportunityId);
  const idCounts = {};
  withOppId.forEach((s) => { idCounts[s.ghlOpportunityId] = (idCounts[s.ghlOpportunityId] || 0) + 1; });
  const duplicateIds = Object.entries(idCounts).filter(([id, count]) => count > 1);

  // Same real customer, multiple separate opportunities — a much stronger signal than
  // opportunity ID, and the one that actually catches "duplicate-looking" jobs that are
  // genuinely different GHL records (e.g. left over from testing appointment status
  // toggles before the bulk import existed).
  const withContactId = db.sales.filter((s) => s.contactId && s.status !== "cancelled");
  const byContact = {};
  withContactId.forEach((s) => { (byContact[s.contactId] = byContact[s.contactId] || []).push(s); });
  const contactDuplicates = Object.entries(byContact)
    .filter(([id, group]) => group.length > 1)
    .map(([contactId, group]) => ({
      contactId, count: group.length,
      jobs: group.map((s) => ({ id: s.id, car: s.car, date: s.date, customerName: s.customerName, basePrice: s.basePrice, ghlOpportunityId: s.ghlOpportunityId })),
    }));

  // Jobs missing the very IDs the checks above rely on — if a webhook event (like a
  // reschedule) doesn't include these, duplicates from it are invisible to every check
  // above, since there's nothing shared to match them by.
  const activeSales = db.sales.filter((s) => s.status !== "cancelled");
  const missingOppId = activeSales.filter((s) => !s.ghlOpportunityId);
  const missingContactId = activeSales.filter((s) => !s.contactId);

  // Fallback: same customer name + same calendar day, regardless of whether ghlOpportunityId
  // or contactId are present at all — catches duplicates the ID-based checks structurally
  // cannot see.
  const byNameAndDay = {};
  activeSales.forEach((s) => {
    if (!s.customerName || !s.date) return;
    const key = `${s.customerName.trim().toLowerCase()}|${s.date.slice(0, 10)}`;
    (byNameAndDay[key] = byNameAndDay[key] || []).push(s);
  });
  const nameAndDayDuplicates = Object.entries(byNameAndDay)
    .filter(([key, group]) => group.length > 1)
    .map(([key, group]) => ({
      customerName: group[0].customerName, date: group[0].date.slice(0, 10), count: group.length,
      jobs: group.map((s) => ({ id: s.id, car: s.car, date: s.date, basePrice: s.basePrice, ghlOpportunityId: s.ghlOpportunityId || null, contactId: s.contactId || null })),
    }));

  // Broader net: same customer name, ANY date — catches a reschedule that moved someone
  // to a completely different day, which the same-day check above structurally can't see.
  // Wider net means real risk of a genuine repeat customer showing up here too — needs a
  // human eye, not an auto-fix.
  const byNameOnly = {};
  activeSales.forEach((s) => {
    if (!s.customerName) return;
    const key = s.customerName.trim().toLowerCase();
    (byNameOnly[key] = byNameOnly[key] || []).push(s);
  });
  const nameOnlyDuplicates = Object.entries(byNameOnly)
    .filter(([key, group]) => group.length > 1)
    .map(([key, group]) => ({
      customerName: group[0].customerName, count: group.length,
      jobs: group.map((s) => ({ id: s.id, car: s.car, date: s.date, basePrice: s.basePrice, ghlOpportunityId: s.ghlOpportunityId || null, contactId: s.contactId || null })),
    }));

  res.json({
    totalSalesInDatabase: db.sales.length,
    salesWithGhlOpportunityId: withOppId.length,
    uniqueOpportunityIds: Object.keys(idCounts).length,
    duplicateOpportunityIds: duplicateIds.length,
    duplicateExamples: duplicateIds.slice(0, 5).map(([id, count]) => ({ ghlOpportunityId: id, count })),
    contactsWithMultipleJobs: contactDuplicates.length,
    contactDuplicates: contactDuplicates.slice(0, 20),
    missingOppIdCount: missingOppId.length,
    missingContactIdCount: missingContactId.length,
    nameAndDayDuplicateGroups: nameAndDayDuplicates.length,
    nameAndDayDuplicates: nameAndDayDuplicates.slice(0, 20),
    nameOnlyDuplicateGroups: nameOnlyDuplicates.length,
    nameOnlyDuplicates: nameOnlyDuplicates.slice(0, 30),
  });
});

// One-click cleanup: for every customer with multiple separate jobs, keep whichever one
// has the most recent date and delete the rest. Dry run shows exactly what would happen
// before anything is touched — worth a quick skim, but not a per-group manual review.
app.post("/api/owner/dedupe-contacts", requireOwner, (req, res) => {
  const db = loadDB();
  const dryRun = !!req.body.dryRun;
  const withContactId = db.sales.filter((s) => s.contactId && s.status !== "cancelled");
  const byContact = {};
  withContactId.forEach((s) => { (byContact[s.contactId] = byContact[s.contactId] || []).push(s); });

  const plan = [];
  Object.values(byContact).forEach((group) => {
    if (group.length < 2) return;
    // Prefer whichever record actually has a real price — a $0 duplicate is almost always
    // a stale/incomplete GHL record, not the real booking, regardless of which one happens
    // to have the most recent date.
    const sorted = group.slice().sort((a, b) => {
      const aPriced = (parseFloat(a.basePrice) || 0) > 0;
      const bPriced = (parseFloat(b.basePrice) || 0) > 0;
      if (aPriced !== bPriced) return aPriced ? -1 : 1;
      return a.date < b.date ? 1 : -1;
    });
    const keep = sorted[0];
    const remove = sorted.slice(1);
    plan.push({
      keep: { id: keep.id, car: keep.car, date: keep.date, customerName: keep.customerName, basePrice: keep.basePrice },
      remove: remove.map((s) => ({ id: s.id, car: s.car, date: s.date, customerName: s.customerName, basePrice: s.basePrice })),
    });
  });

  if (!dryRun) {
    const removeIds = new Set(plan.flatMap((p) => p.remove.map((r) => r.id)));
    db.sales = db.sales.filter((s) => !removeIds.has(s.id));
    saveDB(db);
  }

  res.json({ ok: true, dryRun, groupsAffected: plan.length, totalRemoved: plan.reduce((a, p) => a + p.remove.length, 0), plan: plan.slice(0, 30) });
});

app.get("/api/owner/backup", requireOwner, (req, res) => {
  const db = loadDB();
  const filename = `sbn-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(db, null, 2));
});

// Revenue tracking start date — the real fix. Nothing about any job's actual price ever
// changes. Instead, every job dated before this cutoff simply gets skipped when totaling
// revenue or commission anywhere in the app, while still showing up completely normally
// in All Jobs, Search, and the schedule with its real original price intact.
app.get("/api/owner/revenue-start-date", requireOwner, (req, res) => {
  const db = loadDB();
  res.json({ revenueStartDate: db.revenueStartDate || null });
});
app.post("/api/owner/revenue-start-date", requireOwner, (req, res) => {
  const db = loadDB();
  db.revenueStartDate = req.body.date || null;
  saveDB(db);
  res.json({ ok: true, revenueStartDate: db.revenueStartDate });
});

// ---------- automated cloud backup — runs on its own, no manual click required ----------
// Pushes a copy of the entire database to a private GitHub repo on a schedule. This is
// genuinely off-Railway, genuinely automatic, and genuinely durable — the actual answer
// to "if the site breaks, I don't want to lose anything." Requires GITHUB_BACKUP_TOKEN
// and GITHUB_BACKUP_REPO to be set as environment variables; if they're not set, this
// quietly does nothing rather than crashing the app.
const GITHUB_BACKUP_TOKEN = process.env.GITHUB_BACKUP_TOKEN || "";
const GITHUB_BACKUP_REPO = process.env.GITHUB_BACKUP_REPO || ""; // format: "yourusername/your-repo"
let lastCloudBackup = null;

async function runCloudBackup() {
  if (!GITHUB_BACKUP_TOKEN || !GITHUB_BACKUP_REPO) {
    lastCloudBackup = { time: new Date().toISOString(), ok: false, error: "Not configured — set GITHUB_BACKUP_TOKEN and GITHUB_BACKUP_REPO." };
    return lastCloudBackup;
  }
  try {
    const db = loadDB();
    const content = Buffer.from(JSON.stringify(db, null, 2)).toString("base64");
    const apiBase = `https://api.github.com/repos/${GITHUB_BACKUP_REPO}/contents`;
    const headers = {
      Authorization: `Bearer ${GITHUB_BACKUP_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };

    // Always-current backup — one file, overwritten every time, for a fast restore.
    let sha;
    try {
      const getRes = await fetch(`${apiBase}/backups/latest.json`, { headers });
      if (getRes.ok) { const j = await getRes.json(); sha = j.sha; }
    } catch (e) {}
    const putRes = await fetch(`${apiBase}/backups/latest.json`, {
      method: "PUT", headers,
      body: JSON.stringify({ message: `Backup ${new Date().toISOString()}`, content, sha }),
    });
    if (!putRes.ok) {
      const errBody = await putRes.text();
      lastCloudBackup = { time: new Date().toISOString(), ok: false, error: `GitHub returned ${putRes.status}: ${errBody.slice(0, 200)}` };
      return lastCloudBackup;
    }

    // Also keep one dated snapshot per day, so there's real history to fall back to.
    const today = new Date().toISOString().slice(0, 10);
    const snapshotPath = `backups/snapshots/${today}.json`;
    let snapshotExists = false;
    try {
      const checkRes = await fetch(`${apiBase}/${snapshotPath}`, { headers });
      snapshotExists = checkRes.ok;
    } catch (e) {}
    if (!snapshotExists) {
      await fetch(`${apiBase}/${snapshotPath}`, {
        method: "PUT", headers,
        body: JSON.stringify({ message: `Daily snapshot ${today}`, content }),
      });
    }

    lastCloudBackup = { time: new Date().toISOString(), ok: true };
  } catch (e) {
    lastCloudBackup = { time: new Date().toISOString(), ok: false, error: e.message };
  }
  return lastCloudBackup;
}

app.get("/api/owner/backup-status", requireOwner, (req, res) => {
  res.json({ configured: !!(GITHUB_BACKUP_TOKEN && GITHUB_BACKUP_REPO), last: lastCloudBackup });
});

app.post("/api/owner/backup-now", requireOwner, async (req, res) => {
  const result = await runCloudBackup();
  res.json(result);
});

// ---------- GHL API bulk import — Phase 1: diagnostic only ----------
// This does NOT import anything. Each of these makes one real, read-only API call to GHL
// and dumps the raw response into the debug log — building up a real picture of your
// account's data shape, piece by piece, before any import logic gets written.
const GHL_API_TOKEN = process.env.GHL_API_TOKEN || "";
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "";
const GHL_API_BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";

// A customer can have SEVERAL appointments (several cars), so "the customer's appointment" is ambiguous. This picks the
// appointment that belongs to THIS job: its own appointment id first (the booking workflow keys every job on it), then the
// exact start time, then - only when the customer has exactly one upcoming appointment and exactly one such job - that
// one. If it can't tell, it returns nothing: leaving a title alone is far better than putting one car's title on another.
function appointmentForJob(sale, events, jobsForContact, now) {
  const isCancelled = (e) => String(e.appointmentStatus || e.status || "").toLowerCase() === "cancelled";
  const startMs = (e) => { const iso = normalizeDate(e.startTime); const ms = iso ? Date.parse(iso) : NaN; return ms; };
  const active = events.filter((e) => !isCancelled(e));
  if (sale.ghlOpportunityId) {
    const own = events.find((e) => e.id && e.id === sale.ghlOpportunityId);
    if (own) return own;
  }
  const saleMs = Date.parse(sale.date);
  if (!isNaN(saleMs)) {
    const sameTime = active.filter((e) => { const ms = startMs(e); return !isNaN(ms) && Math.abs(ms - saleMs) <= 60000; });
    if (sameTime.length === 1) return sameTime[0];
    if (sameTime.length > 1) return null;
  }
  const upcoming = active.filter((e) => { const ms = startMs(e); return !isNaN(ms) && ms >= now.getTime() - 24 * 60 * 60 * 1000; });
  if (jobsForContact.length === 1 && upcoming.length === 1) return upcoming[0];
  return null;
}

// GHL never fires any event for a plain title edit after booking — there's no signal to
// listen for, so instead of waiting for one, this periodically asks GHL directly using
// the same API connection the bulk import uses. Runs on upcoming jobs only, within a
// reasonable near-term window, so it stays a light, bounded check rather than scanning
// your entire history every time. One lookup per customer, and each job only ever takes the title of its OWN
// appointment; a title that was edited by hand in the tracker is locked and never overwritten.
async function runTitleSync() {
  if (!GHL_API_TOKEN || !GHL_LOCATION_ID) return { skipped: true, reason: "GHL API not configured on this deployment." };
  const db = loadDB();
  const now = new Date();
  const horizon = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000); // next 3 weeks
  const upcoming = db.sales.filter((s) =>
    s.contactId && ["arrived", "no_show", "cancelled"].indexOf(s.status) === -1 &&
    !isNaN(new Date(s.date).getTime()) && new Date(s.date) >= now && new Date(s.date) <= horizon
  );
  // Also any job still missing its price from the last 45 days, even if it has already happened: the team often puts the price in
  // the GHL title only after the car has been serviced, and GHL never announces a title edit. Matching to the right appointment is
  // as strict as ever (its own appointment id, or its exact start time), so a job it can't identify is simply left alone.
  const lookback = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
  const unpriced = db.sales.filter((s) =>
    s.contactId && s.status !== "cancelled" && !s.isRedo && !(parseFloat(s.basePrice) > 0) && !s.priceLocked &&
    !isNaN(new Date(s.date).getTime()) && new Date(s.date) >= lookback && new Date(s.date) <= horizon
  );
  const candidates = Array.from(new Map(upcoming.concat(unpriced).map((s) => [s.id, s])).values());
  const byContact = {};
  candidates.forEach((s) => { (byContact[s.contactId] = byContact[s.contactId] || []).push(s); });
  let checked = 0, updated = 0, ambiguous = 0;
  for (const [contactId, jobs] of Object.entries(byContact)) {
    try {
      const apptUrl = `${GHL_API_BASE}/contacts/${contactId}/appointments`;
      const apptRes = await fetch(apptUrl, { headers: { Authorization: `Bearer ${GHL_API_TOKEN}`, Version: "2021-07-28", Accept: "application/json" } });
      const apptBody = await apptRes.json().catch(() => null);
      const events = (apptBody && apptBody.events) || [];
      if (events.length === 0) continue;
      const taken = new Set();
      for (const sale of jobs) {
        if (sale.titleLocked) continue; // edited by hand in the tracker: the tracker's title wins
        const appt = appointmentForJob(sale, events, jobs, now);
        if (!appt) { ambiguous += 1; continue; } // can't tell which appointment is this job's: leave it alone
        if (appt.id) { if (taken.has(appt.id)) { ambiguous += 1; continue; } taken.add(appt.id); } // one appointment can only belong to one job
        checked++;
        const title = String(appt.title || "").trim();
        if (title && title !== sale.car) {
          const before = sale.car;
          sale.car = title;
          applyTitleRules(db, sale);
          if (!db.auditLog) db.auditLog = [];
          db.auditLog.unshift({ id: newId(), timestamp: new Date().toISOString(), actor: "Auto-sync (GHL)", saleId: sale.id, car: sale.car, field: "Car/Title", oldValue: before, newValue: sale.car });
          db.auditLog = db.auditLog.slice(0, 1000);
          updated++;
        }
      }
      await new Promise((r) => setTimeout(r, 200)); // same pacing as the bulk import - stays well under GHL's rate limits
    } catch (e) {
      // one bad lookup shouldn't stop the whole run - just skip it and keep going
    }
  }
  const repriced = backfillTitlePricing(db); // every job picks up the price its title carries, even if the title didn't change
  const reflagged = autoFlagRescheduleFromTitle(db); // a title that now says rescheduled, or an earlier booking that has just turned dead
  if (updated > 0 || repriced > 0 || reflagged > 0) saveDB(db);
  return { skipped: false, candidateCount: candidates.length, checked, updated, ambiguous, repriced, reflagged };
}

// Lets a manager see EXACTLY what GHL has for this job's customer, so the right title (and time) can be applied with one
// tap when the automatic sync can't tell two appointments apart (for example two jobs that were bulk-imported with the
// same time). It only reads from GHL; nothing changes until a manager picks one.
app.get("/api/manager/jobs/:id/ghl-appointments", requireManager, async (req, res) => {
  if (!GHL_API_TOKEN || !GHL_LOCATION_ID) return res.json({ configured: false });
  const db = loadDB();
  const sale = db.sales.find((s) => s.id === req.params.id);
  if (!sale) return res.status(404).json({ error: "Job not found." });
  if (!sale.contactId) return res.json({ configured: true, appointments: [], note: "This job has no GHL contact on file, so there's nothing to compare." });
  let events;
  try {
    const r = await fetch(`${GHL_API_BASE}/contacts/${sale.contactId}/appointments`, { headers: { Authorization: `Bearer ${GHL_API_TOKEN}`, Version: "2021-07-28", Accept: "application/json" } });
    if (!r.ok) throw new Error(`GHL answered ${r.status}`);
    const body = await r.json();
    events = (body && body.events) || [];
  } catch (e) {
    return res.status(502).json({ error: "Couldn't reach GHL: " + (e.message || "unknown error") });
  }
  const mine = db.sales.filter((s) => s.contactId === sale.contactId && s.status !== "cancelled");
  // Two jobs for this customer at the same time (e.g. bulk-imported together) can't be told apart, so don't hint at all.
  const sameSlot = mine.filter((s) => Math.abs(Date.parse(s.date) - Date.parse(sale.date)) <= 60000).length > 1;
  const ownEvent = events.find((e) => e.id && e.id === sale.ghlOpportunityId);
  const match = sameSlot && !ownEvent ? null : appointmentForJob(sale, events, mine, new Date());
  const appointments = events.map((e) => {
    const title = String(e.title || "").trim();
    return {
      id: e.id || "", title, startTime: normalizeDate(e.startTime) || null, status: String(e.appointmentStatus || e.status || ""),
      matchesThisJob: !!match && match === e,
      sameTitleAsJob: title === sale.car,
      belongsToAnotherJob: !!e.id && db.sales.some((s) => s.id !== sale.id && s.contactId === sale.contactId && s.ghlOpportunityId === e.id),
    };
  }).sort((a, b) => String(a.startTime || "").localeCompare(String(b.startTime || "")));
  res.json({ configured: true, currentTitle: sale.car, currentDate: sale.date, appointments });
});

app.post("/api/owner/title-sync-now", requireOwner, async (req, res) => {
  const result = await runTitleSync();
  res.json({ ok: true, ...result });
});

async function ghlTestCall(db, label, url) {
  if (!db.debugLog) db.debugLog = [];
  if (!GHL_API_TOKEN || !GHL_LOCATION_ID) {
    return { error: "GHL_API_TOKEN and GHL_LOCATION_ID must be set as environment variables first." };
  }
  try {
    const ghlRes = await fetch(url, {
      headers: { Authorization: `Bearer ${GHL_API_TOKEN}`, Version: "2021-07-28", Accept: "application/json" },
    });
    const bodyText = await ghlRes.text();
    let parsed;
    try { parsed = JSON.parse(bodyText); } catch (e) { parsed = bodyText; }
    db.debugLog.unshift({ receivedAt: new Date().toISOString(), endpoint: label, requestUrl: url, responseStatus: ghlRes.status, responseBody: parsed });
    db.debugLog = db.debugLog.slice(0, 30);
    saveDB(db);
    return { ok: true, status: ghlRes.status };
  } catch (e) {
    db.debugLog.unshift({ receivedAt: new Date().toISOString(), endpoint: label, error: e.message });
    db.debugLog = db.debugLog.slice(0, 30);
    saveDB(db);
    return { error: e.message };
  }
}

app.post("/api/owner/ghl-import-test", requireOwner, async (req, res) => {
  const db = loadDB();
  const r = await ghlTestCall(db, "ghl-import-test", `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_LOCATION_ID}&limit=5`);
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, note: "Check the Webhook Debug Log to see the full raw response." });
});

// Test 2 — get the real pipeline stage names, so we can identify which stage ID means
// "Booked w/ Deposit" (the search results showed IDs, not names).
app.post("/api/owner/ghl-test-pipelines", requireOwner, async (req, res) => {
  const db = loadDB();
  const r = await ghlTestCall(db, "ghl-test-pipelines", `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, note: "Check the debug log for pipeline stage names and IDs." });
});

// Test 2b — now that we know the real "Booked W Deposit" stage ID, pull opportunities
// filtered specifically to that stage, instead of just the most recent leads overall.
app.post("/api/owner/ghl-test-booked-stage", requireOwner, async (req, res) => {
  const db = loadDB();
  const stageId = req.body.stageId;
  if (!stageId) return res.status(400).json({ error: "stageId is required." });
  const url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_stage_id=${stageId}&limit=5`;
  const r = await ghlTestCall(db, "ghl-test-booked-stage", url);
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, note: "Check the debug log — this should show real booked jobs, hopefully with a real assignedTo value this time." });
});

// Test 3 — look up one specific contact directly, to check whether their assigned
// "Owner" (sales rep) shows up at the contact level, since it wasn't in the opportunity data.
app.post("/api/owner/ghl-test-contact", requireOwner, async (req, res) => {
  const db = loadDB();
  const contactId = req.body.contactId;
  if (!contactId) return res.status(400).json({ error: "contactId is required." });
  const r = await ghlTestCall(db, "ghl-test-contact", `https://services.leadconnectorhq.com/contacts/${contactId}`);
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, note: "Check the debug log for the contact's real field names, especially anything like 'assignedTo' or 'owner'." });
});

// Test 4 — pull calendar/appointment data for one contact, since that's where the car
// (appointment title) and real service date/time actually live.
app.post("/api/owner/ghl-test-appointments", requireOwner, async (req, res) => {
  const db = loadDB();
  const contactId = req.body.contactId;
  if (!contactId) return res.status(400).json({ error: "contactId is required." });
  const r = await ghlTestCall(db, "ghl-test-appointments", `https://services.leadconnectorhq.com/contacts/${contactId}/appointments`);
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, note: "Check the debug log for the appointment title (car) and real date/time." });
});

// Test 5 — the appointment's assignedUserId is just a random-looking ID, not a name.
// This resolves it into the actual person's real name, so we can match it against your
// registered sales reps/managers/techs the same way the webhook flow already does.
app.post("/api/owner/ghl-test-user", requireOwner, async (req, res) => {
  const db = loadDB();
  const userId = req.body.userId;
  if (!userId) return res.status(400).json({ error: "userId is required." });
  const r = await ghlTestCall(db, "ghl-test-user", `https://services.leadconnectorhq.com/users/${userId}`);
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, note: "Check the debug log — looking for firstName/lastName or a name field." });
});

// The title text itself usually names the service — a low-risk way to fill this in using
// data we already have, rather than guessing from an unconfirmed calendar-ID mapping.
function guessServiceFromTitle(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("ceramic")) return "Ceramic Coating";
  if (t.includes("tint")) return "Window Tint";
  if (t.includes("ppf")) return "PPF";
  return "";
}

// ---------- GHL bulk import — Phase 2: the real thing ----------
// Pulls opportunities from the "Booked W Deposit" stage, looks up each contact's actual
// appointment (car, real date), and imports using the exact same upsert logic as the live
// webhook flow — so re-running this is always safe, never creates duplicates. Runs in
// small batches with a resumable cursor rather than all at once, both to stay well under
// any request timeout and so a dry-run preview can be checked before anything is saved.
app.post("/api/owner/ghl-bulk-import", requireOwner, async (req, res) => {
  const db = loadDB();
  if (!GHL_API_TOKEN || !GHL_LOCATION_ID) {
    return res.status(400).json({ error: "GHL_API_TOKEN and GHL_LOCATION_ID must be set first." });
  }
  const stageId = req.body.stageId;
  const cutoffDate = req.body.cutoffDate || null; // "YYYY-MM-DD" — only import appointments on/after this
  const dryRun = !!req.body.dryRun;
  const batchSize = Math.min(parseInt(req.body.batchSize, 10) || 15, 25); // capped for safety
  if (!stageId) return res.status(400).json({ error: "stageId is required." });

  if (db.ghlImportCursor === undefined) db.ghlImportCursor = null;
  if (db.ghlImportImportedCount === undefined) db.ghlImportImportedCount = 0;

  const baseUrl = `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_stage_id=${stageId}&limit=${batchSize}`;
  const url = db.ghlImportCursor || baseUrl;

  let searchRes, searchBody;
  try {
    searchRes = await fetch(url, { headers: { Authorization: `Bearer ${GHL_API_TOKEN}`, Version: "2021-07-28", Accept: "application/json" } });
    searchBody = await searchRes.json();
  } catch (e) {
    return res.status(500).json({ error: "Failed to reach GHL: " + e.message });
  }
  if (!searchRes.ok) {
    if (!db.debugLog) db.debugLog = [];
    db.debugLog.unshift({ receivedAt: new Date().toISOString(), endpoint: "ghl-bulk-import", requestUrl: url, responseStatus: searchRes.status, responseBody: searchBody });
    db.debugLog = db.debugLog.slice(0, 30);
    saveDB(db);
    return res.status(400).json({ error: `GHL returned ${searchRes.status} — check the Webhook Debug Log for the exact reason.`, detail: searchBody });
  }

  const opportunities = searchBody.opportunities || [];
  const results = { processed: 0, imported: 0, skippedOld: 0, skippedNoAppointment: 0, errors: [] };
  const preview = [];

  for (const opp of opportunities) {
    results.processed++;
    try {
      const apptUrl = `https://services.leadconnectorhq.com/contacts/${opp.contactId}/appointments`;
      const apptRes = await fetch(apptUrl, { headers: { Authorization: `Bearer ${GHL_API_TOKEN}`, Version: "2021-07-28", Accept: "application/json" } });
      const apptBody = await apptRes.json().catch(() => null);
      const events = (apptBody && apptBody.events) || [];
      if (events.length === 0) { results.skippedNoAppointment++; continue; }
      // If a contact has multiple appointments, the most recently created one is usually
      // the one tied to this specific deposit.
      const appt = events.slice().sort((a, b) => (a.dateAdded < b.dateAdded ? 1 : -1))[0];
      const normalizedDate = normalizeDate(appt.startTime);
      if (cutoffDate && normalizedDate && normalizedDate.slice(0, 10) < cutoffDate) { results.skippedOld++; continue; }

      const contact = opp.contact || {};
      // The real "closed" moment — when GHL's opportunity actually moved to Won — not
      // whenever this import happened to run. Without this, every bulk-imported job's
      // business-hours classification was silently based on the import's run time.
      const realClosedAt = opp.lastStatusChangeAt || opp.createdAt || null;
      // Which calendar this came through is a far more reliable signal than the title text
      // for what service this actually is — a genuine online booking's title is often just
      // the customer's name, with no service keyword to guess from at all, but the calendar
      // itself is unambiguous.
      const calendarService = (db.calendarServiceMap || {})[appt.calendarId];
      const record = {
        ghlOpportunityId: opp.id, contactId: opp.contactId,
        car: appt.title || "", date: appt.startTime, basePrice: opp.monetaryValue,
        customerName: contact.name || "", customerPhone: contact.phone || "", customerEmail: contact.email || "",
        baseService: calendarService || guessServiceFromTitle(appt.title), closedAt: realClosedAt,
        calendarId: appt.calendarId || null,
      };
      if (dryRun) preview.push(record);
      else { upsertSaleFromGHL(db, record); results.imported++; }
      // Small pacing delay between per-contact lookups — stays well under GHL's rate limits.
      await new Promise((r) => setTimeout(r, 200));
    } catch (e) {
      results.errors.push({ opportunityId: opp.id, error: e.message });
    }
  }

  if (!dryRun) {
    // Use GHL's own complete next-page URL as-is, rather than reconstructing pagination
    // params by hand — that reconstruction was the actual cause of the 422 error.
    db.ghlImportCursor = (searchBody.meta && searchBody.meta.nextPageUrl) ? searchBody.meta.nextPageUrl : null;
    db.ghlImportImportedCount = (db.ghlImportImportedCount || 0) + results.imported;
    saveDB(db);
  }

  res.json({
    ok: true, dryRun, ...results, preview: dryRun ? preview : undefined,
    hasMore: !!(searchBody.meta && searchBody.meta.nextPageUrl) && opportunities.length > 0,
    totalAvailable: searchBody.meta ? searchBody.meta.total : null,
    totalImportedSoFar: db.ghlImportImportedCount || 0,
  });
});

// Repairs the real closing timestamp on jobs already sitting in the tracker from a
// previous import that ran before this fix existed. Uses its OWN separate progress
// cursor from the main import, so running one never interferes with the other. Only
// touches closedAt — price, status, attribution, everything else stays exactly as-is.
app.post("/api/owner/ghl-repair-closedat", requireOwner, async (req, res) => {
  const db = loadDB();
  if (!GHL_API_TOKEN || !GHL_LOCATION_ID) {
    return res.status(400).json({ error: "GHL_API_TOKEN and GHL_LOCATION_ID must be set first." });
  }
  const stageId = req.body.stageId;
  const dryRun = !!req.body.dryRun;
  const batchSize = Math.min(parseInt(req.body.batchSize, 10) || 15, 25);
  if (!stageId) return res.status(400).json({ error: "stageId is required." });

  if (db.ghlRepairCursor === undefined) db.ghlRepairCursor = null;
  if (db.ghlRepairFixedCount === undefined) db.ghlRepairFixedCount = 0;

  const baseUrl = `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_stage_id=${stageId}&limit=${batchSize}`;
  const url = db.ghlRepairCursor || baseUrl;

  let searchRes, searchBody;
  try {
    searchRes = await fetch(url, { headers: { Authorization: `Bearer ${GHL_API_TOKEN}`, Version: "2021-07-28", Accept: "application/json" } });
    searchBody = await searchRes.json();
  } catch (e) {
    return res.status(500).json({ error: "Failed to reach GHL: " + e.message });
  }
  if (!searchRes.ok) return res.status(400).json({ error: `GHL returned ${searchRes.status}`, detail: searchBody });

  const opportunities = searchBody.opportunities || [];
  const results = { processed: 0, fixed: 0, noMatchingJob: 0, alreadyCorrect: 0, preview: [] };

  opportunities.forEach((opp) => {
    results.processed++;
    const sale = db.sales.find((s) => s.ghlOpportunityId === opp.id);
    if (!sale) { results.noMatchingJob++; return; }
    const correctClosedAt = opp.lastStatusChangeAt || opp.createdAt || null;
    if (!correctClosedAt) return;
    if (sale.closedAt === correctClosedAt) { results.alreadyCorrect++; return; }
    const before = sale.closedAt;
    if (dryRun) {
      results.preview.push({ car: sale.car, before, after: correctClosedAt });
    } else {
      sale.closedAt = correctClosedAt;
      results.fixed++;
    }
  });

  if (!dryRun) {
    db.ghlRepairCursor = (searchBody.meta && searchBody.meta.nextPageUrl) ? searchBody.meta.nextPageUrl : null;
    db.ghlRepairFixedCount = (db.ghlRepairFixedCount || 0) + results.fixed;
    saveDB(db);
  }

  res.json({
    ok: true, dryRun, ...results,
    hasMore: !!(searchBody.meta && searchBody.meta.nextPageUrl) && opportunities.length > 0,
    totalFixedSoFar: db.ghlRepairFixedCount || 0,
  });
});

app.get("/api/owner/ghl-repair-closedat-status", requireOwner, (req, res) => {
  const db = loadDB();
  res.json({ cursorSet: !!db.ghlRepairCursor, totalFixedSoFar: db.ghlRepairFixedCount || 0 });
});

app.post("/api/owner/ghl-repair-closedat-reset", requireOwner, (req, res) => {
  const db = loadDB();
  db.ghlRepairCursor = null;
  db.ghlRepairFixedCount = 0;
  saveDB(db);
  res.json({ ok: true });
});

app.get("/api/owner/ghl-bulk-import-status", requireOwner, (req, res) => {
  const db = loadDB();
  res.json({ cursorSet: !!db.ghlImportCursor, totalImportedSoFar: db.ghlImportImportedCount || 0 });
});

app.post("/api/owner/ghl-bulk-import-reset", requireOwner, (req, res) => {
  const db = loadDB();
  db.ghlImportCursor = null;
  db.ghlImportImportedCount = 0;
  saveDB(db);
  res.json({ ok: true });
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
  const sales = revenueEligible(db.sales.filter((s) => inRange(s.date, start, end)), db);
  // "Total revenue" means money actually collected — decided purely by whether payment
  // (cash, card, or both) has been marked, regardless of whether Service Complete is
  // checked. A job can be paid before the work is finished (deposit, pay-ahead, etc.) and
  // that money is real the moment it's collected.
  const realizedSales = sales.filter((s) => s.paid);
  const totalRevenue = realizedSales.reduce((a, s) => a + saleTotal(s), 0);
  const totalUpsell = realizedSales.reduce((a, s) => a + saleUpsellTotal(s), 0);
  // Walk-in revenue — how much of that realized total came from walk-ins specifically,
  // same paid basis as Total Revenue so the numbers are a genuine breakdown, not a
  // different measurement.
  const walkInRevenue = realizedSales.filter((s) => s.isWalkIn).reduce((a, s) => a + saleTotal(s), 0);
  // "Cars serviced" means the job is actually done — a manager marked it Service Complete.
  // Everything still on the schedule (booked, arrived-but-not-done, etc.) doesn't count yet.
  const completedSales = sales.filter((s) => s.completed);
  const carCount = completedSales.length;
  const attachRate = carCount ? (completedSales.filter((s) => (s.upsells || []).length > 0).length / carCount) * 100 : 0;

  // Booking pipeline breakdown — separate from the strict "Total Revenue" above, this shows
  // what's still upcoming (booked but hasn't happened yet) vs. what's already shown up
  // (regardless of whether it's been fully wrapped up and paid).
  const pendingSales = sales.filter((s) => !s.status || s.status === "pending");
  const bookedNotShownValue = pendingSales.reduce((a, s) => a + saleTotal(s), 0);
  const bookedNotShownCount = pendingSales.length;
  const shownUpSales = sales.filter((s) => s.status === "arrived");
  const shownUpValue = shownUpSales.reduce((a, s) => a + saleTotal(s), 0);
  const shownUpCount = shownUpSales.length;

  // Base price isn't split per tech since jobs are tag-teamed — "cars worked" and each
  // person's own logged upsell revenue are the numbers that stay unambiguous here.
  const perEmployee = db.employees.map((emp) => {
    const carsWorked = sales.filter((s) => saleEmployeeIds(s).includes(emp.id));
    const myUpsellRevenue = sales.reduce((a, s) => a + (s.upsells || []).filter((u) => u.employeeId === emp.id).reduce((x, u) => x + (parseFloat(u.price) || 0), 0), 0);
    return { id: emp.id, name: emp.name, cars: carsWorked.length, upsellRevenue: myUpsellRevenue };
  });
  // Managers upsell too, and some work cars hands-on (marked "manager also helped" on the job), which counts as a car worked just like a tech's.
  const perManager = db.managers.map((mgr) => {
    const myUpsellRevenue = sales.reduce((a, s) => a + (s.upsells || []).filter((u) => u.managerId === mgr.id).reduce((x, u) => x + (parseFloat(u.price) || 0), 0), 0);
    return { id: mgr.id, name: mgr.name, cars: sales.filter((s) => (s.managerHelperIds || []).includes(mgr.id)).length, upsellRevenue: myUpsellRevenue };
  });
  // Sales reps get commission on the BASE sale, only when it showed (manager-marked) —
  // completely separate from upsell commission the techs/managers earn.
  const perSalesRep = db.salesReps.map((rep) => {
    const mine = sales.filter((s) => s.salesRepId === rep.id && !redoFree(s));
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
    totalRevenue, totalUpsellRevenue: totalUpsell, walkInRevenue,
    upsellPercentOfRevenue: totalRevenue ? (totalUpsell / totalRevenue) * 100 : 0,
    carCount, attachRate, perEmployee, perManager, perSalesRep, leaderboard,
    bookedNotShownValue, bookedNotShownCount, shownUpValue, shownUpCount,
  });
});

// ---------- Statistics ----------
// "Money" on this page means exactly what the Dashboard's Total revenue means: jobs marked PAID, counted
// on the day of the appointment, never cancelled, and nothing dated before the revenue start date. That
// way the two screens can never disagree. Days are Eastern days, same as everywhere else in the app.
const ymdOf = (iso) => EASTERN_DAY_FMT.format(new Date(iso));
const shiftYmd = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetweenYmd = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
const mondayOfYmd = (ymd) => shiftYmd(ymd, -((new Date(ymd + "T12:00:00Z").getUTCDay() + 6) % 7));
const EASTERN_WEEKDAY_HOUR_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", hour: "2-digit", hourCycle: "h23" });
function easternWeekdayHour(iso) {
  const p = Object.fromEntries(EASTERN_WEEKDAY_HOUR_FMT.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, hour: Number(p.hour) };
}
const statRound = (n) => Math.round((n || 0) * 100) / 100;
const statSum = (list, f) => list.reduce((a, x) => a + f(x), 0);
const WEEKDAYS_MON_FIRST = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// The headline numbers, worked out the same way for the chosen period and for the one before it, so
// every tile can show how it compares.
function statsHeadline(db, start, end) {
  const inP = (iso) => inRange(iso, start, end);
  const sales = revenueEligible(db.sales.filter((s) => inP(s.date)), db);
  const paid = sales.filter((s) => s.paid);
  const revenue = statSum(paid, saleTotal);
  const upsellRevenue = statSum(paid, saleUpsellTotal);
  const completed = sales.filter((s) => s.completed);
  const pending = sales.filter((s) => !s.status || s.status === "pending");
  const arrived = sales.filter((s) => s.status === "arrived").length;
  const noShow = sales.filter((s) => s.status === "no_show").length;
  const cancelled = db.sales.filter((s) => inP(s.date) && s.status === "cancelled" && afterRevenueStart(s, db)).length;
  const closed = db.sales.filter((s) => s.status !== "cancelled" && !s.isReschedule && !redoFree(s) && afterRevenueStart(s, db) && inP(s.closedAt || s.date));
  const dealValue = statSum(closed, (s) => parseFloat(s.basePrice) || 0);
  return {
    revenue: statRound(revenue), paidJobs: paid.length, avgTicket: statRound(paid.length ? revenue / paid.length : 0),
    upsellRevenue: statRound(upsellRevenue), upsellPercent: revenue ? (upsellRevenue / revenue) * 100 : 0,
    carsServiced: completed.length, attachRate: completed.length ? (completed.filter((s) => (s.upsells || []).length > 0).length / completed.length) * 100 : 0,
    arrived, noShow, noShowRate: arrived + noShow ? (noShow / (arrived + noShow)) * 100 : 0,
    dealsClosed: closed.length, dealValue: statRound(dealValue), avgDeal: closed.length ? statRound(dealValue / closed.length) : 0,
    walkInRevenue: statRound(statSum(paid.filter((s) => s.isWalkIn), saleTotal)), onlineRevenue: statRound(statSum(paid.filter((s) => s.isOnlineBooking), saleTotal)),
    pendingJobs: pending.length, pendingValue: statRound(statSum(pending, saleTotal)),
    cancelled, cancelRate: cancelled + sales.length ? (cancelled / (cancelled + sales.length)) * 100 : 0,
    tips: statRound(statSum(db.tips.filter((t) => inP(t.date)), (t) => t.amount || 0)),
  };
}

// The same kind of period, one step back - calendar-aware (last month, last year, the 14 days before a
// pay period), so "vs previous" compares like with like.
function previousStatsQuery(q, today) {
  if (q.period === "all") return null;
  if (q.period === "day") return { period: "day", date: shiftYmd(q.date, -1) };
  if (q.period === "week") return { period: "week", date: shiftYmd(q.date, -7) };
  if (q.period === "payperiod") return { period: "payperiod", date: shiftYmd(q.date, -14) };
  if (q.period === "year") return { period: "year", date: `${Number(q.date.slice(0, 4)) - 1}-01-01` };
  if (q.period === "custom") { const len = daysBetweenYmd(q.startDate, q.endDate) + 1; return { period: "custom", startDate: shiftYmd(q.startDate, -len), endDate: shiftYmd(q.startDate, -1) }; }
  const [y, mo] = q.month.split("-").map(Number);
  return { period: "month", month: mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}` };
}

// Best day / week / month so far. Independent of the period picker, and only days up to today count -
// money paid in advance for a future day isn't a record yet.
function statsRecords(db, today) {
  const revenue = {}, cars = {}, closed = {};
  revenueEligible(db.sales, db).forEach((s) => {
    const d = ymdOf(s.date);
    if (s.paid) revenue[d] = (revenue[d] || 0) + saleTotal(s);
    if (s.completed) cars[d] = (cars[d] || 0) + 1;
  });
  db.sales.filter((s) => s.status !== "cancelled" && !s.isReschedule && !redoFree(s) && afterRevenueStart(s, db)).forEach((s) => {
    const d = ymdOf(s.closedAt || s.date);
    const c = (closed[d] = closed[d] || { count: 0, value: 0 });
    c.count += 1; c.value += parseFloat(s.basePrice) || 0;
  });
  const ranges = {
    week: [mondayOfYmd(today), today], month: [today.slice(0, 7) + "-01", today],
    year: [today.slice(0, 4) + "-01-01", today], all: ["0000-01-01", today],
  };
  const within = (map, [from, to]) => Object.keys(map).filter((d) => d >= from && d <= to);
  // Highest score wins; on a tie the later day.
  const best = (map, range, scoreFn) => {
    let top = null;
    within(map, range).forEach((d) => {
      const sc = scoreFn(d);
      const cmp = sc[0] - top?.sc[0] || sc[1] - top?.sc[1];
      if (!top || cmp > 0 || (cmp === 0 && d > top.d)) top = { d, sc };
    });
    return top && top.d;
  };
  const bucket = (keyFn, range) => {
    const sums = {};
    within(revenue, range).forEach((d) => { const k = keyFn(d); sums[k] = (sums[k] || 0) + revenue[d]; });
    let top = null;
    Object.entries(sums).forEach(([k, v]) => { if (!top || v > top.revenue || (v === top.revenue && k > top.key)) top = { key: k, revenue: v }; });
    return top && { key: top.key, revenue: statRound(top.revenue) };
  };
  const eachRange = (fn) => Object.fromEntries(Object.entries(ranges).map(([k, r]) => [k, fn(r)]));
  return {
    bestDayCollected: eachRange((r) => { const d = best(revenue, r, (x) => [revenue[x], cars[x] || 0]); return d ? { day: d, revenue: statRound(revenue[d]), cars: cars[d] || 0 } : null; }),
    bestDayCars: eachRange((r) => { const d = best(cars, r, (x) => [cars[x], revenue[x] || 0]); return d ? { day: d, cars: cars[d], revenue: statRound(revenue[d] || 0) } : null; }),
    bestDayClosed: eachRange((r) => { const d = best(closed, r, (x) => [closed[x].value, closed[x].count]); return d ? { day: d, value: statRound(closed[d].value), count: closed[d].count } : null; }),
    bestWeek: { year: bucket(mondayOfYmd, ranges.year), all: bucket(mondayOfYmd, ranges.all) },
    bestMonth: { year: bucket((d) => d.slice(0, 7), ranges.year), all: bucket((d) => d.slice(0, 7), ranges.all) },
  };
}

// Money collected and cars serviced over time: daily for a short period, weekly for a long one, monthly for
// "all time". Quiet days stay in as gaps; empty buckets still in the future are trimmed off the end.
function statsTrend(db, firstDay, lastDay, today) {
  const span = daysBetweenYmd(firstDay, lastDay) + 1;
  const unit = span <= 62 ? "day" : span <= 400 ? "week" : "month";
  const keyOf = (d) => (unit === "day" ? d : unit === "week" ? mondayOfYmd(d) : d.slice(0, 7));
  const buckets = {};
  const ensure = (k) => (buckets[k] = buckets[k] || { key: k, revenue: 0, cars: 0 });
  for (let d = firstDay; d <= lastDay; d = shiftYmd(d, 1)) ensure(keyOf(d));
  revenueEligible(db.sales, db).forEach((s) => {
    const d = ymdOf(s.date);
    if (d < firstDay || d > lastDay) return;
    const b = ensure(keyOf(d));
    if (s.paid) b.revenue += saleTotal(s);
    if (s.completed) b.cars += 1;
  });
  const points = Object.values(buckets).sort((a, b) => (a.key < b.key ? -1 : 1)).map((b) => ({ ...b, revenue: statRound(b.revenue) }));
  while (points.length && points[points.length - 1].key > today && !points[points.length - 1].revenue && !points[points.length - 1].cars) points.pop();
  return { unit, points };
}

app.get("/api/owner/statistics", requireOwner, (req, res) => {
  const db = loadDB();
  const today = ymdOf(new Date().toISOString());
  const period = req.query.period || "month";
  const q = { ...req.query, period };
  if (["day", "week", "payperiod", "year"].includes(period)) q.date = q.date || today;
  if (period === "month") q.month = q.month || today.slice(0, 7);
  if (period === "custom") { q.startDate = q.startDate || today; q.endDate = q.endDate || q.startDate; }

  const allDays = revenueEligible(db.sales, db).map((s) => ymdOf(s.date)).sort();
  let start, end, firstDay, lastDay;
  if (period === "all") {
    start = "0000-01-01T00:00:00.000Z"; end = "9999-12-31T23:59:59.999Z";
    firstDay = allDays[0] || today; lastDay = allDays.length && allDays[allDays.length - 1] > today ? allDays[allDays.length - 1] : today;
  } else {
    ({ start, end } = dateRangeFor(q));
    firstDay = ymdOf(start); lastDay = ymdOf(end);
  }
  const inP = (iso) => inRange(iso, start, end);
  const sales = revenueEligible(db.sales.filter((s) => inP(s.date)), db);
  const paid = sales.filter((s) => s.paid);
  const head = statsHeadline(db, start, end);
  const pq = previousStatsQuery(q, today);
  const previous = pq ? (({ start: ps, end: pe }) => statsHeadline(db, ps, pe))(dateRangeFor(pq)) : null;

  const completed = sales.filter((s) => s.completed);
  const closed = db.sales.filter((s) => s.status !== "cancelled" && !s.isReschedule && !redoFree(s) && afterRevenueStart(s, db) && inP(s.closedAt || s.date));
  const headline = head;

  const groupBy = (list, keyFn) => { const m = {}; list.forEach((x) => { const k = keyFn(x); (m[k] = m[k] || []).push(x); }); return m; };
  const byService = Object.entries(groupBy(sales, (s) => (s.baseService || "").trim() || "(not set)")).map(([service, list]) => {
    const p = list.filter((s) => s.paid), rev = statSum(p, saleTotal);
    return { service, jobs: list.length, paidJobs: p.length, revenue: statRound(rev), avgTicket: statRound(p.length ? rev / p.length : 0), share: head.revenue ? (rev / head.revenue) * 100 : 0 };
  }).sort((a, b) => b.revenue - a.revenue || b.jobs - a.jobs);

  const bySalesRep = db.salesReps.map((rep) => {
    const repClosed = closed.filter((s) => s.salesRepId === rep.id);
    const mine = sales.filter((s) => s.salesRepId === rep.id && !redoFree(s));
    const showed = mine.filter((s) => s.status === "arrived");
    const noShows = mine.filter((s) => s.status === "no_show").length;
    return {
      name: rep.name, dealsClosed: repClosed.length, dealValue: statRound(statSum(repClosed, (s) => parseFloat(s.basePrice) || 0)),
      showed: showed.length, noShows, showRate: showed.length + noShows ? (showed.length / (showed.length + noShows)) * 100 : null,
      commission: statRound(statSum(showed, (s) => salesRepCommissionForSale(rep, s).amount)),
    };
  }).filter((r) => r.dealsClosed || r.showed || r.noShows).sort((a, b) => b.dealValue - a.dealValue || b.dealsClosed - a.dealsClosed);

  const upsellsOn = (key, id) => paid.flatMap((s) => (s.upsells || []).filter((u) => u[key] === id));
  const people = [
    ...db.employees.map((e) => ({ name: e.name, role: "Tech", cars: completed.filter((s) => saleEmployeeIds(s).includes(e.id)).length, list: upsellsOn("employeeId", e.id) })),
    ...db.managers.map((m) => ({ name: m.name, role: "Manager", cars: completed.filter((s) => (s.managerHelperIds || []).includes(m.id)).length, list: upsellsOn("managerId", m.id) })),
  ].map((p) => ({ name: p.name, role: p.role, carsCompleted: p.cars, upsells: p.list.length, upsellRevenue: statRound(statSum(p.list, (u) => parseFloat(u.price) || 0)) }))
    .filter((p) => p.carsCompleted || p.upsells).sort((a, b) => b.upsellRevenue - a.upsellRevenue || b.carsCompleted - a.carsCompleted);

  // Day of week: totals, plus the AVERAGE per that weekday so a period with five Saturdays and four
  // Sundays doesn't make Saturday look busier than it is.
  const occurrences = Object.fromEntries(WEEKDAYS_MON_FIRST.map((d) => [d, 0]));
  for (let d = firstDay; d <= (lastDay < today ? lastDay : today); d = shiftYmd(d, 1)) occurrences[WEEKDAYS_MON_FIRST[(new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7]] += 1;
  const dow = Object.fromEntries(WEEKDAYS_MON_FIRST.map((d) => [d, { day: d, jobs: 0, revenue: 0, cars: 0 }]));
  const hours = {};
  sales.forEach((s) => {
    const { weekday, hour } = easternWeekdayHour(s.date);
    dow[weekday].jobs += 1;
    if (s.paid) dow[weekday].revenue += saleTotal(s);
    if (s.completed) dow[weekday].cars += 1;
    hours[hour] = (hours[hour] || 0) + 1;
  });
  const byDayOfWeek = WEEKDAYS_MON_FIRST.map((d) => ({ ...dow[d], revenue: statRound(dow[d].revenue), occurrences: occurrences[d], avgRevenue: statRound(occurrences[d] ? dow[d].revenue / occurrences[d] : 0) }));
  const byHour = Object.entries(hours).map(([hour, jobs]) => ({ hour: Number(hour), jobs })).sort((a, b) => a.hour - b.hour);

  const paymentMix = Object.entries(groupBy(paid, (s) => s.paymentMethod || "unknown")).map(([method, list]) => ({ method, jobs: list.length, revenue: statRound(statSum(list, saleTotal)) })).sort((a, b) => b.revenue - a.revenue);

  const upsellGroups = {};
  paid.forEach((s) => (s.upsells || []).forEach((u) => {
    const key = String(u.name || "").trim().toLowerCase();
    if (!key) return;
    const g = (upsellGroups[key] = upsellGroups[key] || { name: String(u.name).trim(), count: 0, revenue: 0 });
    g.count += 1; g.revenue += parseFloat(u.price) || 0;
  }));
  const topUpsells = Object.values(upsellGroups).map((g) => ({ ...g, revenue: statRound(g.revenue) })).sort((a, b) => b.revenue - a.revenue || b.count - a.count).slice(0, 10);

  // New vs returning: a job is a returning customer's if that same customer had an earlier job.
  const custKey = (s) => s.contactId || String(s.customerPhone || "").replace(/\D/g, "") || String(s.customerName || "").trim().toLowerCase();
  const history = {};
  db.sales.filter((s) => s.status !== "cancelled").forEach((s) => { const k = custKey(s); if (k) (history[k] = history[k] || []).push(s.date); });
  const withKey = sales.filter((s) => custKey(s));
  const returningJobs = withKey.filter((s) => history[custKey(s)].some((d) => d < s.date)).length;
  const customers = {
    jobs: withKey.length, returningJobs, newJobs: withKey.length - returningJobs,
    returningPercent: withKey.length ? (returningJobs / withKey.length) * 100 : 0,
    allTimeCustomers: Object.keys(history).length, allTimeRepeatCustomers: Object.values(history).filter((d) => d.length >= 2).length,
  };

  const leads = sales.filter((s) => s.closedAt && s.date).map((s) => daysBetweenYmd(ymdOf(s.closedAt), ymdOf(s.date))).filter((n) => n >= 0);
  const leadTime = { sampled: leads.length, avgDays: leads.length ? statSum(leads, (n) => n) / leads.length : 0, sameDayPercent: leads.length ? (leads.filter((n) => n === 0).length / leads.length) * 100 : 0 };

  const cashRows = db.cashEntries.filter((e) => inP(e.timestamp));
  const expenseRows = cashRows.filter((e) => e.type === "cashOut" || e.type === "cardExpense");
  const expensesByCategory = Object.entries(groupBy(expenseRows, (e) => e.category || "Other")).map(([category, list]) => ({ category, total: statRound(statSum(list, (e) => e.amount || 0)), entries: list.length })).sort((a, b) => b.total - a.total);
  const expensesTotal = statRound(statSum(expenseRows, (e) => e.amount || 0));
  const cash = {
    customerCashLogged: statRound(statSum(cashRows.filter((e) => e.type === "cashIn" && e.category === "Customer Payment"), (e) => e.amount || 0)),
    expensesTotal, expensesByCategory, collectedMinusExpenses: statRound(head.revenue - expensesTotal),
  };

  res.json({
    period: { key: period, start: firstDay, end: lastDay }, cutoff: db.revenueStartDate || null,
    headline, previous, trend: statsTrend(db, firstDay, lastDay, today), records: statsRecords(db, today),
    byService, bySalesRep, people, byDayOfWeek, byHour, paymentMix, topUpsells, customers, leadTime, cash,
  });
});

const server = app.listen(PORT, () => {
  console.log(`SBN Autostyling Tracker running on port ${PORT}`);
  // First backup shortly after boot (so you don't wait an hour to confirm it's working),
  // then every hour after that — no manual clicking required.
  setTimeout(runCloudBackup, 15 * 1000);
  setInterval(runCloudBackup, 60 * 60 * 1000);
  // Same idea for title sync — GHL never tells us when a title gets edited, so this asks
  // directly, on its own, every 30 minutes, no manual click required.
  setTimeout(runTitleSync, 30 * 1000);
  setInterval(runTitleSync, 30 * 60 * 1000);
  // Jobs already in the tracker pick up the price their title carries right away (open, unlocked jobs only; paid and completed
  // jobs keep their price, and are listed in Cleanup if the title disagrees).
  try { const db = loadDB(); const a = backfillTitlePricing(db), b = autoFlagRescheduleFromTitle(db); if (a + b > 0) saveDB(db); } catch (e) { console.error("title price / reschedule backfill failed:", e.message); }
});
// A walk-around video can take a while to upload on a slow shop wifi or mobile connection —
// Node's default request timeout is too tight for that, so this gives uploads real room.
server.requestTimeout = 10 * 60 * 1000; // 10 minutes
server.headersTimeout = 10 * 60 * 1000 + 1000;
