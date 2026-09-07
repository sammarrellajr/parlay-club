/* Shared config, data loading, and stats for the Parlay Club app. */

// Optional manual override. Leave blank to auto-detect from the GitHub Pages URL.
const CONFIG = {
  owner: "",
  repo: "",
  branch: "main",
  file: "results.json"
};

const DEFAULT_PLAYERS = ["Drew", "Pat", "Sam", "Tim", "Tyler"];

const LEAGUES = [
  { key: "cfb", label: "College", full: "College Football", dow: 6 }, // Saturday
  { key: "nfl", label: "NFL", full: "NFL", dow: 0 }                   // Sunday
];

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ---------- repo detection ---------- */

function detectRepo() {
  if (CONFIG.owner && CONFIG.repo) {
    return { owner: CONFIG.owner, repo: CONFIG.repo, branch: CONFIG.branch };
  }
  const m = (location.hostname || "").match(/^([^.]+)\.github\.io$/i);
  if (m) {
    const owner = m[1];
    const seg = location.pathname.split("/").filter(Boolean);
    const repo = seg.length && !seg[0].endsWith(".html") ? seg[0] : `${owner}.github.io`;
    return { owner, repo, branch: CONFIG.branch };
  }
  return null;
}

function repoSettings() {
  const saved = localStorage.getItem("pc_repo");
  if (saved) {
    try { return JSON.parse(saved); } catch (e) { /* fall through */ }
  }
  return detectRepo();
}

/* ---------- loading ---------- */

async function loadResults() {
  const bust = "?t=" + Date.now();
  const r = repoSettings();
  const urls = [];
  if (r) {
    urls.push(`https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.branch || "main"}/${CONFIG.file}${bust}`);
  }
  urls.push(CONFIG.file + bust);

  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) { lastErr = new Error(`${res.status} on ${url}`); continue; }
      return normalize(await res.json());
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Could not load results.json");
}

/* One entry = one date + one league. Older files stored a combined
   weekend holding both leagues, so those are split on read. */
