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
      result: ["W", "L", "T", "P"].includes(v.result) ? v.result : null,   // T = push, P = pending
      pick: v.pick || ""
    };
  });
  return {
    id: e.id || (date + "-" + league),
    date, league, picks,
    odds: String(e.odds || "").trim(),                     // American, as written on the slip
    payout: Number(e.payout) > 0 ? Number(e.payout) : 0,   // only set on a parlay that cashed
    label: e.label || ""   // filled in by normalize so repeats get numbered
  };
}

/* ---------- in play ---------- */

/* A slate with a leg still to play is "In Play". One phrase, used everywhere:
   the bar on the dashboard, the bar in the admin, the share card. */
function inPlay(data, entry) {
  return data.players.some(p => (entry.picks[p] || {}).result === "P");
}

/* Every slate still running, newest first. */
function inPlayEntries(data) {
  return data.entries.filter(e => inPlay(data, e)).reverse();
}

/* Wins, losses and legs still to play on one slate. */
function tally(data, entry) {
  const t = { w: 0, l: 0, t: 0, p: 0, blank: 0 };
  data.players.forEach(pl => {
    const r = (entry.picks[pl] || {}).result;
    if (r === "W") t.w++; else if (r === "L") t.l++; else if (r === "T") t.t++;
    else if (r === "P") t.p++; else t.blank++;
  });
  return t;
}

/* American odds as written: "+2750", or "2750" typed without the sign. */
function fmtOdds(odds) {
  const t = String(odds || "").trim();
  if (!t) return "";
  return /^\d/.test(t) ? "+" + t : t;
}

/* What the stake comes back as in total, stake included, which is the number
   the payout field holds. +2750 on $5 returns $142.50. */
