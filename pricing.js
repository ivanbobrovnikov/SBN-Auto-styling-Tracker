// Reads the price and the deposit a team member typed at the end of an appointment title.
// The standard line-up is: initials, car, service, then the total price minus any deposit that was paid:
//     "JA 2019 Infiniti QX50 S+R+WS+Sunroof $644-$50"   ->  total $644, deposit $50, balance due $594
// It also copes with the other ways people actually write it: "$249 - $50depo", "$125 - $50 depo", "499-95depo",
// "$1,250-$200", "$644.50-$50", "$644 minus $50", and a price on its own ("$300"). It looks for the price the way it is
// usually written (at the end, with $ signs or a "depo"), and ignores other numbers in a title like the year, "Model 3",
// "F150" or "35 front 20 rear". When it can't be sure it returns null rather than guess.
// Notes people add after a price about the visit itself ("$580 drop off night before", "... 2pm", "same day"). Never a price.
const VISIT_NOTE = "drop[- ]?off|pick[- ]?up|walk[- ]?in|same[- ]?day|s[- ]?day|resched\\w*|waiting|wait|appt|appointment|tomorrow|today|\\d{1,2}(?::\\d\\d)?\\s*(?:am|pm)\\b|@";
const NUM = "\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?";
const toNumber = (s) => parseFloat(String(s).replace(/,/g, ""));
const round2 = (n) => Math.round(n * 100) / 100;