function normalize(data) {
  const d = data && typeof data === "object" ? data : {};
  const players = Array.isArray(d.players) && d.players.length ? d.players : DEFAULT_PLAYERS.slice();

  let entries = [];
  if (Array.isArray(d.entries)) {
    entries = d.entries.map(cleanEntry).filter(Boolean);
  } else if (Array.isArray(d.weeks)) {
    d.weeks.forEach(w => {
      LEAGUES.forEach(lg => {
        const picks = {};
        let any = false;
        Object.keys(w.entries || {}).forEach(p => {
          const leg = (w.entries[p] || {})[lg.key] || {};
          if (leg.result || leg.pick) {
            picks[p] = { result: leg.result || null, pick: leg.pick || "" };
            if (leg.result) any = true;
          }
        });
        if (any) {
          const date = w.start || "";
          entries.push(cleanEntry({ id: date + "-" + lg.key, date, league: lg.key, picks }));
        }
      });
    });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // Derive labels for entries that carry none, numbering repeats on one date.
  const seen = {};
  entries.forEach(e => {
    const k = e.date + "-" + e.league;
    seen[k] = (seen[k] || 0) + 1;
    if (!e.label) {
      e.label = entryLabel(e.date, e.league) + (seen[k] > 1 ? " #" + seen[k] : "");
    }
  });

  return { players, season: d.season || "", entries };
}

function cleanEntry(e) {
  if (!e || typeof e !== "object") return null;
  const league = e.league === "nfl" ? "nfl" : "cfb";
  const date = e.date || "";
  const picks = {};
  Object.keys(e.picks || {}).forEach(p => {
    const v = e.picks[p] || {};
    picks[p] = {
      result: ["W", "L", "P"].includes(v.result) ? v.result : null,   // P = pending
      pick: v.pick || ""
    };
  });
  return {
    id: e.id || (date + "-" + league),
    date, league, picks,
    label: e.label || ""   // filled in by normalize so repeats get numbered
  };
}

/* "Sat 9/5 College" */
function entryLabel(iso, league) {
  const lg = league === "nfl" ? "NFL" : "College";
  if (!iso) return lg;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return lg;
  return `${DOW[new Date(y, m - 1, d).getDay()]} ${m}/${d} ${lg}`;
}

/* ---------- stats ---------- */

function blankRec() { return { w: 0, l: 0 }; }

function v_result(entry, player) {
  return (entry.picks[player] || {}).result || null;
}

/* Count of picks still waiting on a game. Omit the league to count both. */
function pendingCount(data, league) {
  let n = 0;
  data.entries.forEach(e => {
    if (league && e.league !== league) return;
    data.players.forEach(p => { if (v_result(e, p) === "P") n++; });
  });
  return n;
}

/* Records are kept three ways: college, NFL, and the two combined. */
function computeStats(data) {
  const per = {};
  data.players.forEach(p => {
    per[p] = { name: p, cfb: blankRec(), nfl: blankRec(), all: blankRec(),
               seq: { cfb: [], nfl: [], all: [] } };
  });

  const group = { cfb: blankRec(), nfl: blankRec(), all: blankRec() };
  const summaries = [];

  data.entries.forEach(e => {
    const s = { id: e.id, label: e.label, league: e.league, date: e.date, w: 0, l: 0, counted: 0, pending: 0, perfect: true };
    data.players.forEach(p => {
      const raw = v_result(e, p);
      // Pending and blank both sit out of the record and out of streaks.
      const res = raw === "W" || raw === "L" ? raw : null;
      per[p].seq[e.league].push(res);
      per[p].seq.all.push(res);          // entries are date-sorted, so this is chronological
      if (raw === "P") { s.pending += 1; s.perfect = false; return; }
      if (!res) { s.perfect = false; return; }
      const b = res === "W" ? "w" : "l";
      per[p][e.league][b] += 1;
      per[p].all[b] += 1;
      group[e.league][b] += 1;
      group.all[b] += 1;
      s[b] += 1;
      s.counted += 1;
      if (res === "L") s.perfect = false;
    });
    summaries.push(s);
  });

  /* A parlay cashes only when every leg wins, so the entry needs a settled
     result for all five and not one loss among them. */
  const parlays = { cfb: 0, nfl: 0, all: 0 };
  const settled = { cfb: 0, nfl: 0, all: 0 };
  summaries.forEach(s => {
    if (s.counted !== data.players.length) return;   // still pending or blank
    settled[s.league] += 1;
    settled.all += 1;
    if (s.perfect) { parlays[s.league] += 1; parlays.all += 1; }
  });

  const rows = data.players.map(p => {
    const s = per[p];
    return {
      ...s,
      cfbPct: pct(s.cfb),
      nflPct: pct(s.nfl),
      allPct: pct(s.all),
      streak: { cfb: winStreak(s.seq.cfb), nfl: winStreak(s.seq.nfl), all: winStreak(s.seq.all) }
    };
  });

  return {
    rows,
    byLeague: {
      cfb: rankBy(rows, "cfbPct", "cfb"),
      nfl: rankBy(rows, "nflPct", "nfl"),
      all: rankBy(rows, "allPct", "all")
    },
    leaders: {
      cfb: findLeaders(rows, "cfbPct", "cfb"),
      nfl: findLeaders(rows, "nflPct", "nfl"),
      all: findLeaders(rows, "allPct", "all")
    },
    group,
    groupPct: { cfb: pct(group.cfb), nfl: pct(group.nfl), all: pct(group.all) },
    summaries,
    parlays,
    settled,
    counts: {
      cfb: data.entries.filter(e => e.league === "cfb").length,
      nfl: data.entries.filter(e => e.league === "nfl").length,
      all: data.entries.length
    },
    pending: {
      cfb: pendingCount(data, "cfb"),
      nfl: pendingCount(data, "nfl"),
      all: pendingCount(data)
    }
  };
}

/* Consecutive wins ending at the most recent decided entry. Blank and pending
   weeks are skipped rather than treated as a loss, so an unsettled leg does
   not kill a run. */
function winStreak(seq) {
  let n = 0;
  for (let i = seq.length - 1; i >= 0; i--) {
    if (seq[i] === null) continue;
    if (seq[i] === "W") n++; else break;
  }
  return n;
}

function rankBy(rows, pctKey, recKey) {
  return rows.slice().sort((a, b) =>
    (b[pctKey] - a[pctKey]) ||
    (b[recKey].w - a[recKey].w) ||
    a.name.localeCompare(b.name));
}

/* Everyone tied at the best win percentage in that league. */
function findLeaders(rows, pctKey, recKey) {
  const played = rows.filter(r => r[recKey].w + r[recKey].l > 0);
  if (!played.length) return null;
  const best = played.reduce((m, r) => Math.max(m, r[pctKey]), -1);
  const tied = played.filter(r => r[pctKey] === best);
  const sameRec = tied.every(r => r[recKey].w === tied[0][recKey].w && r[recKey].l === tied[0][recKey].l);
  return { names: tied.map(r => r.name), pct: best, rec: sameRec ? tied[0][recKey] : null };
}

/* "Drew" / "Drew & Sam" / "3-way tie" */
function leaderLabel(ld) {
  if (!ld) return "--";
  if (ld.names.length === 1) return ld.names[0];
  if (ld.names.length === 2) return ld.names[0] + " & " + ld.names[1];
  return ld.names.length + "-way tie";
}

function leaderFoot(ld) {
  if (!ld) return "No results yet";
  const pctText = (ld.pct * 100).toFixed(1) + "%";
  const base = ld.rec ? fmtRec(ld.rec) + " (" + pctText + ")" : pctText;
  return ld.names.length > 2 ? base + ": " + ld.names.join(", ") : base;
}

function pct(rec) {
  const n = rec.w + rec.l;
  return n === 0 ? 0 : rec.w / n;
}

function fmtPct(v, rec) {
  if (rec && rec.w + rec.l === 0) return "--";
  return (v * 100).toFixed(1) + "%";
}

function fmtRec(rec) { return `${rec.w}-${rec.l}`; }

function pctClass(v, rec) {
  if (rec && rec.w + rec.l === 0) return "even";
  if (v > 0.5) return "good";
  if (v < 0.5) return "bad";
  return "even";
}

/* ---------- pick entry helpers ---------- */

/* Short names as they appear on a bet slip. */
const TEAMS = [
  // NFL
  "49ers","Bears","Bengals","Bills","Broncos","Browns","Buccaneers","Cardinals","Chargers",
  "Chiefs","Colts","Commanders","Cowboys","Dolphins","Eagles","Falcons","Giants","Jaguars",
  "Jets","Lions","Packers","Panthers","Patriots","Raiders","Rams","Ravens","Saints","Seahawks",
  "Steelers","Texans","Titans","Vikings",
  // College
  "Air Force","Alabama","App State","Arizona","Arizona State","Arkansas","Army","Auburn",
  "Baylor","Boise State","Boston College","BYU","California","Cincinnati","Clemson","Colorado",
  "Colorado State","Duke","East Carolina","Florida","Florida State","Fresno State","Georgia",
  "Georgia Tech","Houston","Illinois","Indiana","Iowa","Iowa State","James Madison","Kansas",
  "Kansas State","Kentucky","Liberty","Louisville","LSU","Marshall","Maryland","Memphis","Miami",
  "Michigan","Michigan State","Minnesota","Mississippi State","Missouri","Navy","NC State",
  "Nebraska","Nevada","New Mexico","North Carolina","Northwestern","Notre Dame","Ohio State",
  "Oklahoma","Oklahoma State","Ole Miss","Oregon","Oregon State","Penn State","Pittsburgh",
  "Purdue","Rutgers","San Diego State","San Jose State","SMU","South Carolina","South Florida",
  "Stanford","Syracuse","TCU","Temple","Tennessee","Texas","Texas A&M","Texas Tech","Toledo",
  "Tulane","UCF","UCLA","UNLV","USC","Utah","Utah State","UTSA","Vanderbilt","Virginia",
  "Virginia Tech","Wake Forest","Washington","Washington State","West Virginia","Western Kentucky",
  "Wisconsin","Wyoming",
  // common non-team openers
  "Over","Under"
];

/* Everything typed before, newest first, so repeats surface fast. */
function priorPicks(data) {
  const seen = new Set();
  const out = [];
  data.entries.slice().reverse().forEach(e => {
    data.players.forEach(p => {
      const t = ((e.picks[p] || {}).pick || "").trim();
      if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
    });
  });
  return out;
}

/* Prior picks first (whole strings), then team names. */
function suggestPicks(query, data, limit) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  const push = v => {
    if (v.toLowerCase() === q) return;                 // already typed exactly
    if (!hits.some(h => h.toLowerCase() === v.toLowerCase())) hits.push(v);
  };
  const starts = v => v.toLowerCase().startsWith(q);
  const has = v => v.toLowerCase().includes(q);

  const prior = data ? priorPicks(data) : [];
  prior.filter(starts).forEach(push);
  TEAMS.filter(starts).forEach(push);
  prior.filter(v => !starts(v) && has(v)).forEach(push);
  TEAMS.filter(v => !starts(v) && has(v)).forEach(push);
  return hits.slice(0, limit || 6);
}

