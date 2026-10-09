// Does a title say the booking is a reschedule? The team types things like "RESCHEDULED", "Reschedule", "RESCH", "resched.",
// "re-scheduled", and (being human) "reschudle". Matching is on whole words, tolerant of one or two slips in spelling, and
// deliberately strict about everything else so ordinary words ("research", "reserved", "scheduled", "rescue") never match.
const TARGETS = ["reschedule", "rescheduled", "rescheduling"];
const ABBREVIATIONS = new Set(["resch", "resched", "reschd", "rsched", "reschedd"]);
function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}
function titleSaysReschedule(title) {
  const words = String(title || "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (ABBREVIATIONS.has(w)) return true;
    // "re schedule" / "re-scheduled": the prefix on its own, then a (possibly misspelled) schedule word
    if (w === "re" && i + 1 < words.length && (distance(words[i + 1], "schedule") <= 1 || distance(words[i + 1], "scheduled") <= 1)) return true;
    if (w.length >= 7 && w.length <= 13 && w[0] === "r" && TARGETS.some((t) => distance(w, t) <= 2)) return true;
  }
  return false;
}
// "REDO": the work is being done again at no charge. Whole word only: "redo", "re-do", "re do". Never part of a longer word ("Redondo",
// "credo", "tuxedo", "Toledo") and not other forms like "redone".
function titleSaysRedo(title) {
  const words = String(title || "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "redo") return true;
    if (words[i] === "re" && words[i + 1] === "do") return true;
  }
  return false;
}
module.exports = { titleSaysReschedule, titleSaysRedo };