function parseTitlePricing(title) {
  let t = String(title || "");
  if (!t.trim()) return null;
  // The dollar sign can come AFTER the number too ("299$-50$ depo", "499$ plus wheels 100$ 599$ -95$ depo"). Turn that into the usual
  // "$299-$50 depo" so one set of rules reads both.
  //  - A "$" counts as the number's own TRAILING dollar sign only when it is NOT the "$" that starts the next number. In "front 2 $200" or
  //    "Model 3 $279" the "$" belongs to the 200 / 279, so the lone 2 or 3 must be left alone (gluing them would make $2,200 or $3,279).
  //  - "$299$" (a dollar sign on both sides, nothing between) is one price; but "100$ 599$" is two prices, each with its own trailing dollar.
  //  - A number is only changed when nothing letter-like sits right in front of it, so "F150$" or "Model3$" never becomes a price.
  t = t.replace(/(\$\d[\d,]*(?:\.\d{1,2})?)\$/g, "$1");                                   // "$299$" -> "$299" (tight only)
  t = t.replace(/(^|[^\w$.,])(\d[\d,]*(?:\.\d{1,2})?)[ \t]*\$(?!\d)/g, "$1$$$2");         // "299$"  -> "$299" (not when that "$" starts the next number)
  // "$299 balance $249" / "299 - bal 249" / "$299 due $249": the amount before the word is the price and the amount after it is what is still OWED, so the deposit is the difference. It must never be read as a price.
  const owed = new RegExp(`\\$?\\s*(${NUM})\\s*[-,]?\\s*(?:balance|bal|due|owed|remaining|left)\\s*(?:is|:|=|-)?\\s*\\$?\\s*(${NUM})`, "i").exec(t);
  if (owed) { const total = toNumber(owed[1]), bal = toNumber(owed[2]); return total >= 10 && total <= 250000 && bal >= 0 && bal <= total ? { total: round2(total), deposit: round2(total - bal), balance: round2(bal) } : null; }
  const found = [];
  // "$644-$50", "$249 - $50depo", "$644 - 50", "$644 minus $50"
  const dollarPair = new RegExp(`\\$\\s*(${NUM})\\s*(?:-|–|—|minus)\\s*\\$?\\s*(${NUM})`, "gi");
  for (let m = dollarPair.exec(t); m; m = dollarPair.exec(t)) found.push({ index: m.index, total: toNumber(m[1]), deposit: toNumber(m[2]) });
  // "499-95depo" / "499 - 95 deposit" (no dollar signs, but the word gives it away)
  const bareDepo = new RegExp(`(^|[^\\w$.,])(${NUM})\\s*(?:-|–|—)\\s*(${NUM})\\s*depo(?:sit)?\\b`, "gi");
  for (let m = bareDepo.exec(t); m; m = bareDepo.exec(t)) found.push({ index: m.index + m[1].length, total: toNumber(m[2]), deposit: toNumber(m[3]) });
  if (found.length > 0) {
    const last = found.sort((a, b) => a.index - b.index)[found.length - 1]; // the one nearest the end of the title
    // A deposit bigger than the price means the numbers aren't what we think (or are the wrong way round): don't guess.
    if (!(last.total >= 10 && last.total <= 250000 && last.deposit >= 0 && last.deposit <= last.total)) return null;
    return { total: round2(last.total), deposit: round2(last.deposit), balance: round2(last.total - last.deposit) };
  }
  // The price near the front and the deposit stated separately later in the title, as in
  //   "MR 2026 Tesla Y Performance - $279 - Sides and Rear (+Free Sunstrip Promotions) -$50Depo"
  // A deposit is only believed when it is spelled out as one ("$50Depo", "50 depo", "$50 deposit", "deposit $50"), and the total is the
  // first dollar amount in the title that isn't the deposit itself or an add-on written like "(+$20 ...)".
  const deposits = [];
  const depoAfter = new RegExp(`(^|[^\\w$.,])\\$?\\s*(${NUM})\\s*depo(?:sit)?\\b`, "gi");
  for (let m = depoAfter.exec(t); m; m = depoAfter.exec(t)) deposits.push({ start: m.index + m[1].length, end: m.index + m[0].length, value: toNumber(m[2]) });
  const depoBefore = new RegExp(`depo(?:sit)?\\s*:?\\s*\\$?\\s*(${NUM})`, "gi");
  for (let m = depoBefore.exec(t); m; m = depoBefore.exec(t)) deposits.push({ start: m.index, end: m.index + m[0].length, value: toNumber(m[1]) });
  if (deposits.length > 0) {
    const dep = deposits.sort((a, b) => a.start - b.start)[deposits.length - 1];
    const amounts = [];
    const dollars = new RegExp(`\\$\\s*(${NUM})`, "g");
    for (let m = dollars.exec(t); m; m = dollars.exec(t)) {
      if (deposits.some((d) => m.index >= d.start && m.index < d.end)) continue;       // that's the deposit itself
      if (/\+\s*$/.test(t.slice(0, m.index))) continue;                                  // "(+$20 sunstrip)" is an add-on, not the price
      amounts.push(toNumber(m[1]));
    }
    if (amounts.length === 0) return looseTotal(t, dep.value);   // no dollar signs on the price at all: "299 - $50depo"
    const total = pickTotal(amounts);
    if (!(total >= 10 && total <= 250000 && dep.value >= 0 && dep.value <= total)) return null;
    return { total: round2(total), deposit: round2(dep.value), balance: round2(total - dep.value) };
  }
  // "no depo" / "no deposit" says there is NO deposit: that is a clear zero, not an unknown amount. The price is then the first dollar amount in
  // the title that isn't an add-on written like "(+$20 ...)": "MR gray 2022 bmw x4 front plus sun 179$ same day no depo" is $179 with nothing down.
  if (/\bno\s*-?\s*depo(?:sit)?\b/i.test(t)) {
    const dollarsNo = new RegExp(`\\$\\s*(${NUM})`, "g");
    for (let m = dollarsNo.exec(t); m; m = dollarsNo.exec(t)) {
      if (/\+\s*$/.test(t.slice(0, m.index))) continue;
      const total = toNumber(m[1]);
      return total >= 10 && total <= 250000 ? { total: round2(total), deposit: 0, balance: round2(total) } : null;
    }
  }
  // A price that sits alone between dashes, with no deposit mentioned: "MR 2026 Tesla Y Performance - $279 - Sides and Rear".
  // Standing on its own as a dash-separated piece is what makes it safe to believe; "$50 off" or "+ $50 sunstrip" never look like that.
  const segment = new RegExp(`(?:^|\\s)[-–—]\\s*\\$\\s*(${NUM})\\s*[-–—](?=\\s|$)`, "g");
  const seg = /depo/i.test(t) ? null : segment.exec(t); // the word "depo" with no amount means a deposit exists but we can't tell how much: say nothing
  if (seg) {
    const total = toNumber(seg[1]);
    if (total >= 10 && total <= 250000) return { total: round2(total), deposit: 0, balance: round2(total) };
    return null;
  }
  // A price on its own at the very end: "... Sides $300"; or the only dollar amount followed by a note about the visit: "... $580 drop off night before", "... $1499 2pm", "... $299 same day".
  const lone = (t.match(new RegExp(`\\$\\s*(?:${NUM})`, "g")) || []).length === 1;
  const single = t.match(new RegExp(`\\$\\s*(${NUM})\\s*\\.?\\s*$`)) || (lone ? t.match(new RegExp(`\\$\\s*(${NUM})\\s*\\.?\\s+(?:${VISIT_NOTE})\\b.*$`, "i")) : null);
  if (single) {
    const total = toNumber(single[1]);
    if (total >= 10 && total <= 250000) return { total: round2(total), deposit: 0, balance: round2(total) };
    return null;
  }
  // Bare numbers at the very end with nothing else to go on: "... Sunroof 644-50". Only when it clearly looks like a price
  // minus a smaller deposit, so a year range or a film percentage is never mistaken for one.
  const bareEnd = t.match(new RegExp(`(^|[^\\w$.,-])(${NUM})\\s*(?:-|–|—)\\s*(${NUM})\\s*$`));
  if (bareEnd) {
    const total = toNumber(bareEnd[2]), deposit = toNumber(bareEnd[3]);
    if (total >= 100 && total <= 250000 && deposit >= 0 && deposit < total && !(total >= 1900 && total <= 2100 && deposit >= 1900)) {
      return { total: round2(total), deposit: round2(deposit), balance: round2(total - deposit) };
    }
  }
  return looseTotal(t);
}