function oddsReturn(odds, stake) {
  const s = Number(stake) > 0 ? Number(stake) : 5;
  const m = String(odds || "").trim().match(/^([+-]?)(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  const n = Number(m[2]);
  if (!n) return 0;
  const profit = m[1] === "-" ? s * (100 / n) : s * (n / 100);
  return Math.round((s + profit) * 100) / 100;
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

function blankRec() { return { w: 0, l: 0, t: 0 }; }

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
    const s = { id: e.id, label: e.label, league: e.league, date: e.date,
                w: 0, l: 0, t: 0, counted: 0, pending: 0, perfect: true };
    data.players.forEach(p => {
      const raw = v_result(e, p);
      // Pending and blank sit out of the record and out of streaks. A push is
      // settled, so it counts towards the slate being done, but it is not a
      // win or a loss: it stays out of the record and the run carries through
      // it rather than breaking on it.
      const res = raw === "W" || raw === "L" ? raw : null;
      per[p].seq[e.league].push(res);
      per[p].seq.all.push(res);          // entries are date-sorted, so this is chronological
      if (raw === "P") { s.pending += 1; s.perfect = false; return; }
      if (!res && raw !== "T") { s.perfect = false; return; }
      const b = raw === "T" ? "t" : res === "W" ? "w" : "l";
      per[p][e.league][b] += 1;
      per[p].all[b] += 1;
      group[e.league][b] += 1;
      group.all[b] += 1;
      s[b] += 1;
      s.counted += 1;
      if (res === "L") s.perfect = false;
    });
    // Five pushes is a refund, not a parlay. A win has to be in there.
    if (!s.w) s.perfect = false;
    summaries.push(s);
  });

  /* A parlay cashes when no leg loses and at least one wins. A pushed leg
     drops out of the bet at the book and pays at the shorter price, so it
     does not stop the slate cashing. */
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
      streak: { cfb: curStreak(s.seq.cfb), nfl: curStreak(s.seq.nfl), all: curStreak(s.seq.all) },
      best: { cfb: bestRun(s.seq.cfb), nfl: bestRun(s.seq.nfl), all: bestRun(s.seq.all) },
      solo: {
        cfb: soloLosses(data, p, "cfb"),
        nfl: soloLosses(data, p, "nfl"),
        all: soloLosses(data, p)
      }
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
/* The run in progress, signed: 3 is three straight wins, -3 is three straight
   losses. Pending and blank legs sit out rather than breaking the run. */
function curStreak(seq) {
  let n = 0, dir = null;
  for (let i = seq.length - 1; i >= 0; i--) {
    if (seq[i] === null) continue;
    if (dir === null) dir = seq[i];
    if (seq[i] !== dir) break;
    n++;
  }
  return dir === "L" ? -n : n;
}

/* The same run for one player straight off the entries, for the share card,
   which builds its own rows rather than going through computeStats. */
function playerStreak(data, player) {
  const seq = data.entries.map(e => {
    const r = (e.picks[player] || {}).result;
    return r === "W" || r === "L" ? r : null;
  });
  return curStreak(seq);
}

/* Two or more either way is worth a colour. Anything less is just noise. */
function streakColor(n, C) {
  if (n >= 2) return C.win;
  if (n <= -2) return C.loss;
  return null;
}

/* The longest run of wins anywhere in the season, not just the current one. */
function bestRun(seq) {
  let best = 0, n = 0;
  seq.forEach(v => {
    if (v === null) return;
    if (v === "W") { n++; if (n > best) best = n; } else n = 0;
  });
  return best;
}

/* Slates where this one was the only loss: the parlay was 4-1 and he was the
   1. The stat everyone in the group actually wants to know. */
function soloLosses(data, player, league) {
  let n = 0;
  data.entries.forEach(e => {
    if (league && e.league !== league) return;
    if ((e.picks[player] || {}).result !== "L") return;
    const rest = data.players.filter(p => p !== player);
    // a push beside him is not a miss, so he was still the only one
    if (rest.every(p => { const r = (e.picks[p] || {}).result; return r === "W" || r === "T"; })) n++;
  });
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

/* Pushes only show when there are some, so a clean record stays two numbers. */
function fmtRec(rec) { return rec.t ? `${rec.w}-${rec.l}-${rec.t}` : `${rec.w}-${rec.l}`; }

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
const PASTE_NOISE = /^(spread|total|totals|moneyline|money line|straight|parlay|same game parlay|sgp|parlay boost ineligible|boost applied.*|open|pending|live|won|win|lost|loss|push|void|cashed out|cash out|to win|to pay|wager|paid|bet slip|draftkings|the crown is yours|[+-]?\d+% parlay boost|\d+ pick parlay)[:.]?$/i;

/* ---------- reading a DraftKings slip ---------- */

/* The slip screenshot, read top to bottom by iOS Live Text, comes out as a
   header, a summary line, then one block per leg. The blocks are what matter:
   the summary drops the subject of a prop the same way it drops the teams off
   a total, so "Over 3.5" there could be anybody. Underneath, the leg says
   "Mike Evans Receptions O/U" and the ambiguity is gone. */
const DK_PLAIN_MARKET = /^(spread|total|totals|moneyline|money line)$/i;
const DK_OU_MARKET = /^(.+?)\s*o\/u$/i;                 // "Mike Evans Receptions O/U"
const DK_SCORER = /^anytime (td|touchdown) scorer$/i;
const DK_ODDS = /^[+-]\d{3,}$/;                          // +3054, -110
const DK_MONEY = /^\$\s?([\d,]+(?:\.\d{2})?)$/;
const DK_OVER_UNDER = /^(over|under)\b/i;

function isDkMarket(t) {
  return DK_PLAIN_MARKET.test(t) || DK_OU_MARKET.test(t) || DK_SCORER.test(t);
}

/* Everything worth having off one slip: the five legs, the price, the stake
   and what it paid. Results are not in here on purpose. The check marks are
   icons, and an icon does not survive Live Text. */
function parseSlip(text) {
  const lines = String(text || "").split(/\r?\n/).map(t => cleanPickLine(t)).filter(Boolean);
  const hasBlocks = lines.some(isDkMarket);
  if (!hasBlocks) return { picks: parseLoosePicks(text), odds: "", wager: 0, payout: 0, dk: false };

  /* The header runs out one line before the first market label, because that
     line is the first leg's pick rather than part of the header. */
  const firstMarket = Math.max(0, lines.findIndex(isDkMarket) - 1);
  const picks = [];
  let odds = "", wager = 0, payout = 0, moneyLabel = "";

  lines.forEach((t, i) => {
    /* Above the first leg sits the header: the price, the stake, the payout,
       and the summary line that cannot be trusted. */
    if (i < firstMarket) {
      if (DK_ODDS.test(t)) { odds = t; return; }          // a boost overwrites the original
      if (/^wager$/i.test(t.replace(/:$/, ""))) { moneyLabel = "wager"; return; }
      if (/^paid$/i.test(t.replace(/:$/, ""))) { moneyLabel = "paid"; return; }
      const m = t.match(DK_MONEY);
      if (m) {
        const v = Number(m[1].replace(/,/g, ""));
        if (moneyLabel === "paid") payout = v; else if (moneyLabel === "wager") wager = v;
        moneyLabel = "";
        return;
      }
      const w = t.match(/^wager:?\s*\$\s?([\d,.]+)/i);
      if (w) { wager = Number(w[1].replace(/,/g, "")); return; }
      const pd = t.match(/^paid:?\s*\$\s?([\d,.]+)/i);
      if (pd) { payout = Number(pd[1].replace(/,/g, "")); return; }
      return;                                             // summary line and branding
    }

    if (DK_ODDS.test(t)) return;                          // each leg prints its own price
    if (!/[a-z]/i.test(t)) return;                        // progress numbers off the bars
    if (PASTE_NOISE.test(t) && !isDkMarket(t)) return;

    const city = venueCity(t);
    if (city) {
      const last = picks[picks.length - 1];
      if (last && DK_OVER_UNDER.test(last) && !/\(/.test(last)) {
        picks[picks.length - 1] = last + " (" + city + ")";
      }
      return;
    }

    /* A market line describes the pick above it rather than being one. */
    if (isDkMarket(t)) {
      const last = picks.length - 1;
      if (last < 0) return;
      if (DK_SCORER.test(t)) { picks[last] = picks[last] + " Anytime TD"; return; }
      const ou = t.match(DK_OU_MARKET);
      if (ou && DK_OVER_UNDER.test(picks[last])) {
        picks[last] = ou[1].trim() + " " + picks[last];    // "Mike Evans Receptions Over 3.5"
      }
      return;                                              // Spread and Total say nothing new
    }

    picks.push(t);
  });

  return { picks, odds, wager, payout, dk: true };
}

/* Anything that is not a DraftKings slip: keep the lines that look like picks
   and drop the labels, the prices and the places. */
function parseLoosePicks(text) {
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
      if (last && DK_OVER_UNDER.test(last) && !/\(/.test(last)) {
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

const VENUE_LINE = /^@?\s*([A-Za-z .'&-]+),\s*[A-Z]{2}\.?$/;   // "Atlanta, GA" or "@ Atlanta, GA"

/* A total ("Over 54.5") carries no team name. The slip usually prints the
   venue right after it, so borrow the city rather than discarding it. */
function venueCity(line) {
  const m = line.match(VENUE_LINE);
  return m ? m[1].trim() : "";
}

function parsePastedPicks(text) {
  return parseSlip(text).picks;
}

/* ---------- the group text ---------- */

/* They write the week's picks into one message, each line opened with whose
   pick it is. Tyler takes the bare T and Tim takes Ti, because that is how
   they already type it to each other. Full names and longer prefixes work
   too. */
const PICK_INITIALS = { d: "Drew", p: "Pat", s: "Sam", ti: "Tim", t: "Tyler" };

/* Loose words to the house term. Order matters: "rush attempts" has to be
   tried before "rush", and "rush/rec" before either. */
const MARKETS = [
  [/\b(?:rush(?:ing)?\s*[+/&]\s*rec(?:eiving)?|rec(?:eiving)?\s*[+/&]\s*rush(?:ing)?|scrimmage)\b/i, "Rush + Rec"],
  [/\b(?:rush(?:ing)?\s*att(?:empts?)?|carries)\b/i, "Rush Attempts"],
  [/\b(?:receptions?|catches)\b/i, "Receptions"],
  [/\b(?:pass(?:ing)?\s*tds?)\b/i, "Pass TDs"],
  [/\b(?:rec(?:eiving)?\s*yards?|yards?\s*rec(?:eiving)?|rec(?:eiving)?)\b/i, "Rec"],
  [/\b(?:rush(?:ing)?\s*yards?|yards?\s*rush(?:ing)?|rush(?:ing)?)\b/i, "Rush"],
  [/\b(?:pass(?:ing)?\s*yards?|pass(?:ing)?)\b/i, "Pass"],
  [/\b(?:tackles?)\b/i, "Tackles"]
];

/* Surnames already in the history, so a bare "Gibbs" can come back as the
   "J. Gibbs" that is already stored. A surname written two different ways
   before is left alone rather than guessed at. */
function priorNameIndex(data) {
  const seen = {};
  data.entries.forEach(e => Object.keys(e.picks).forEach(p => {
    let t = ((e.picks[p] || {}).pick || "").trim();
    if (!t) return;
    t = t.split(/\b(?:over|under|anytime|td|touchdown|o\/u)\b/i)[0].trim();
    t = t.replace(/[+-]?\d.*$/, "").trim();
    if (!t || /\//.test(t)) return;          // "WVU/Cincinnati" is a game, not a person
    const parts = t.split(/\s+/);
    if (parts.length > 3) return;
    const last = parts[parts.length - 1].toLowerCase().replace(/[^a-z'-]/g, "");
    if (last.length < 2) return;        // JSN and the like are how he writes them
    (seen[last] = seen[last] || new Set()).add(t);
  }));
  const out = {};
  Object.keys(seen).forEach(k => { if (seen[k].size === 1) out[k] = [...seen[k]][0]; });
  return out;
}

/* Every skill-position player on an NFL roster, written "First Last", taken
   once from ESPN and kept here so that a paste needs no network and works on
   a bad signal. Around 5KB on the wire once compressed. There is no college
   list because the college picks in this pool are spreads and totals, not
   player props. */
const NFL_SKILL = "A.J. Brown|AJ Barner|AJ Dillon|AJ Henning|Aaron Jones|Adam Prentice|Adam Randall|Adam Trautman|Adonai Mitchell|Adrian Martinez|Ahmani Marshall|Aidan O'Connell|Al-Jay Henderson|Alec Ingold|Alec Pierce|Alvin Kamara|Amar Johnson|Ameer Abdullah|Amon-Ra St. Brown|Andre Szmyt|Andrei Iosivas|Andrew Armstrong|Andrew Beck|Andy Borregales|Andy Dalton|Anthony Gould|Anthony Richardson|Anthony Smith|Anthony Tyus|Antonio Williams|Antwane Wells|Arian Smith|Ashton Dulin|Ashton Jeanty|Athan Kaliakmanis|Audric Estime|Austin Ekeler|Austin Hooper|Austin Trammell|Baker Mayfield|Bam Knight|Barion Brown|Bauer Sharp|Beaux Collins|Behren Morton|Ben Sims|Ben Sinnott|Ben Skowronek|Ben VanSumeren|Ben Yurosek|Bhayshul Tuten|Bijan Robinson|Blake Corum|Blake Grupe|Blake Whiteheart|Bo Melton|Bo Nix|Brady Boyd|Brady Cook|Brady Russell|Braelon Allen|Brandin Cooks|Brandon Aiyuk|Brandon Aubrey|Brandon Johnson|Brandon McManus|Brandon Smith|Brashard Smith|Braxton Berrios|Brayden Willis|Breece Hall|Brenden Bates|Brenen Thompson|Brennan Presley|Brenton Strange|Brett Rypien|Brevin Jordan|Brevyn Spann-Ford|Brian Robinson|Brian Thomas|Britain Covey|British Brooks|Brittain Brown|Brock Bowers|Brock Lampe|Brock Purdy|Brock Wright|Bryce Lance|Bryce Oliver|Bryce Young|Brycen Tremayne|Bub Means|Bucky Irving|C.J. Stroud|CJ Daniels|CJ Dippre|CJ Donaldson|CJ Williams|Cade Klubnik|Cade Otton|Cade Stover|Caden Prieskorn|Cairo Santos|Caleb Douglas|Caleb Lohner|Caleb Williams|Calvin Austin|Calvin Ridley|Cam Grandy|Cam Little|Cam Miller|Cam Skattebo|Cam Ward|Camden Brown|Cameron Dicker|Cameron Latu|Carlos Washington|Carnell Tate|Carsen Ryan|Carson Beck|Carson Towt|Carson Wentz|Carter Runyon|Case Keenum|Casey Washington|Caullin Lacy|Cedric Tillman|CeeDee Lamb|Chad Ryland|Chandler Brayboy|Charlie Jones|Charlie Kolar|Charlie Smyth|Charlie Woerner|Chase Brown|Chase McLaughlin|Chig Okonkwo|Chimere Dike|Chip Trayanum|Chris Bell|Chris Blair|Chris Boswell|Chris Brazzell|Chris Brooks|Chris Godwin|Chris Manhertz|Chris Moore|Chris Myarick|Chris Olave|Chris Rodriguez|Christian Kirk|Christian McCaffrey|Christian Watson|Chuba Hubbard|Cody Hardy|Cody Schrader|Cody White|Colbie Young|Colby Parkinson|Cole Burgess|Cole Kmet|Cole Payton|Cole Turner|Coleman Owen|Colson Yankoff|Colston Loveland|Connor Heyward|Cooper Kupp|Corey Kiner|Courtland Sutton|Cyrus Allen|D'Andre Swift|D.J. Montgomery|DJ Giddens|DJ Herman|DJ Moore|DJ Uiagalelei|DK Metcalf|Dak Prescott|Dalen Cambre|Dallas Goedert|Dallen Bentley|Dalton Kincaid|Dalton Schultz|Dameon Pierce|Damon Bankston|Dan Villari|Dane Key|Daniel Bellinger|Daniel Carlson|Daniel Sobkowicz|Dareke Young|Darius Cooper|Darnell Mooney|Darnell Washington|Darren Waller|Davante Adams|David Martin-Robinson|David Montgomery|David Moore|David Njoku|Davis Allen|Davis Mills|Davon Booth|Dawson Knox|De'Von Achane|De'Zhaun Stribling|DeAndre Carter|DeMario Douglas|DeVonta Smith|Dean Connors|Dean Patterson|Dee Eskridge|DeeJay Dallas|Deebo Samuel|Deion Burks|Demarcus Robinson|Demond Claiborne|Denzel Boston|Derius Davis|Derrick Henry|Deshaun Watson|Devaughn Vele|Deven Thompkins|Devin Culp|Devin Duvernay|Devin Neal|Devin Singletary|Devontez Walker|Dillon Bell|Dillon Gabriel|Dohnte Meyers|Dominic Lovett|Dominic Zvada|Dont'e Thornton|Dontae Fleming|Dontayvion Wicks|Drake Dabney|Drake London|Drake Maye|Drew Allar|Drew Lock|Drew Ogletree|Drew Sample|Drew Stevens|Durham Smythe|Dyami Brown|Dylan Drummond|Dylan Laube|Dylan Sampson|E.J. Jenkins|Easton Stick|Eddy Pineiro|Efton Chism|Eli Heidenreich|Eli Raridon|Eli Stowers|Elic Ayomanor|Elijah Arroyo|Elijah Higgins|Elijah Mitchell|Elijah Moore|Elijah Sarratt|Emanuel Wilson|Emari Demercado|Emeka Egbuka|Emmanuel Henderson|Emmett Johnson|Eric Gray|Eric Rivers|Eric Saubert|Erick All|Erik Ezukanma|Evan Engram|Evan Hull|Evan McPherson|Feleipe Franks|Fernando Mendoza|Foster Moreau|Frank Gore|Gage Larvadain|Gardner Minshew|Garrett Greene|Garrett Nussmeier|Garrett Wilson|Gavin Bartholomew|Geno Smith|George Holani|George Kittle|George Pickens|Germie Bernard|Graham Mertz|Grant Calcaterra|Grant Finley|Greg Desrosiers|Greg Dortch|Greg Dulcich|Gunnar Helm|Gunner Olszewski|Harold Fannin|Harrison Bryant|Harrison Butker|Harrison Mevis|Harrison Wallace|Hassan Haskins|Hayden Large|Hayden Rucci|Haynes King|Hendon Hooker|Hunter Henry|Hunter Long|Hunter Luepke|Ian Thomas|Ian Wheeler|Irv Charles|Isaac Guerendo|Isaac TeSlaa|Isaiah Bond|Isaiah Davis|Isaiah Likely|Isaiah Neyor|Isaiah Williams|Isiah Pacheco|Israel Abanikanda|J'Mari Taylor|J. Michael Sturdivant|J.J. McCarthy|J.K. Dobbins|JP Richardson|Ja'Kobi Lane|Ja'Marr Chase|Ja'Mori Maclin|Ja'Tavion Sanders|Ja'seem Reed|Jabari Small|Jacardia Wright|Jack Bech|Jack Endries|Jack Stoll|Jack Strand|Jack Westover|Jackson Hawes|Jackson Meeks|Jacob Cowing|Jacob De Jesus|Jacob Saylors|Jacoby Brissett|Jacory Croskey-Merritt|Jadarian Price|Jaden Bradley|Jahan Dotson|Jahdae Walker|Jahmyr Gibbs|Jake Bates|Jake Bobo|Jake Briningstool|Jake Browning|Jake Elliott|Jake Ferguson|Jake Haener|Jake Moody|Jake Tonges|Jakobi Meyers|Jaleel McLaughlin|Jalen Brooks|Jalen Coker|Jalen Hurts|Jalen McMillan|Jalen Milroe|Jalen Moreno-Cropper|Jalen Nailor|Jalen Reagor|Jalen Royals|Jalen Tolbert|Jalin Hyatt|Jalon Daniels|Jam Miller|Jamaal Pritchett|Jamari Thrash|Jameis Winston|James Conner|James Cook|James Mitchell|Jameson Williams|Jared Goff|Jared Wayne|Jared Wiley|Jaren Kanak|Jaret Patterson|Jarrett Stidham|Jashaun Corbin|Jason Brownlee|Jason Myers|Jason Sanders|Jauan Jennings|Javonte Williams|Jawhar Jordan|Jaxon Smith-Njigba|Jaxson Dart|Jayden Daniels|Jayden Higgins|Jayden Reed|Jaydn Ott|Jaydon Blue|Jaylen Waddle|Jaylen Warren|Jaylen Wright|Jaylin Lane|Jaylin Noel|Jeff Caldwell|Jelani Woods|Jeremiyah Love|Jeremy McNichols|Jeremy Ruckert|Jerome Ford|Jerry Jeudy|Jeshaun Jones|Jimmy Holiday|Jimmy Horn|Joe Burrow|Joe Fagnano|Joe Flacco|Joe Milton|Joe Royer|Joel Wilson|Joey Aguilar|Joey Slye|John Bates|John FitzPatrick|John Metchie|John Michael Gyllenborg|Johnny Mundt|Johnny Wilson|Jonah Coleman|Jonathan Mingo|Jonathan Taylor|Jonathon Brooks|Jonnu Smith|Jordan Addison|Jordan Hudson|Jordan James|Jordan Love|Jordan Mason|Jordan Moore|Jordan Waters|Jordan Watkins|Jordan Whittington|Jordyn Tyson|Joseph Manjack|Josh Allen|Josh Cameron|Josh Cuevas|Josh Downs|Josh Jacobs|Josh Johnson|Josh Kelly|Josh Oliver|Josh Pitsenberger|Josh Whyle|Josh Williams|Joshua Dobbs|Joshua Karty|Joshua Palmer|Joshua Simon|Julian Hicks|Julian Hill|Julius Chestnut|Justice Hill|Justin Fields|Justin Herbert|Justin Jackson|Justin Jefferson|Justin Joly|Justin Tucker|Justin Watson|Juwan Johnson|K.J. Osborn|KC Concepcion|Ka'imi Fairbairn|KaVontae Turpin|Kaden Davis|Kaden Wetjen|Kaelon Black|Kaleb Johnson|Kalel Mullings|Kalif Raymond|Kameron Johnson|Kansei Matsuzawa|Kayshon Boutte|Kaytron Allen|Ke'Shawn Williams|KeAndre Lambert-Smith|Keaton Mitchell|Kedon Slovis|Keenan Allen|Keleki Latu|Kendall Milton|Kendre Miller|Kendrick Bourne|Kendrick Law|Kene Nwangwu|Kenneth Walker|Kenny Fletcher|Kenny Gainwell|Kenny Pickett|Kenny Yeboah|Kentrel Bullock|Kenyon Sadiq|Keon Coleman|Kevin Austin|Kevin Coleman|KhaDarel Hodge|Khalil Dinkins|Khalil Herbert|Khalil Shakir|Kimani Vidal|Kirk Cousins|Ko Kieft|Kolbe Katsis|Konata Mumpfield|Kurtis Rourke|Kyle Allen|Kyle Dixon|Kyle Juszczyk|Kyle McCord|Kyle Monangai|Kyle Pitts|Kyle Trask|Kyle Williams|Kylen Granson|Kyler Murray|Kyren Williams|Ladd McConkey|Lake McRee|Lamar Jackson|Lan Larison|Laquon Treadwell|LeQuint Allen|Lew Nichols|Lewis Bond|Lil'Jordan Humphrey|Lucas Krull|Lucas Scott|Lucky Jackson|Luke Altmyer|Luke Farrell|Luke Grimm|Luke McCaffrey|Luke Musgrave|Luke Schoonmaker|Luther Burden|Mac Jones|Mack Hollins|Makai Lemon|Malachi Corley|Malachi Fields|Malik Benson|Malik Davis|Malik McClain|Malik Nabers|Malik Washington|Malik Willis|MarShawn Lloyd|Marcus Mariota|Mark Andrews|Mark Redman|Marlin Klein|Marquez Valdes-Scantling|Marvin Harrison|Marvin Mims|Mason Rudolph|Mason Taylor|Mason Tipton|Matt Gay|Matt Hibner|Matt Lauter|Matthew Caldwell|Matthew Golden|Matthew Stafford|Max Bredeson|Max Brosmer|Max Hurleman|Max Klare|Mecole Hardman|Michael Bandy|Michael Briscoe|Michael Burton|Michael Carter|Michael Mayer|Michael Penix|Michael Pittman|Michael Trigg|Michael Wilson|Michael Wortham|Mike Evans|Mike Gesicki|Mike Washington|Miles Kitselman|Mitchell Evans|Mitchell Tinsley|Mitchell Trubisky|Mo Alie-Cox|Moliki Matavao|Montorie Foster|Myles Montgomery|Myles Price|Nate Adkins|Nate Boerkircher|Nate Carter|Nicholas Singleton|Nick DeGennaro|Nick Kallerup|Nick Mullens|Nick Muse|Nick Vannett|Nick Westbrook-Ikhine|Nico Collins|Nikko Remigio|Nikola Kalinic|Noah Fant|Noah Gray|Noah Thomas|Noah Whittington|Odell Beckham|Olamide Zaccheaus|Ollie Gordon|Omar Cooper|Omari Evans|Omarion Hampton|Oronde Gadsden|Oscar Delp|Owen Wright|Parker Washington|Pat Bryant|Pat Freiermuth|Patrick Gurd|Patrick Herbert|Patrick Mahomes|Patrick Murtagh|Patrick Ricard|Payne Durham|Pharaoh Brown|Phil Mafah|Phillip Dorsett|Pierre Strong|Princeton Fant|Puka Nacua|Qadir Ismail|Quentin Johnston|Quentin Moore|Quentin Skinner|Quez Watkins|Quincy Skinner|Quinn Ewers|Quinshon Judkins|Quintin Morris|RJ Harvey|Rachaad White|Raheim Sanders|Rashee Rice|Rasheen Ali|Rashid Shaheed|Rashod Bateman|Ray Davis|Reggie Gilliam|Reggie Virgil|Rhamondre Stevenson|Ricky Pearsall|Ricky White|Rico Dowdle|Riley Leonard|Riley Nowakowski|Riley Patterson|Robbie Ouzts|Robert Henry|Robert Tonyan|Roman Hemby|Roman Wilson|Rome Odunze|Romeo Doubs|Ronnie Bell|Ronnie Rivers|Roschon Johnson|Ryan Fitzgerald|Ryan Flournoy|Ryan Miller|Salvon Ahmed|Sam Darnold|Sam Ehlinger|Sam Hartman|Sam Howell|Sam LaPorta|Sam Roush|Samaje Perine|Samori Toure|Saquon Barkley|Savion Williams|Scott Matlock|Scotty Miller|Sean Clifford|Sean Tucker|Seth McGowan|Seydou Traore|Shane Buechele|Shawn Bowman|Shedeur Sanders|Shedrick Jackson|Simi Fehoko|Sincere McCormick|Sione Vaki|Skylar Thompson|Skyler Bell|Skyy Moore|Spencer Rattler|Spencer Shrader|Stefon Diggs|Stephen Carlson|Stephen Gosnell|Sterling Shepard|Stetson Bennett|T.J. Hockenson|Tahj Brooks|Tai Felton|Tank Bigsby|Tank Dell|Tanner Arkin|Tanner Conner|Tanner Hudson|Tanner Koziol|Tanner McKee|Tay Martin|Taylen Green|Teagan Quitoriano|Ted Hurst|Tee Higgins|Tejhaun Palmer|Terrance Ferguson|Terrell Jennings|Terry McLaurin|Tetairoa McMillan|Tez Johnson|Theo Johnson|Thomas Fidone|Thomas Gordon|Thomas Yassmin|Tim Jones|Tim Patrick|Tip Reiman|Tom Kennedy|Tommy DeVito|Tommy Tremble|Tony Pollard|Tory Horton|Travis Etienne|Travis Homer|Travis Hunter|Travis Kelce|Tre Tucker|Tre Watson|Tre' Harris|TreVeyon Henderson|Trebor Pena|Trent Sherfield|Trevor Etienne|Trevor Lawrence|Trey Benson|Trey Lance|Trey McBride|Trey Sermon|Trey Smack|Treylon Burks|Treyton Welch|Treyvhon Saunders|Troy Franklin|Tua Tagovailoa|Tucker Kraft|Tutu Atwell|Ty Chandler|Ty Johnson|Ty Pezza|Ty Simpson|Tyjae Spears|Tylan Wallace|Tyler Allgeier|Tyler Badie|Tyler Bass|Tyler Conklin|Tyler Goodson|Tyler Higbee|Tyler Huntley|Tyler Loop|Tyler Scott|Tyler Shough|Tyler Warren|Tyquan Thornton|Tyrell Shavers|Tyren Montgomery|Tyrod Taylor|Tyrone Tracy|Tyson Bagent|Van Jefferson|Velus Jones|Vinny Anthony|Wan'Dale Robinson|Wesley Grimes|Wil Lutz|Will Howard|Will Kacmarek|Will Levis|Will Mallory|Will Pauling|Will Reichard|Will Sheppard|Will Shipley|Woody Marks|Xavier Gipson|Xavier Guillory|Xavier Hutchinson|Xavier Legette|Xavier Restrepo|Xavier Smith|Xavier Weaver|Xavier Worthy|Zach Charbonnet|Zach Ertz|Zach Wilson|Zachariah Branch|Zaire Mitchell-Paden|Zamir White|Zavier Scott|Zavion Thomas|Zay Flowers|Zay Jones";

/* Built on first use, not on load, because most visits never paste. A surname
   shared by two players resolves only when both shorten to the same thing;
   otherwise it is left alone rather than guessed at. */
let SKILL_IDX = null;
function skillIndex() {
  if (SKILL_IDX) return SKILL_IDX;
  const last = {}, first = {}, pair = {};
  NFL_SKILL.split("|").forEach(full => {
    const bits = full.split(" ");
    const f = bits[0], l = nameKeyRaw(bits.slice(1).join(" "));
    if (!f || !l) return;
    const short = f[0].toUpperCase() + ". " + l;
    pair[nameKey(f) + " " + nameKey(l)] = short;
    (last[nameKey(l)] = last[nameKey(l)] || new Set()).add(short);
    (first[nameKey(f)] = first[nameKey(f)] || new Set()).add(short);
  });
  const only = m => { const o = {}; Object.keys(m).forEach(k => { if (m[k].size === 1) o[k] = [...m[k]][0]; }); return o; };
  SKILL_IDX = { pair: pair, last: only(last), first: only(first) };
  return SKILL_IDX;
}

const NAME_SUFFIX = /\s+(?:jr|sr|ii|iii|iv|v)\.?$/i;
function nameKeyRaw(s) { return String(s || "").replace(NAME_SUFFIX, "").trim(); }
function nameKey(s) { return String(s || "").toLowerCase().replace(/[^a-z]/g, ""); }

function titleCase(s) {
  return String(s).replace(/\S+/g, w =>
    /[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1));
}

/* How this group already writes a name wins, then the roster. A name the
   roster cannot pin down is left exactly as typed. */
function expandName(raw, idx) {
  const t = String(raw || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  const words = t.split(" ");
  let mine = null;
  if (words.length === 1) {
    mine = (idx || {})[t.toLowerCase().replace(/[^a-z'-]/g, "")] || null;
    // a one-word memory is no better than what he just typed, so let the
    // roster have a go before falling back to it
    if (mine && /\s/.test(mine)) return mine;
  }
  const S = skillIndex();
  if (words.length > 1) {
    const surname = nameKeyRaw(words.slice(1).join(" "));
    const exact = S.pair[nameKey(words[0]) + " " + nameKey(surname)];
    if (exact) return exact;
    const bySurname = S.last[nameKey(surname)];      // covers a misspelt first name
    if (bySurname) return bySurname;
  } else {
    if (S.last[nameKey(t)]) return S.last[nameKey(t)];
    if (S.first[nameKey(t)]) return S.first[nameKey(t)];
  }
  return mine || titleCase(t);
}

/* One loose line into the shape the app stores: who, direction, number, then
   what the number is about. Anything without a direction and a number, a
   spread or a moneyline, is left exactly as typed. */
function tidyPick(raw, idx) {
  let t = String(raw || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  t = t.replace(/\bATD\b/gi, "Anytime TD");
  if (/\banytime td\b/i.test(t))
    return (expandName(t.replace(/\banytime td\b/i, " ").trim(), idx) + " Anytime TD").trim();
  const dir = t.match(/\b(over|under)\b/i);
  const num = t.match(/\b(\d+(?:\.\d+)?)\b/);
  if (!dir || !num) return t;
  const name = t.slice(0, dir.index).trim();
  const after = t.slice(dir.index + dir[0].length).replace(num[1], " ");
  let market = "";
  for (const [re, label] of MARKETS) if (re.test(after)) { market = label; break; }
  const D = dir[1][0].toUpperCase() + dir[1].slice(1).toLowerCase();
  return [expandName(name, idx), D, num[1], market].filter(Boolean).join(" ");
}

/* The whole message. Returns one row per line, or null when the lines are not
   opened with initials, which leaves the slip reader to handle it. */
function parseInitialBlock(text, players, idx) {
  const byName = {};
  players.forEach(p => byName[p.toLowerCase()] = p);
  const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const out = [];
  for (const line of lines) {
    const m = line.match(/^([A-Za-z]{1,5})[\s.:,)-]+(\S.*)$/);
    if (!m) return null;
    const key = m[1].toLowerCase();
    const pre = players.filter(p => p.toLowerCase().startsWith(key));
    const who = byName[key] || PICK_INITIALS[key] || (pre.length === 1 ? pre[0] : null);
    if (!who) return null;
    out.push({ player: who, pick: tidyPick(m[2], idx) });
  }
  return out;
}

function cleanPickLine(t) {
  return t
    .replace(/^[•*]+\s*/, "")          // bullets
    .replace(/^\d+[.)]\s+/, "")             // "1." numbering
    .replace(/\s+/g, " ")
    .replace(/([+-])\s+(?=[\d.])/g, "$1")   // "Pittsburgh - 16.5" -> "Pittsburgh -16.5"
    .replace(/\bATD\b/gi, "Anytime TD")      // the shorthand the slip uses
    .trim();
}

/* ---------- filling in what the slip leaves out ---------- */

/* A total prints its venue and not its teams, which is the one thing the slip
   will not tell you. ESPN's public scoreboard knows which game was in that
   city that day. No key, and it answers CORS, so the page can ask directly. */
const ESPN_PATH = { cfb: "college-football", nfl: "nfl" };
const SCORE_CACHE = {};

async function espnGames(dateIso, league) {
  const path = ESPN_PATH[league] || ESPN_PATH.cfb;
  const d = String(dateIso || "").replace(/-/g, "");
  if (!/^\d{8}$/.test(d)) return [];
  const key = path + d;
  if (SCORE_CACHE[key]) return SCORE_CACHE[key];

  const url = "https://site.api.espn.com/apis/site/v2/sports/football/" + path +
              "/scoreboard?dates=" + d +
              (path === "college-football" ? "&groups=80&limit=200" : "");
  const res = await fetch(url);
  if (!res.ok) throw new Error("scores " + res.status);
  const j = await res.json();

  const games = (j.events || []).map(e => {
    const c = (e.competitions || [])[0] || {};
    const at = (c.venue || {}).address || {};
    const sides = (c.competitors || []).map(t => ({
      name: (t.team || {}).shortDisplayName || (t.team || {}).displayName || "",
      score: Number(t.score || 0)
    }));
    return {
      city: at.city || "",
      teams: sides.map(s => s.name).filter(Boolean),
      total: sides.reduce((n, x) => n + x.score, 0),
      final: !!(((c.status || {}).type || {}).completed)
    };
  });
  SCORE_CACHE[key] = games;
  return games;
}

/* "Under 59.5 (Atlanta)" becomes "Tennessee/Syracuse Under 59.5", so the leg
   reads like every other one. A city nobody played in that day is left alone
   rather than guessed at. */
async function nameVenueTotals(picks, dateIso, league) {
  const list = (picks || []).slice();
  if (!list.some(p => /\([^)]+\)\s*$/.test(p))) return list;

  let games = [];
  try { games = await espnGames(dateIso, league); } catch (e) { return list; }
  if (!games.length) return list;

  return list.map(p => {
    const m = p.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (!m) return p;
    const city = m[2].trim().toLowerCase();
    const g = games.find(x => x.city && x.city.toLowerCase() === city);
    if (!g || g.teams.length !== 2) return p;
    return g.teams.join("/") + " " + m[1].trim();
  });
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
    if (r === "W") rec.w++; else if (r === "L") rec.l++; else if (r === "T") rec.t++;
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

/* No leg lost, and at least one won. A push rides along without killing it. */
function isParlay(data, entry) {
  const res = data.players.map(p => (entry.picks[p] || {}).result);
  return res.some(r => r === "W") && res.every(r => r === "W" || r === "T");
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
    all: overallRec(data, p),
    streak: playerStreak(data, p)
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

    /* A run of two or more colours the name and hangs a small W3 / L2 on it,
       so whoever opens the picture sees who is hot and who is cold without
       counting rows. */
    const sc = streakColor(r.streak, C);
    ctx.textAlign = "left";
    ctx.fillStyle = sc || C.text;
    ctx.font = cardFont(sc ? 700 : 600, 34);
    ctx.fillText(r.name, tx + 30, mid);
    if (sc) {
      const nx = tx + 30 + ctx.measureText(r.name).width + 12;
      const tag = (r.streak > 0 ? "W" : "L") + Math.abs(r.streak);
      ctx.font = cardFont(800, 20);
      const tw2 = ctx.measureText(tag).width + 16;
      ctx.fillStyle = r.streak > 0 ? "#12341f" : "#351511";
      roundRect(ctx, nx, mid - 15, tw2, 30, 8);
      ctx.fill();
      ctx.textAlign = "center";
      ctx.fillStyle = sc;
      ctx.fillText(tag, nx + tw2 / 2, mid + 1);
    }

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
  rows.forEach(r => { if (r.result === "W") w++; else if (r.result === "L") l++;
                      else if (r.result !== "T") pend++; });

  /* The odds ride at the top of the card when they were logged. When they
     were not, the line is dropped and the header simply closes up. */
  const stake = Number(data.stake) > 0 ? Number(data.stake) : 5;
  const oddsLine = fmtOdds(entry.odds);

  const rowH = r => (r.lines.length > 1 ? 128 : 96);
  const tableY = pad + (oddsLine ? 186 : 150);
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
  if (oddsLine) {
    ctx.fillStyle = C.gold;
    ctx.font = cardFont(750, 32);
    ctx.fillText(oddsLine, pad, pad + 142);
  }

  /* A slate with a leg left to run is a live parlay, and says so at the top.
     Once every leg is settled there is nothing live about it. */
  ctx.textAlign = "right";
  ctx.fillStyle = pend ? C.gold : C.dim;
  ctx.font = cardFont(800, pend ? 26 : 22);
  ctx.fillText(pend ? "LIVE PARLAY" : "FINAL", W - pad, pad + 26);
  // before kickoff there is nothing to report but the number of legs
  if (w + l === 0) {
    ctx.fillStyle = C.text;
    ctx.font = cardFont(700, 40);
    ctx.fillText(rows.length + " LEGS", W - pad, pad + 78);
  } else {
    ctx.fillStyle = w > l ? C.win : l > w ? C.loss : C.text;
    ctx.font = cardFont(700, 52);
    ctx.fillText(w + "-" + l, W - pad, pad + 74);
    if (pend) {
      ctx.fillStyle = C.gold;
      ctx.font = cardFont(600, 22);
      ctx.fillText(pend + (pend === 1 ? " leg" : " legs") + " to play", W - pad, pad + 118);
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
    if (r.result === "W" || r.result === "L" || r.result === "T") {
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
  ctx.textAlign = "left";
  ctx.fillStyle = C.dim;
  ctx.font = cardFont(500, 24);
  ctx.fillText(String(siteUrl || "").replace(/^https?:\/\//, "").replace(/\/$/, ""), pad, footY);

  ctx.textAlign = "right";
  ctx.font = cardFont(700, 26);
  ctx.fillStyle = C.muted;
  // the header already carries the price when there is one
  if (!oddsLine) ctx.fillText(fmtMoney(stake) + " parlay", W - pad, footY);

  return cv;
}

/* The season table on its own, for sending round midweek when there is no
   weekend to report: where everyone stands, who is hot, who is cold, the
   parlays that cashed and the money on the year. */
function buildStandingsCard(data, siteUrl) {
  const C = CARD;
  const pad = C.pad, W = C.w;
  const nameW = 300, colW = 165, cols = 4;
  const tx = pad, tw = nameW + colW * cols;          // 300 + 660 = 960
  const colX = i => tx + nameW + colW * i;
  const colMid = i => colX(i) + colW / 2;

  const rows = data.players.map(p => ({
    name: p,
    cfb: seasonRec(data, p, "cfb"),
    nfl: seasonRec(data, p, "nfl"),
    all: overallRec(data, p),
    streak: playerStreak(data, p)
  })).sort((a, b) => {
    const pa = pct(a.all), pb = pct(b.all);
    return (pb - pa) || (b.all.w - a.all.w) || a.name.localeCompare(b.name);
  });

  let gw = 0, gl = 0, gp = 0;
  data.entries.forEach(e => data.players.forEach(p => {
    const r = (e.picks[p] || {}).result;
    if (r === "W") gw++; else if (r === "L") gl++; else if (r === "P") gp++;
  }));

  let hits = 0, done = 0;
  data.entries.forEach(e => {
    const t = tally(data, e);
    if (t.w + t.l + t.t !== data.players.length) return;
    done++;
    if (t.l === 0) hits++;
  });

  const money = moneyFor(data);
  const ladder = ladderColors(rows.map(r => r.all));

  const tileY = pad + 150, tileH = 110;
  const tableY = tileY + tileH + 26;
  const headH = 84, rowH = 92;
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
  const yr = String(data.season || "").trim();
  ctx.fillText(yr ? yr + " standings" : "Season standings", pad, pad + 92);

  ctx.textAlign = "right";
  ctx.fillStyle = C.dim;
  ctx.font = cardFont(600, 22);
  ctx.fillText(data.entries.length + (data.entries.length === 1 ? " SLATE" : " SLATES"), W - pad, pad + 26);
  ctx.fillStyle = gw > gl ? C.win : gl > gw ? C.loss : C.text;
  ctx.font = cardFont(700, 52);
  ctx.fillText(gw + "-" + gl, W - pad, pad + 74);
  if (gp) {
    ctx.fillStyle = C.gold;
    ctx.font = cardFont(600, 24);
    ctx.fillText(gp + " still in play", W - pad, pad + 122);
  }

  /* ---- the two numbers everyone asks about ---- */
  const tile = (x, w, lab, val, color, foot) => {
    ctx.fillStyle = C.panel;
    roundRect(ctx, x, tileY, w, tileH, 20);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.fillStyle = C.dim;
    ctx.font = cardFont(750, 20);
    ctx.fillText(lab, x + 26, tileY + 30);
    ctx.fillStyle = color;
    ctx.font = cardFont(800, 44);
    ctx.fillText(val, x + 26, tileY + 72);
    if (foot) {
      ctx.fillStyle = C.dim;
      ctx.font = cardFont(500, 20);
      ctx.fillText(foot, x + 26, tileY + 96);
    }
  };
  const halfW = (tw - 18) / 2;
  tile(tx, halfW, "PARLAY WINS", String(hits),
       hits ? C.win : C.text, done ? "of " + done + " settled" : "nothing settled yet");
  tile(tx + halfW + 18, halfW, "ON THE YEAR", fmtMoney(money.net),
       money.net > 0 ? C.win : money.net < 0 ? C.loss : C.text,
       fmtMoney(money.wagered) + " in" + (money.unpriced ? ", " + money.unpriced + " unpriced" : ""));

  /* ---- the table ---- */
  ctx.fillStyle = C.panel;
  roundRect(ctx, tx, tableY, tw, tableH, 24);
  ctx.fill();

  ctx.textAlign = "center";
  ctx.fillStyle = C.dim;
  ctx.font = cardFont(600, 19);
  ["NCAA", "NFL", "TOTAL", "WIN %"].forEach((h, i) => ctx.fillText(h, colMid(i), tableY + 50));

  ctx.fillStyle = C.line;
  ctx.fillRect(tx, tableY + headH, tw, 1);

  rows.forEach((r, i) => {
    const y = tableY + headH + i * rowH;
    const mid = y + rowH / 2;
    if (i) { ctx.fillStyle = C.line; ctx.fillRect(tx + 24, y, tw - 48, 1); }

    ctx.textAlign = "left";
    ctx.fillStyle = C.dim;
    ctx.font = cardFont(600, 24);
    ctx.fillText(String(i + 1), tx + 28, mid);

    /* On this card the colour is spent on two things only: the run tag and the
       overall record. The name and the league splits stay plain so the eye is
       not pulled five ways at once. */
    const sc = streakColor(r.streak, C);
    ctx.fillStyle = C.text;
    ctx.font = cardFont(600, 34);
    ctx.fillText(r.name, tx + 66, mid);
    if (sc) {
      const nx = tx + 66 + ctx.measureText(r.name).width + 12;
      const tag = (r.streak > 0 ? "W" : "L") + Math.abs(r.streak);
      ctx.font = cardFont(800, 20);
      const tagW = ctx.measureText(tag).width + 16;
      ctx.fillStyle = r.streak > 0 ? C.winBg : C.lossBg;
      roundRect(ctx, nx, mid - 15, tagW, 30, 8);
      ctx.fill();
      ctx.textAlign = "center";
      ctx.fillStyle = sc;
      ctx.fillText(tag, nx + tagW / 2, mid + 1);
    }

    const rec = (rc, k) => {
      const played = rc.w + rc.l;
      ctx.textAlign = "center";
      ctx.fillStyle = played ? C.text : C.dim;
      ctx.font = cardFont(600, 27);
      ctx.fillText(played ? fmtRec(rc) : "—", colMid(k), mid);
    };
    rec(r.cfb, 0);
    rec(r.nfl, 1);

    // the combined record sits on its rung of the ladder
    const c = ladder[i];
    const cx = colMid(2);
    if (c) {
      ctx.fillStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.13)`;
      roundRect(ctx, cx - 62, mid - 26, 124, 52, 14);
      ctx.fill();
    }
    ctx.textAlign = "center";
    ctx.fillStyle = c ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : C.dim;
    ctx.font = cardFont(800, 32);
    ctx.fillText(r.all.w + r.all.l ? fmtRec(r.all) : "—", cx, mid + 1);

    ctx.fillStyle = C.muted;
    ctx.font = cardFont(600, 25);
    ctx.fillText(r.all.w + r.all.l ? (pct(r.all) * 100).toFixed(0) + "%" : "—", colMid(3), mid);
  });

  /* ---- footer ---- */
  ctx.textAlign = "left";
  ctx.fillStyle = C.dim;
  ctx.font = cardFont(500, 24);
  ctx.fillText(String(siteUrl || "").replace(/^https?:\/\//, "").replace(/\/$/, ""), pad, footY);

  const hot = rows.filter(r => r.streak >= 2).length;
  const cold = rows.filter(r => r.streak <= -2).length;
  const note = [hot ? hot + " hot" : "", cold ? cold + " cold" : ""].filter(Boolean).join("   ");
  if (note) {
    ctx.textAlign = "right";
    ctx.fillStyle = C.muted;
    ctx.font = cardFont(700, 26);
    ctx.fillText(note, W - pad, footY);
  }

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
