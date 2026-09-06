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

/* Count of picks still waiting on a game, per league. */
function pendingCount(data, league) {
  let n = 0;
  data.entries.forEach(e => {
    if (league && e.league !== league) return;
    data.players.forEach(p => { if (v_result(e, p) === "P") n++; });
  });
  return n;
}

function computeStats(data) {
  const per = {};
  data.players.forEach(p => {
    per[p] = { name: p, cfb: blankRec(), nfl: blankRec(), seq: { cfb: [], nfl: [] } };
  });

  const group = { cfb: blankRec(), nfl: blankRec() };
  const summaries = [];

  data.entries.forEach(e => {
    const s = { id: e.id, label: e.label, league: e.league, date: e.date, w: 0, l: 0, counted: 0, pending: 0, perfect: true };
    data.players.forEach(p => {
      const raw = v_result(e, p);
      // Pending and blank both sit out of the record and out of streaks.
      const res = raw === "W" || raw === "L" ? raw : null;
      per[p].seq[e.league].push(res);
      if (raw === "P") { s.pending += 1; s.perfect = false; return; }
      if (!res) { s.perfect = false; return; }
      const b = res === "W" ? "w" : "l";
      per[p][e.league][b] += 1;
      group[e.league][b] += 1;
      s[b] += 1;
      s.counted += 1;
      if (res === "L") s.perfect = false;
    });
    summaries.push(s);
  });

  const rows = data.players.map(p => {
    const s = per[p];
    return {
      ...s,
      cfbPct: pct(s.cfb),
      nflPct: pct(s.nfl),
      streak: { cfb: winStreak(s.seq.cfb), nfl: winStreak(s.seq.nfl) }
    };
  });

  return {
    rows,
    byLeague: { cfb: rankBy(rows, "cfbPct", "cfb"), nfl: rankBy(rows, "nflPct", "nfl") },
    leaders: { cfb: findLeaders(rows, "cfbPct", "cfb"), nfl: findLeaders(rows, "nflPct", "nfl") },
    group,
    groupPct: { cfb: pct(group.cfb), nfl: pct(group.nfl) },
    summaries,
    counts: {
      cfb: data.entries.filter(e => e.league === "cfb").length,
      nfl: data.entries.filter(e => e.league === "nfl").length
    },
    pending: { cfb: pendingCount(data, "cfb"), nfl: pendingCount(data, "nfl") }
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

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
