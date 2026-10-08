// Reads the price and the deposit a team member typed at the end of an appointment title.
// The standard line-up is: initials, car, service, then the total price minus any deposit that was paid:
//     "JA 2019 Infiniti QX50 S+R+WS+Sunroof $644-$50"   ->  total $644, deposit $50, balance due $594
// It also copes with the other ways people actually write it: "$249 - $50depo", "$125 - $50 depo", "499-95depo",
// "$1,250-$200", "$644.50-$50", "$644 minus $50", and a price on its own ("$300"). It looks for the price the way it is
// usually written (at the end, with $ signs or a "depo"), and ignores other numbers in a title like the year, "Model 3",
// "F150" or "35 front 20 rear". When it can't be sure it returns null rather than guess.
const NUM = "\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?";
const toNumber = (s) => parseFloat(String(s).replace(/,/g, ""));
const round2 = (n) => Math.round(n * 100) / 100;

function parseTitlePricing(title) {
  const t = String(title || "");
  if (!t.trim()) return null;
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
    if (amounts.length === 0) return null;
    const total = amounts[0];
    if (!(total >= 10 && total <= 250000 && dep.value >= 0 && dep.value <= total)) return null;
    return { total: round2(total), deposit: round2(dep.value), balance: round2(total - dep.value) };
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
  // A price on its own at the very end: "... Sides $300"
  const single = t.match(new RegExp(`\\$\\s*(${NUM})\\s*\\.?\\s*$`));
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
  return null;
}

module.exports = { parseTitlePricing };
