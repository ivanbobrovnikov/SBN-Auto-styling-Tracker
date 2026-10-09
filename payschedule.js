// The pay schedule for TECHS AND MANAGERS (sales reps are not part of this and keep their own cycle).
//   - Before Thu Oct 8, 2026: the old Wednesday-to-Tuesday cycle (kept only so past payroll can still be looked at; it can't be "run").
//   - Transition: Thu Oct 8 - Mon Oct 12 (4 work days), then Tue Oct 13 - Wed Oct 21 (8 work days), so pay moves to being in arrears
//     (hours already worked) without leaving anyone waiting three weeks for a check.
//   - From Thu Oct 22: regular two-week Thursday-to-Wednesday periods, forever. Payroll goes in the Tuesday after a period ends and
//     pays the Thursday 8 days after it ends; Thanksgiving week is the one exception noted below.
// Sundays are closed, so a regular period has 12 work days; the tracker's salary math (salary per period / 12 per day) relies on that.
const add = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (ymd) => new Date(ymd + "T12:00:00Z").getUTCDay();
const workDays = (start, end) => { let n = 0; for (let d = start; d <= end; d = add(d, 1)) if (dow(d) !== 0) n += 1; return n; };

const OLD_CYCLE_ANCHOR_END = "2026-08-25";   // a Tuesday; the old periods ended every 14 days from here
const OLD_CYCLE_LAST_END = "2026-10-06";
const TRANSITION = [
  { start: "2026-10-08", end: "2026-10-12", submit: "2026-10-13", paid: "2026-10-15" },
  { start: "2026-10-13", end: "2026-10-21", submit: "2026-10-27", paid: "2026-10-29" },
];
const REGULAR_FIRST_START = "2026-10-22";
const PAYDAY_OVERRIDES = { "2026-11-18": { submit: "2026-11-23", paid: "2026-11-25", note: "Thanksgiving week" } };
const HISTORY_FROM = "2025-01-01";
const THROUGH = "2030-12-31";
const FIRST_TRUE_UP = { start: "2026-10-01", end: "2026-10-07", paidOn: "2026-10-08" };   // the check paid before this schedule began

function build() {
  const out = [];
  // old cycle, oldest first
  let ends = [];
  for (let e = OLD_CYCLE_ANCHOR_END; e >= add(HISTORY_FROM, 13); e = add(e, -14)) ends.push(e);
  for (let e = add(OLD_CYCLE_ANCHOR_END, 14); e <= OLD_CYCLE_LAST_END; e = add(e, 14)) ends.push(e);
  ends.sort().forEach((end) => out.push({ start: add(end, -13), end, kind: "old", name: "Old Wed–Tue cycle", workDays: workDays(add(end, -13), end) }));
  TRANSITION.forEach((t) => out.push({ ...t, kind: "transition", workDays: workDays(t.start, t.end), name: `${workDays(t.start, t.end)}-day transition pay` }));
  for (let s = REGULAR_FIRST_START; s <= THROUGH; s = add(s, 14)) {
    const end = add(s, 13), o = PAYDAY_OVERRIDES[end];
    const paid = o ? o.paid : add(end, 8);
    out.push({ start: s, end, kind: "regular", workDays: workDays(s, end), name: "Regular 2-week pay", submit: o ? o.submit : add(paid, -2), paid, ...(o ? { note: o.note } : {}) });
  }
  out.forEach((p) => { p.id = `${p.start}_${p.end}`; });
  return out;
}
const ALL = build();
const periods = () => ALL.map((p) => ({ ...p }));
const periodContaining = (ymd) => ALL.find((p) => p.start <= ymd && ymd <= p.end) || null;
const periodByRange = (start, end) => ALL.find((p) => p.start === start && p.end === end) || null;
const isRunnableKind = (p) => p.kind === "transition" || p.kind === "regular";
module.exports = { periods, periodContaining, periodByRange, isRunnableKind, workDays, add, dow, FIRST_TRUE_UP };