/* Split a pasted slip into individual picks.
   Prefers line breaks; falls back to commas when it is all one line.

   Real slips interleave the picks with labels ("Spread"), odds ("-110"),
   and venue lines that arrive as a bare "@" followed by "Atlanta, GA".
   Rather than blacklist every variant, keep only lines that actually look
   like a pick: they contain letters, and they are not a label or a place. */
const PASTE_NOISE = /^(spread|total|totals|moneyline|money line|straight|parlay|same game parlay|sgp|parlay boost ineligible|boost applied.*|open|pending|live|won|win|lost|loss|push|void|cashed out|cash out|to win|to pay|wager|bet slip|\d+ pick parlay)$/i;

const VENUE_LINE = /^@?\s*([A-Za-z .'&-]+),\s*[A-Z]{2}\.?$/;   // "Atlanta, GA" or "@ Atlanta, GA"

/* A total ("Over 54.5") carries no team name. The slip usually prints the
   venue right after it, so borrow the city rather than discarding it. */
function venueCity(line) {
  const m = line.match(VENUE_LINE);
  return m ? m[1].trim() : "";
}

function parsePastedPicks(text) {
  if (!text) return [];
  let parts = text.split(/\r?\n/).map(t => t.trim()).filter(Boolean);
  if (parts.length < 2) parts = text.split(",").map(t => t.trim()).filter(Boolean);

  const out = [];
  parts.forEach(raw => {
    const t = cleanPickLine(raw);
    if (!t) return;
    if (t === "@") return;                       // venue marker on its own line

    const city = venueCity(t);
    if (city) {
      const last = out[out.length - 1];
      if (last && /^(over|under)\b/i.test(last) && !/\(/.test(last)) {
        out[out.length - 1] = last + " (" + city + ")";
      }
      return;
    }

    if (!/[a-z]/i.test(t)) return;               // "-110" and other bare numbers
    if (PASTE_NOISE.test(t)) return;
    out.push(t);
  });

  return out;
}

function cleanPickLine(t) {
  return t
    .replace(/^[•*]+\s*/, "")          // bullets
    .replace(/^\d+[.)]\s+/, "")             // "1." numbering
    .replace(/\s+/g, " ")
    .replace(/([+-])\s+(?=[\d.])/g, "$1")   // "Pittsburgh - 16.5" -> "Pittsburgh -16.5"
    .trim();
}

/* ---------- assigning picks to people ---------- */

/* The name part of a pick, with the numbers dropped: "Penn State -17" -> "penn state" */
function teamKey(text) {
  return String(text || "")
    .split(/\s+/)
    .filter(w => !/\d/.test(w))
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* Who usually takes this team? Returns null when there is no history for it. */
function guessPlayer(text, data) {
  if (!data) return null;
  const key = teamKey(text);
  if (!key) return null;
  const counts = {};
  data.entries.forEach(e => data.players.forEach(p => {
    const prior = (e.picks[p] || {}).pick;
    if (prior && teamKey(prior) === key) counts[p] = (counts[p] || 0) + 1;
  }));
  let best = null;
  Object.keys(counts).forEach(p => { if (!best || counts[p] > counts[best]) best = p; });
  return best;
}

/* History first, then roster order for whoever is left. One pick per person. */
function autoAssign(picks, players, data) {
  const used = new Set();
  const out = picks.map(() => null);

  picks.forEach((t, i) => {
    const g = guessPlayer(t, data);
    if (g && players.includes(g) && !used.has(g)) { out[i] = g; used.add(g); }
  });

  picks.forEach((t, i) => {
    if (out[i]) return;
    const free = players.find(p => !used.has(p));
    if (free) { out[i] = free; used.add(free); }
  });

  return out;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ---------- weekends ---------- */

/* A football week runs Thursday to Monday, so every entry maps back to the
   Saturday of its weekend. Tue and Wed fall to the weekend just finished. */
const SAT_OFFSET = [-1, -2, -3, -4, 2, 1, 0];   // indexed by getDay()

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseISO(s) {
  const [y, m, d] = String(s || "").split("-").map(Number);
  return (y && m && d) ? new Date(y, m - 1, d) : null;
}

function isoOf(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
         "-" + String(d.getDate()).padStart(2, "0");
}

function weekendKey(iso) {
  const d = parseISO(iso);
  if (!d) return iso || "";
  d.setDate(d.getDate() + SAT_OFFSET[d.getDay()]);
  return isoOf(d);
}

/* "Sep 5-6", or a single date when only one slate was played. */
function weekendLabel(entries) {
  const dates = [...new Set(entries.map(e => e.date))].filter(Boolean).sort();
  if (!dates.length) return "";
  const a = parseISO(dates[0]);
  const b = parseISO(dates[dates.length - 1]);
  if (!a) return dates[0];
  const head = MON[a.getMonth()] + " " + a.getDate();
  if (!b || dates.length === 1) return head;
  if (a.getMonth() === b.getMonth() && a.getDate() === b.getDate()) return head;
  return a.getMonth() === b.getMonth()
    ? head + "-" + b.getDate()
    : head + " - " + MON[b.getMonth()] + " " + b.getDate();
}

/* Every weekend holding entries, newest first. */
function weekends(data) {
  const map = {};
  data.entries.forEach(e => {
    const k = weekendKey(e.date);
    (map[k] = map[k] || []).push(e);
  });
  return Object.keys(map).sort().reverse().map(k => ({
    key: k,
    entries: map[k],
    label: weekendLabel(map[k])
  }));
}

/* What one player did in one league over one weekend. Two slates in the same
   league collapse to a record ("2-0") rather than a single letter. */
function weekendCell(entries, league, player) {
  const list = entries.filter(e => e.league === league);
  if (!list.length) return { kind: "none", text: "—" };

  let w = 0, l = 0, p = 0;
  list.forEach(e => {
    const r = (e.picks[player] || {}).result;
    if (r === "W") w++; else if (r === "L") l++; else if (r === "P") p++;
  });
  if (!w && !l && !p) return { kind: "none", text: "—" };

  if (w + l + p === 1) {
    if (p) return { kind: "P", text: "pending" };
    return w ? { kind: "W", text: "W" } : { kind: "L", text: "L" };
  }
  return {
    kind: w > l ? "W" : l > w ? "L" : "even",
    text: w + "-" + l + (p ? " +" + p + "P" : "")
  };
}

/* Season to date, both leagues together. */
function overallRec(data, player) {
  const rec = blankRec();
  data.entries.forEach(e => {
    const r = (e.picks[player] || {}).result;
    if (r === "W") rec.w++; else if (r === "L") rec.l++;
  });
  return rec;
}

/* ---------- share card ---------- */

const CARD = {
  w: 1080, pad: 60, rowH: 92, headH: 62, nameW: 296,
  bg: "#0a0d12", panel: "#151b25", line: "#232c3a",
  text: "#eef2f8", muted: "#8794a8", dim: "#5c6779",
  win: "#32d977", winBg: "#12341f",
  loss: "#ff5c45", lossBg: "#351511",
  gold: "#ffc94d", goldBg: "#3a2d0a"
};

const CARD_FONT = '-apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';

function cardFont(weight, size) {
  return weight + " " + size + "px " + CARD_FONT;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function cellColors(kind) {
  if (kind === "W") return [CARD.winBg, CARD.win];
  if (kind === "L") return [CARD.lossBg, CARD.loss];
  if (kind === "P") return [CARD.goldBg, CARD.gold];
  if (kind === "even") return ["#222b39", CARD.muted];
  return [null, CARD.dim];
}

/* A PNG of one weekend: both slates per player, plus the season record. */
function buildShareCard(data, weekend, siteUrl) {
  const C = CARD;
  const rows = data.players.map(p => ({
    name: p,
    cfb: weekendCell(weekend.entries, "cfb", p),
    nfl: weekendCell(weekend.entries, "nfl", p),
    all: overallRec(data, p)
  }));

  let gw = 0, gl = 0, gp = 0;
  weekend.entries.forEach(e => data.players.forEach(p => {
    const r = (e.picks[p] || {}).result;
    if (r === "W") gw++; else if (r === "L") gl++; else if (r === "P") gp++;
  }));

  const tableY = C.pad + 168;
  const tableH = C.headH + rows.length * C.rowH;
  const footY = tableY + tableH + 52;
  const height = footY + 40 + C.pad;

  const cv = document.createElement("canvas");
  cv.width = C.w;
  cv.height = height;
  const ctx = cv.getContext("2d");

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, C.w, height);
  ctx.textBaseline = "middle";

  // header
  ctx.textAlign = "left";
  ctx.fillStyle = C.text;
  ctx.font = cardFont(700, 54);
  ctx.fillText("Parlay Club", C.pad, C.pad + 36);
  ctx.fillStyle = C.muted;
  ctx.font = cardFont(500, 34);
  ctx.fillText(weekend.label, C.pad, C.pad + 92);

  ctx.textAlign = "right";
  ctx.fillStyle = C.dim;
  ctx.font = cardFont(600, 22);
  ctx.fillText("THIS WEEKEND", C.w - C.pad, C.pad + 26);
  ctx.fillStyle = gw > gl ? C.win : gl > gw ? C.loss : C.text;
  ctx.font = cardFont(700, 52);
  ctx.fillText(gw + "-" + gl, C.w - C.pad, C.pad + 74);
  if (gp) {
    ctx.fillStyle = C.gold;
    ctx.font = cardFont(600, 24);
    ctx.fillText(gp + " still pending", C.w - C.pad, C.pad + 122);
  }

  // table shell
  const tx = C.pad, tw = C.w - C.pad * 2;
  ctx.fillStyle = C.panel;
  roundRect(ctx, tx, tableY, tw, tableH, 24);
  ctx.fill();

  const colW = (tw - C.nameW) / 3;
  const colMid = i => tx + C.nameW + colW * i + colW / 2;

  // column headings
  ctx.textAlign = "center";
  ctx.fillStyle = C.dim;
  ctx.font = cardFont(600, 22);
  ["COLLEGE", "NFL", "OVERALL"].forEach((h, i) =>
    ctx.fillText(h, colMid(i), tableY + C.headH / 2 + 1));

  ctx.fillStyle = C.line;
  ctx.fillRect(tx, tableY + C.headH, tw, 1);

  rows.forEach((r, i) => {
    const y = tableY + C.headH + i * C.rowH;
    const mid = y + C.rowH / 2;
    if (i) ctx.fillStyle = C.line, ctx.fillRect(tx + 28, y, tw - 56, 1);

    ctx.textAlign = "left";
    ctx.fillStyle = C.text;
    ctx.font = cardFont(600, 38);
    ctx.fillText(r.name, tx + 34, mid);

    [r.cfb, r.nfl].forEach((cell, k) => {
      const [bg, fg] = cellColors(cell.kind);
      const cx = colMid(k);
      // A leg still waiting on its game reads as quiet small text, not a result.
      const waiting = cell.kind === "P";
      const size = waiting ? 22 : (cell.text.length > 2 ? 26 : 32);
      if (bg) {
        const pw = waiting ? 124 : (cell.text.length > 2 ? 132 : 84);
        const ph = waiting ? 40 : 52;
        ctx.fillStyle = bg;
        roundRect(ctx, cx - pw / 2, mid - ph / 2, pw, ph, waiting ? 11 : 14);
        ctx.fill();
      }
      ctx.textAlign = "center";
      ctx.fillStyle = fg;
      ctx.font = cardFont(waiting ? 600 : 700, size);
      ctx.fillText(cell.text, cx, mid + 1);
    });

    const played = r.all.w + r.all.l;
    ctx.textAlign = "center";
    ctx.fillStyle = !played ? C.dim : r.all.w > r.all.l ? C.win : r.all.w < r.all.l ? C.loss : C.text;
    ctx.font = cardFont(700, 36);
    ctx.fillText(played ? r.all.w + "-" + r.all.l : "—", colMid(2), mid);
  });

  // footer
  ctx.textAlign = "left";
  ctx.fillStyle = C.dim;
  ctx.font = cardFont(500, 26);
  ctx.fillText(String(siteUrl || "").replace(/^https?:\/\//, "").replace(/\/$/, ""), C.pad, footY);
  if (data.season) {
    ctx.textAlign = "right";
    ctx.fillText(data.season + " season", C.w - C.pad, footY);
  }

  return cv;
}
