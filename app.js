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

/* Three places hold the same file and they do not update together. The API
   answers with whatever was committed a second ago. The Pages copy waits on a
   redeploy, a minute or two. raw.githubusercontent hands out a cached copy for
   five minutes and ignores a cache-busting query, which is why a fresh save
   used to look like nothing had happened. So: API first, Pages next, raw last.
   The API allows 60 calls an hour per address unauthenticated; past that it
   answers 403 and the loop simply moves on. */
async function loadResults() {
  const bust = "?t=" + Date.now();
  const r = repoSettings();
  const sources = [];
  if (r) {
    sources.push({
      url: `https://api.github.com/repos/${r.owner}/${r.repo}/contents/${CONFIG.file}` +
           `?ref=${r.branch || "main"}&t=${Date.now()}`,
      raw: true
    });
  }
  sources.push({ url: CONFIG.file + bust });
  if (r) {
    sources.push({
      url: `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.branch || "main"}/${CONFIG.file}${bust}`
    });
  }

  let lastErr = null;
  for (const s of sources) {
    try {
      const res = await fetch(s.url, {
        cache: "no-store",
        headers: s.raw ? { Accept: "application/vnd.github.raw" } : {}
      });
      if (!res.ok) { lastErr = new Error(`${res.status} on ${s.url}`); continue; }
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

  const stake = Number(d.stake);
  return { players, season: d.season || "", stake: stake > 0 ? stake : 5, entries };
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
    payout: Number(e.payout) > 0 ? Number(e.payout) : 0,   // only set on a parlay that cashed
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
    money: {
      cfb: moneyFor(data, "cfb"),
      nfl: moneyFor(data, "nfl"),
      all: moneyFor(data)
    },
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
  "Wisconsin","Wyoming"
];

/* Words that start a pick but are not teams, so they stay out of team fields. */
const OPENERS = ["Over", "Under"];

/* Team names only. The builder's team boxes and the half of a free-text pick
   after a slash both want this and nothing else. */
function suggestTeams(query, limit) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  const push = v => {
    if (v.toLowerCase() === q) return;
    if (!hits.includes(v)) hits.push(v);
  };
  TEAMS.filter(v => v.toLowerCase().startsWith(q)).forEach(push);
  TEAMS.filter(v => !v.toLowerCase().startsWith(q) && v.toLowerCase().includes(q)).forEach(push);
  return hits.slice(0, limit || 6);
}

/* Read a written pick back into the builder's boxes, so a correction does not
   mean retyping it. Anything that fits neither shape is left as free text. */
function parsePick(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  let m = t.match(/^(.+?)\s*\/\s*(.+?)\s+(over|under)(?:\s+([0-9.]+))?$/i);
  if (m) {
    return {
      mode: "ou", a: m[1].trim(), b: m[2].trim(),
      ou: m[3].toLowerCase() === "under" ? "Under" : "Over",
      num: m[4] || ""
    };
  }

  m = t.match(/^(.+?)\s*([+-])\s*([0-9.]+)$/);
  if (m) return { mode: "sp", team: m[1].trim(), sg: m[2], num: m[3] };

  return null;
}

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

/* Prior picks first (whole strings), then team names. An over/under is written
   "UNLV/Memphis Over 52.5", so once there is a slash the thing being typed is
   the second team: complete that and hand back the whole line. */
function suggestPicks(query, data, limit) {
  const slash = query.lastIndexOf("/");
  if (slash > -1) {
    const head = query.slice(0, slash + 1);
    const tail = query.slice(slash + 1);
    if (!tail.trim()) return [];
    return suggestTeams(tail, limit).map(t => head + t);
  }

  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  const push = v => {
    if (v.toLowerCase() === q) return;                 // already typed exactly
    if (!hits.some(h => h.toLowerCase() === v.toLowerCase())) hits.push(v);
  };
  const starts = v => v.toLowerCase().startsWith(q);
  const has = v => v.toLowerCase().includes(q);

  const words = TEAMS.concat(OPENERS);
  const prior = data ? priorPicks(data) : [];
  prior.filter(starts).forEach(push);
  words.filter(starts).forEach(push);
  prior.filter(v => !starts(v) && has(v)).forEach(push);
  words.filter(v => !starts(v) && has(v)).forEach(push);
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

/* One player's record. Omit the league for both together. */
function seasonRec(data, player, league) {
  const rec = blankRec();
  data.entries.forEach(e => {
    if (league && e.league !== league) return;
    const r = (e.picks[player] || {}).result;
    if (r === "W") rec.w++; else if (r === "L") rec.l++;
  });
  return rec;
}

function overallRec(data, player) { return seasonRec(data, player, null); }

/* Everyone plays the same parlay for the same stake, so the ledger is one
   person's: every entry costs the stake, and a parlay that cashes pays out
   whatever was entered for it. */
function moneyFor(data, league) {
  const stake = Number(data.stake) > 0 ? Number(data.stake) : 5;
  let wagered = 0, won = 0, unpriced = 0;
  data.entries.forEach(e => {
    if (league && e.league !== league) return;
    wagered += stake;
    if (isParlay(data, e)) {
      if (e.payout > 0) won += e.payout; else unpriced++;
    }
  });
  return { wagered, won, net: won - wagered, unpriced, stake };
}

/* Every leg a win. */
function isParlay(data, entry) {
  return data.players.every(p => (entry.picks[p] || {}).result === "W");
}

/* "$62.50", "-$40", "$0" */
function fmtMoney(n) {
  const v = Math.abs(Math.round(n * 100) / 100);
  return (n < 0 ? "-$" : "$") + (Number.isInteger(v) ? v : v.toFixed(2));
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

/* The combined column reads as a ladder: best record green, worst red, and
   everyone between shaded through yellow. Equal records share a rung, so a tie
   at the top is two greens. Anyone yet to play stays out of it entirely.
   Light tints, because they sit on a dark card. */
const LADDER = { top: [134, 229, 173], mid: [240, 217, 140], bot: [243, 163, 160] };

function ladderColors(records) {
  // Rungs are the distinct records as printed, in the order the table already
  // sorted them, so the eye and the colour agree: 4-0 above 3-0 above 3-1.
  const key = rc => rc.w + "-" + rc.l;
  const tiers = [];
  records.forEach(rc => {
    if (rc.w + rc.l === 0) return;
    if (!tiers.includes(key(rc))) tiers.push(key(rc));
  });

  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return records.map(rc => {
    if (rc.w + rc.l === 0) return null;
    const i = tiers.indexOf(key(rc));
    const t = tiers.length > 1 ? i / (tiers.length - 1) : 0;
    const c = t <= 0.5 ? mix(LADDER.top, LADDER.mid, t * 2)
                       : mix(LADDER.mid, LADDER.bot, (t - 0.5) * 2);
    return c;
  });
}

/* Which leagues cashed a full parlay this weekend. */
function weekendParlays(data, weekend) {
  const hit = [];
  ["cfb", "nfl"].forEach(lg => {
    weekend.entries.filter(e => e.league === lg).forEach(e => {
      if (isParlay(data, e)) hit.push({ league: lg, payout: e.payout });
    });
  });
  return hit;
}

/* A PNG of one weekend: how each guy did on both slates, their season splits,
   and the combined record everything is ranked by. */
function buildShareCard(data, weekend, siteUrl) {
  const C = CARD;
  const pad = C.pad, W = C.w;
  /* A gutter between the weekend pair and the season trio, so the two halves
     read as two blocks instead of five columns in a row. */
  const nameW = 200, colW = 146, cols = 5, gap = 30;
  const tx = pad, tw = nameW + colW * cols + gap;    // 200 + 730 + 30 = 960
  const colX = i => tx + nameW + colW * i + (i >= 2 ? gap : 0);
  const colMid = i => colX(i) + colW / 2;
  const seasonX = colX(2);                           // left edge of the season half
  const splitX = seasonX - gap / 2;                  // weekend | season divider

  const rows = data.players.map(p => ({
    name: p,
    wkCfb: weekendCell(weekend.entries, "cfb", p),
    wkNfl: weekendCell(weekend.entries, "nfl", p),
    sCfb: seasonRec(data, p, "cfb"),
    sNfl: seasonRec(data, p, "nfl"),
    all: overallRec(data, p)
  })).sort((a, b) => {
    const pa = pct(a.all), pb = pct(b.all);
    return (pb - pa) || (b.all.w - a.all.w) || a.name.localeCompare(b.name);
  });

  let gw = 0, gl = 0, gp = 0;
  weekend.entries.forEach(e => data.players.forEach(p => {
    const r = (e.picks[p] || {}).result;
    if (r === "W") gw++; else if (r === "L") gl++; else if (r === "P") gp++;
  }));

  const hits = weekendParlays(data, weekend);
  const money = moneyFor(data);
  const ladder = ladderColors(rows.map(r => r.all));

  const headH = 84, rowH = 92;
  const stickerY = pad + 152;
  const stickerH = hits.length ? 84 : 0;
  const tableY = stickerY + stickerH + (hits.length ? 20 : 0);
  const tableH = headH + rows.length * rowH;
  const footY = tableY + tableH + 50;
  const height = footY + 42 + pad;

  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = height;
  const ctx = cv.getContext("2d");

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, height);
  ctx.textBaseline = "middle";

  /* ---- header ---- */
  ctx.textAlign = "left";
  ctx.fillStyle = C.text;
  ctx.font = cardFont(700, 54);
  ctx.fillText("Parlay Club", pad, pad + 36);
  ctx.fillStyle = C.muted;
  ctx.font = cardFont(500, 34);
  ctx.fillText(weekend.label, pad, pad + 92);

  ctx.textAlign = "right";
  ctx.fillStyle = C.dim;
  ctx.font = cardFont(600, 22);
  ctx.fillText("THIS WEEKEND", W - pad, pad + 26);
  ctx.fillStyle = gw > gl ? C.win : gl > gw ? C.loss : C.text;
  ctx.font = cardFont(700, 52);
  ctx.fillText(gw + "-" + gl, W - pad, pad + 74);
  if (gp) {
    ctx.fillStyle = C.gold;
    ctx.font = cardFont(600, 24);
    ctx.fillText(gp + " still pending", W - pad, pad + 122);
  }

  /* ---- the sticker, when a parlay actually cashed ---- */
  if (hits.length) {
    const sw = (tw - (hits.length - 1) * 16) / hits.length;
    hits.forEach((h, i) => {
      const x = tx + i * (sw + 16);
      ctx.fillStyle = "#123a22";
      roundRect(ctx, x, stickerY, sw, stickerH, 18);
      ctx.fill();
      ctx.strokeStyle = C.win;
      ctx.lineWidth = 3;
      roundRect(ctx, x + 1.5, stickerY + 1.5, sw - 3, stickerH - 3, 17);
      ctx.stroke();

      ctx.textAlign = "center";
      ctx.fillStyle = C.win;
      ctx.font = cardFont(800, hits.length > 1 ? 30 : 36);
      const label = (h.league === "cfb" ? "COLLEGE" : "NFL") + " PARLAY HIT";
      ctx.fillText(label, x + sw / 2, stickerY + (h.payout ? 32 : stickerH / 2));
      if (h.payout) {
        ctx.fillStyle = "#a7f5c8";
        ctx.font = cardFont(700, 26);
        ctx.fillText("+" + fmtMoney(h.payout), x + sw / 2, stickerY + 62);
      }
    });
  }

  /* ---- table shell ---- */
  ctx.fillStyle = C.panel;
  roundRect(ctx, tx, tableY, tw, tableH, 24);
  ctx.fill();

  // the season half sits on a slightly lighter ground, so the eye splits the
  // table in two before it ever reads a number
  ctx.save();
  roundRect(ctx, tx, tableY, tw, tableH, 24);
  ctx.clip();
  ctx.fillStyle = "#1c2432";
  ctx.fillRect(splitX, tableY, tx + tw - splitX, tableH);
  ctx.restore();

  // group headings, then the column names beneath them
  const wkMid = tx + nameW + colW, seMid = colX(2) + colW * 1.5;
  ctx.textAlign = "center";
  ctx.fillStyle = C.muted;
  ctx.font = cardFont(800, 21);
  ctx.fillText("THIS WEEKEND", wkMid, tableY + 26);
  ctx.fillText("SEASON", seMid, tableY + 26);

  ctx.fillStyle = C.dim;
  ctx.font = cardFont(600, 19);
  ["COLLEGE", "NFL", "COLLEGE", "NFL", "TOTAL"].forEach((h, i) =>
    ctx.fillText(h, colMid(i), tableY + 60));

  ctx.fillStyle = C.line;
  ctx.fillRect(tx, tableY + headH, tw, 1);

  rows.forEach((r, i) => {
    const y = tableY + headH + i * rowH;
    const mid = y + rowH / 2;
    if (i) { ctx.fillStyle = C.line; ctx.fillRect(tx + 24, y, tw - 48, 1); }

    ctx.textAlign = "left";
    ctx.fillStyle = C.text;
    ctx.font = cardFont(600, 34);
    ctx.fillText(r.name, tx + 30, mid);

    // this weekend
    [r.wkCfb, r.wkNfl].forEach((cell, k) => {
      const [bg, fg] = cellColors(cell.kind);
      const cx = colMid(k);
      const waiting = cell.kind === "P";
      const size = waiting ? 20 : (cell.text.length > 2 ? 24 : 30);
      if (bg) {
        const pw = waiting ? 112 : (cell.text.length > 2 ? 116 : 78);
        const ph = waiting ? 38 : 50;
        ctx.fillStyle = bg;
        roundRect(ctx, cx - pw / 2, mid - ph / 2, pw, ph, waiting ? 10 : 13);
        ctx.fill();
      }
      ctx.textAlign = "center";
      ctx.fillStyle = fg;
      ctx.font = cardFont(waiting ? 600 : 700, size);
      ctx.fillText(cell.text, cx, mid + 1);
    });

    // season splits, then the combined record the sort runs on
    const rec = (rc, k, big) => {
      const played = rc.w + rc.l;
      ctx.textAlign = "center";
      ctx.fillStyle = !played ? C.dim
        : rc.w > rc.l ? C.win : rc.w < rc.l ? C.loss : C.text;
      ctx.font = cardFont(big ? 800 : 600, big ? 32 : 27);
      ctx.fillText(played ? fmtRec(rc) : "—", colMid(k), mid);
    };
    rec(r.sCfb, 2, false);
    rec(r.sNfl, 3, false);

    // the combined record, sitting on its rung of the ladder
    const c = ladder[i];
    const cx = colMid(4);
    if (c) {
      ctx.fillStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.13)`;
      roundRect(ctx, cx - 58, mid - 26, 116, 52, 14);
      ctx.fill();
      ctx.fillStyle = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    } else {
      ctx.fillStyle = C.dim;
    }
    ctx.textAlign = "center";
    ctx.font = cardFont(800, 32);
    ctx.fillText(c ? fmtRec(r.all) : "—", cx, mid + 1);
  });

  // the seam goes on last so the row rules don't chop it up
  ctx.fillStyle = "#3d4b5f";
  ctx.fillRect(splitX - 1, tableY, 2, tableH);

  /* ---- footer ---- */
  ctx.textAlign = "left";
  ctx.fillStyle = C.dim;
  ctx.font = cardFont(500, 24);
  ctx.fillText(String(siteUrl || "").replace(/^https?:\/\//, "").replace(/\/$/, ""), pad, footY);

  ctx.textAlign = "right";
  ctx.font = cardFont(700, 26);
  ctx.fillStyle = money.net > 0 ? C.win : money.net < 0 ? C.loss : C.muted;
  ctx.fillText(fmtMoney(money.net) + " on the year", W - pad, footY);

  return cv;
}

/* Break a pick over at most maxLines, trimming the last one with an ellipsis
   rather than letting a long prop run off the card. */
function wrapText(ctx, text, maxW, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let cur = "";
  words.forEach(w => {
    const t = cur ? cur + " " + w : w;
    if (!cur || ctx.measureText(t).width <= maxW) cur = t;
    else { lines.push(cur); cur = w; }
  });
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
  kept[maxLines - 1] = last.replace(/\s+$/, "") + "…";
  return kept;
}

/* The slate itself: who took what, for sharing before kickoff so everyone can
   see all five legs in one place. A leg still waiting shows no marker, so a
   card sent the night before is all picks and no noise. */
function buildSlateCard(data, entry, siteUrl) {
  const C = CARD;
  const pad = C.pad, W = C.w;
  const tx = pad, tw = W - pad * 2;
  const nameW = 230;
  const pickW = tw - nameW - 130;                 // room for a W/L chip on the end

  const probe = document.createElement("canvas").getContext("2d");
  probe.font = cardFont(600, 30);
  const rows = data.players.map(p => {
    const v = entry.picks[p] || {};
    return {
      name: p,
      result: v.result || null,
      lines: v.pick ? wrapText(probe, v.pick, pickW, 2) : []
    };
  });

  let w = 0, l = 0, pend = 0;
  rows.forEach(r => { if (r.result === "W") w++; else if (r.result === "L") l++; else pend++; });

  const rowH = r => (r.lines.length > 1 ? 128 : 96);
  const tableY = pad + 150;
  const tableH = rows.reduce((n, r) => n + rowH(r), 0);
  const footY = tableY + tableH + 50;
  const height = footY + 42 + pad;

  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = height;
  const ctx = cv.getContext("2d");

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, height);
  ctx.textBaseline = "middle";

  /* ---- header ---- */
  ctx.textAlign = "left";
  ctx.fillStyle = C.text;
  ctx.font = cardFont(700, 54);
  ctx.fillText("Parlay Club", pad, pad + 36);
  ctx.fillStyle = C.muted;
  ctx.font = cardFont(500, 34);
  ctx.fillText(entry.label || "", pad, pad + 92);

  ctx.textAlign = "right";
  ctx.fillStyle = C.dim;
  ctx.font = cardFont(600, 22);
  ctx.fillText("THE SLATE", W - pad, pad + 26);
  // before kickoff there is nothing to report but the number of legs
  if (w + l === 0) {
    ctx.fillStyle = C.gold;
    ctx.font = cardFont(700, 40);
    ctx.fillText(rows.length + " LEGS", W - pad, pad + 74);
  } else {
    ctx.fillStyle = w > l ? C.win : l > w ? C.loss : C.text;
    ctx.font = cardFont(700, 52);
    ctx.fillText(w + "-" + l, W - pad, pad + 74);
    if (pend) {
      ctx.fillStyle = C.gold;
      ctx.font = cardFont(600, 22);
      ctx.fillText(pend + " still pending", W - pad, pad + 118);
    }
  }

  /* ---- the picks ---- */
  ctx.fillStyle = C.panel;
  roundRect(ctx, tx, tableY, tw, tableH, 24);
  ctx.fill();

  let y = tableY;
  rows.forEach((r, i) => {
    const h = rowH(r);
    const mid = y + h / 2;
    if (i) { ctx.fillStyle = C.line; ctx.fillRect(tx + 24, y, tw - 48, 1); }

    ctx.textAlign = "left";
    ctx.fillStyle = C.text;
    ctx.font = cardFont(700, 34);
    ctx.fillText(r.name, tx + 30, mid);

    ctx.font = cardFont(600, 30);
    if (r.lines.length) {
      ctx.fillStyle = C.text;
      const top = mid - (r.lines.length - 1) * 19;
      r.lines.forEach((ln, k) => ctx.fillText(ln, tx + nameW, top + k * 38));
    } else {
      ctx.fillStyle = C.dim;
      ctx.fillText("no pick logged", tx + nameW, mid);
    }

    // a settled leg gets its mark; a pending one stays quiet
    if (r.result === "W" || r.result === "L") {
      const [bg, fg] = cellColors(r.result);
      const cw = 66, ch = 48, cxr = tx + tw - 30 - cw;
      ctx.fillStyle = bg;
      roundRect(ctx, cxr, mid - ch / 2, cw, ch, 12);
      ctx.fill();
      ctx.textAlign = "center";
      ctx.fillStyle = fg;
      ctx.font = cardFont(800, 28);
      ctx.fillText(r.result, cxr + cw / 2, mid + 1);
    }

    y += h;
  });

  /* ---- footer ---- */
  const stake = Number(data.stake) > 0 ? Number(data.stake) : 5;
  ctx.textAlign = "left";
  ctx.fillStyle = C.dim;
  ctx.font = cardFont(500, 24);
  ctx.fillText(String(siteUrl || "").replace(/^https?:\/\//, "").replace(/\/$/, ""), pad, footY);

  ctx.textAlign = "right";
  ctx.font = cardFont(700, 26);
  ctx.fillStyle = C.muted;
  ctx.fillText(fmtMoney(stake) + " parlay", W - pad, footY);

  return cv;
}

/* ---------- iOS Home Screen status bar ---------- */

/* Added to the Home Screen the page runs under the status bar, and iOS is
   meant to report that as a safe-area inset. Some installs report none, so
   the title gets drawn behind the clock. Measure the inset and only pad when
   it really is missing, leaving phones that report it correctly alone. */
function padForStatusBar() {
  const standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  if (!standalone || !document.body) return;

  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;left:0;width:1px;visibility:hidden;" +
                        "pointer-events:none;height:env(safe-area-inset-top,0px)";
  document.body.appendChild(probe);
  const inset = probe.getBoundingClientRect().height;
  probe.remove();

  if (inset < 20) document.documentElement.classList.add("no-safe-inset");
}

padForStatusBar();
