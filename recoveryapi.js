// Bringing back someone who was removed. Removing a person no longer destroys them: their whole record (PIN, pay settings, initials, everything) is kept in a "removed people" list, and the owner can
// bring them back. For people removed before that existed, the owner can search the shop's own cloud backups (the hourly copy and the one-per-day snapshots) and bring someone back from there.
// A restored person keeps the SAME id, so every job, attendance day, tip and upsell that pointed at them points at them again. Owner only.
module.exports = function registerRecoveryRoutes(app, { loadDB, saveDB, requireOwner, newId, hash, cleanStaffInitials, staffTags, backup }) {
  const ARR = { employee: "employees", manager: "managers", salesrep: "salesReps" }, LABEL = { employee: "Employee", manager: "Manager", salesrep: "Sales rep" };
  const API = () => process.env.GITHUB_API_BASE || "https://api.github.com";
  const bad = (res, msg, code, extra) => res.status(code || 400).json({ error: msg, ...(extra || {}) });
  const everyone = (db) => [...db.employees, ...db.managers, ...db.salesReps];
  const present = (db, id) => everyone(db).some((p) => p.id === id);
  const pinTaken = (db, h) => !!h && ((db.ownerPinHash && db.ownerPinHash === h) || everyone(db).some((p) => p.pinHash === h));
  const cleanRecord = (r) => { const out = {}; for (const [k, v] of Object.entries(r || {})) { if (v === null || ["string", "number", "boolean"].includes(typeof v) || (Array.isArray(v) && v.every((x) => ["string", "number", "boolean"].includes(typeof x)))) out[k] = v; } return out; };
  const shape = (p, type, extra) => ({ type, role: LABEL[type], id: p.id, name: p.name, payType: p.payType || null, ...(extra || {}) });

  // Put a record back. Everything that could clash (the PIN, the initials) is checked first, and if it does clash the owner is asked for a new one rather than the restore being refused outright.
  function restore(db, type, record, opts, source) {
    const rec = cleanRecord(record), arr = ARR[type];
    if (!arr) return { status: 400, error: "That isn't a kind of person I can bring back." };
    if (typeof rec.id !== "string" || !rec.id || typeof rec.name !== "string" || !rec.name.trim() || typeof rec.pinHash !== "string" || rec.pinHash.length < 8) return { status: 400, error: "That record is missing something it needs (a name, an id or a PIN), so it can't be brought back safely." };
    if (JSON.stringify(rec).length > 6000) return { status: 400, error: "That record is oddly large, so it wasn't restored." };
    if (present(db, rec.id)) return { status: 409, error: `${rec.name} is already back on the list.` };
    let pinChanged = false;
    if (pinTaken(db, rec.pinHash)) {
      const np = opts.newPin === undefined || opts.newPin === "" ? null : String(opts.newPin);
      if (np === null) return { status: 409, needsNewPin: true, error: `Someone else now uses ${rec.name}'s old PIN. Pick a new PIN for them (4 to 12 digits).` };
      if (!/^\d{4,12}$/.test(np)) return { status: 400, needsNewPin: true, error: "The PIN has to be 4 to 12 digits." };
      if (pinTaken(db, hash(np))) return { status: 409, needsNewPin: true, error: "Somebody already uses that PIN. Pick a different one." };
      rec.pinHash = hash(np); pinChanged = true;
    } else if (opts.newPin) { const np = String(opts.newPin); if (!/^\d{4,12}$/.test(np)) return { status: 400, needsNewPin: true, error: "The PIN has to be 4 to 12 digits." }; if (pinTaken(db, hash(np))) return { status: 409, needsNewPin: true, error: "Somebody already uses that PIN. Pick a different one." }; rec.pinHash = hash(np); pinChanged = true; }
    let initialsChanged = false;
    const wanted = opts.initials !== undefined ? String(opts.initials).trim().toUpperCase() : String(rec.initials || "").trim().toUpperCase();
    if (wanted) {
      const clash = type === "salesrep" ? (db.salesReps.some((r) => String(r.initials || "").toUpperCase() === wanted) ? `${wanted} is another sales rep's initials.` : ([...db.managers, ...db.employees].find((x) => staffTags(x).includes(wanted)) ? `${[...db.managers, ...db.employees].find((x) => staffTags(x).includes(wanted)).name} now answers to ${wanted}.` : null)) : (cleanStaffInitials(db, wanted, rec.id).error || null);
      if (clash) return { status: 409, needsInitials: true, error: `${clash} Pick different initials for ${rec.name}, or leave them blank.` };
    }
    if (opts.initials !== undefined) { rec.initials = wanted; initialsChanged = wanted !== String(record.initials || "").toUpperCase(); }
    db[arr].push(rec);
    db.removedPeople = (db.removedPeople || []).filter((r) => r.id !== rec.id);
    if (!db.auditLog) db.auditLog = [];
    db.auditLog.unshift({ id: newId(), timestamp: new Date().toISOString(), actor: "Owner", saleId: null, car: rec.name, field: `${LABEL[type]} brought back (${source})`, oldValue: "removed", newValue: rec.name });
    db.auditLog = db.auditLog.slice(0, 1000);
    return { ok: true, person: shape(rec, type), pinChanged, initialsChanged };
  }

  // ---- reading the shop's own cloud backups ----
  async function gh(path, raw) {
    const cfg = backup(); if (!cfg.token || !cfg.repo) throw new Error("not-configured");
    const r = await fetch(`${API()}/repos/${cfg.repo}/contents/${path}`, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "User-Agent": "sbn-tracker" }, signal: AbortSignal.timeout(40000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    return raw ? r.text() : r.json();
  }
  async function sources() {
    const list = await gh("backups/snapshots", false);
    const days = Array.isArray(list) ? list.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f.name)).map((f) => f.name).sort().reverse() : [];
    return ["latest.json", ...days];
  }
  const label = (name) => (name === "latest.json" ? "the latest hourly backup" : `the backup of ${name.replace(".json", "")}`);
  async function load(name) { const txt = await gh(name === "latest.json" ? "backups/latest.json" : `backups/snapshots/${name}`, true); if (txt == null) return null; return JSON.parse(txt); }

  app.get("/api/owner/removed-people", requireOwner, (req, res) => {
    const db = loadDB(), cfg = backup();
    res.json({ removed: (db.removedPeople || []).filter((r) => !present(db, r.id)).map((r) => shape(r, r.type, { key: r.key, removedAt: r.removedAt, removedBy: r.removedBy })), backup: { configured: !!(cfg.token && cfg.repo), last: cfg.last ? cfg.last() : null } });
  });
  app.post("/api/owner/removed-people/search-backups", requireOwner, async (req, res) => {
    const cfg = backup(); if (!(cfg.token && cfg.repo)) return res.json({ configured: false, found: [], checked: [] });
    const skip = Math.max(0, parseInt((req.body || {}).skip, 10) || 0), count = Math.min(10, Math.max(1, parseInt((req.body || {}).count, 10) || 6));
    try {
      const all = await sources(), slice = all.slice(skip, skip + count), db = loadDB(), removedIds = new Set((db.removedPeople || []).map((r) => r.id)), found = new Map(), checked = [];
      for (const name of slice) {
        let snap; try { snap = await load(name); } catch (e) { checked.push({ name, ok: false }); continue; }
        if (!snap) { checked.push({ name, ok: false }); continue; }
        checked.push({ name, ok: true, label: label(name) });
        for (const type of Object.keys(ARR)) for (const p of (Array.isArray(snap[ARR[type]]) ? snap[ARR[type]] : [])) { if (!p || typeof p.id !== "string" || present(db, p.id) || removedIds.has(p.id) || found.has(p.id)) continue; found.set(p.id, { ...shape(p, type), source: name, seenIn: label(name) }); }
      }
      res.json({ configured: true, found: [...found.values()], checked, nextSkip: skip + slice.length, more: skip + slice.length < all.length, totalBackups: all.length });
    } catch (e) { res.status(502).json({ error: e.message === "not-configured" ? "The cloud backup isn't set up on this shop." : `Couldn't read the backups right now (${e.message}). Try again in a minute.` }); }
  });
  app.post("/api/owner/recover-person", requireOwner, async (req, res) => {
    const b = req.body || {}, db = loadDB();
    try {
      let type = b.type, record = null, source = "removed list";
      if (b.source === "removed") { const r = (db.removedPeople || []).find((x) => x.id === b.id); if (!r) return bad(res, "That person isn't on the removed list.", 404); type = r.type; record = r.record; }
      else if (typeof b.source === "string" && /^(latest|\d{4}-\d{2}-\d{2})\.json$/.test(b.source)) {
        const cfg = backup(); if (!(cfg.token && cfg.repo)) return bad(res, "The cloud backup isn't set up on this shop.", 400);
        const snap = await load(b.source); if (!snap) return bad(res, "That backup couldn't be found.", 404);
        record = (Array.isArray(snap[ARR[type]]) ? snap[ARR[type]] : []).find((p) => p && p.id === b.id); if (!record) return bad(res, "That person isn't in that backup.", 404); source = label(b.source);
      } else return bad(res, "Say where to bring them back from.", 400);
      const out = restore(db, type, record, { newPin: b.newPin, initials: b.initials }, source);
      if (!out.ok) return bad(res, out.error, out.status, { needsNewPin: !!out.needsNewPin, needsInitials: !!out.needsInitials });
      saveDB(db); res.json(out);
    } catch (e) { res.status(502).json({ error: `Couldn't read the backup right now (${e.message}). Nothing was changed.` }); }
  });
};