// ---- Prices written without a dollar sign, and totals written as several prices ----------------------------------------------------------------
// Used ONLY when the strict rules above found nothing, so every title they read stays exactly as it was. The new formats:
//   "S+R 299", "- 299 -", "299 - $50depo", "424/50 depo", "424 50depo", "Coating 499 + Tint 499 = 998", "coating 499 tint 499 total 998"
// When a title lists several prices, the last number is the TOTAL if it equals the sum of the ones before it. A bare number is only believed
// when it stands where a price stands (right after a service word, alone between dashes, right before the deposit, or as that sum): never a
// year, a percentage, a model name ("GLC 300", "Model 3", "F150"), a time, a date, or a size.
const SUM_EPS = 0.01;
function pickTotal(amounts) {
  if (amounts.length >= 3) { const last = amounts[amounts.length - 1]; for (let k = amounts.length - 1; k >= 2; k--) { const part = amounts.slice(amounts.length - 1 - k, amounts.length - 1).reduce((a, b) => a + b, 0); if (Math.abs(part - last) < SUM_EPS) return last; } }
  return amounts[0];
}
const looksLikeYear = (n) => Number.isInteger(n) && n >= 1980 && n <= 2039;
function looseTotal(t, knownDeposit) {
  // every bare number that could be a price, with where it sits; deposits (spelled out as one) are set aside first
  const spans = [];
  const depo = new RegExp(`(^|[^\\w$.,])\\$?\\s*(${NUM})\\s*dep(?:o|osit)?\\b`, "gi");
  for (let m = depo.exec(t); m; m = depo.exec(t)) spans.push({ start: m.index + m[1].length, end: m.index + m[0].length, value: toNumber(m[2]) });
  const depoWord = new RegExp(`dep(?:o|osit)?\\s*:?\\s*\\$?\\s*(${NUM})`, "gi");
  for (let m = depoWord.exec(t); m; m = depoWord.exec(t)) spans.push({ start: m.index, end: m.index + m[0].length, value: toNumber(m[1]) });
  const cands = [], tok = new RegExp(`(^|[^\\w$.,#/:])\\$?\\s*(${NUM})(?![\\w%.:]|\\/(?!\\s*\\$?\\d+(?:\\.\\d+)?\\s*dep))(?!\\s*(?:%|ft\\b|in\\b|inch|windows?|doors?|am\\b|pm\\b|x\\b))`, "gi");
  for (let m = tok.exec(t); m; m = tok.exec(t)) {
    const at = m.index + m[1].length, value = toNumber(m[2]);
    if (spans.some((d) => at >= d.start && at < d.end)) continue;                       // that's the deposit
    if (!(value >= 50 && value <= 250000) || looksLikeYear(value)) continue;            // too small or a year
    cands.push({ at, end: m.index + m[0].length, value });
  }
  if (cands.length === 0) return null;
  const dep = knownDeposit !== undefined ? knownDeposit : spans.length ? spans[spans.length - 1].value : 0;
  const ok = (total) => (total >= 50 && total <= 250000 && dep >= 0 && dep < total ? { total: round2(total), deposit: round2(dep), balance: round2(total - dep) } : null);
  // 1. the word "total" says it outright
  const tw = t.match(new RegExp(`\\btotal\\b\\s*[:=\\-]?\\s*\\$?\\s*(${NUM})`, "i")); if (tw) return ok(toNumber(tw[1]));
  // 2. several prices, and the last is their sum
  if (cands.length >= 3) { const vals = cands.map((c) => c.value), p = pickTotal(vals); if (p === vals[vals.length - 1] && p !== vals[0]) return ok(p); }
  // 3. a price standing right before the deposit: "299 - $50depo", "424/50 depo", "424 50depo"
  if (spans.length) { const first = spans.slice().sort((a, b) => a.start - b.start)[0], before = cands.filter((c) => c.end <= first.start && /^[\s\-\u2013\u2014\/,:]*$/.test(t.slice(c.end, first.start)) ); if (before.length) return ok(before[before.length - 1].value); }
  // 4. a price standing alone between dashes, or after the last dash at the end: "- 299 -", "- 275 - Walkin 2pm", "... - 299"
  const segs = cands.filter((c) => /(^|\s)[-\u2013\u2014]\s*$/.test(t.slice(0, c.at)) && /^\s*(?:[-\u2013\u2014](?:\s|$)|$)/.test(t.slice(c.end)));
  if (segs.length === 1) return ok(segs[0].value);
  if (segs.length > 1) return null;
  // 5. a price right after a service word at the end: "S+R 299", "Full Car 424", "Ceramic coating 899 walk in"
  const kw = t.match(new RegExp(`(?:S\\s*\\+\\s*R|W\\s*\\/?\\s*S|windshield|full\\s*car|front\\s*(?:2|two)|rear|sides?|sunroof|sun\\s*strip|visor|tint|coating|ceramic|ppf|removal|nano|film)(?:\\s*[-\\u2013\\u2014:=]*\\s*\\d{1,2}\\s*%)*(?:[A-Za-z&+/ ]{0,36}?)\\s*[-\\u2013\\u2014:=]*\\s*\\$?\\s*(${NUM})(?:\\s+(?:${VISIT_NOTE}|no\\s*depo(?:sit)?|redo)\\b.*)?\\s*$`, "i"));
  if (kw) {
    const v = toNumber(kw[1]), firstKw = t.search(/S\s*\+\s*R|W\s*\/?\s*S\b|windshield|full\s*car|front\s*(?:2|two)|rear|sides?\b|sunroof|sun\s*strip|visor|tint|coating|ceramic|ppf|removal|nano|film/i);
    const after = cands.filter((c) => c.at > firstKw);                    // only prices after the first service word count: "GLC 300 S+R 299" has one (299), "coating 499 tint 450" has two, so it stays unread
    if (after.length === 1 && after[0].value === v) return ok(v);
  }
  return null;
}

module.exports = { parseTitlePricing };
