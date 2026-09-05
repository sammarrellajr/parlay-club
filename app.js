/* Shared config, data loading, and stats for the Parlay Club dashboard. */

// Optional manual override. Leave blank to auto-detect from the GitHub Pages URL.
const CONFIG = {
  owner: "",   // e.g. "sammarrella"
  repo: "",    // e.g. "parlay-club"
  branch: "main",
  file: "results.json"
};

const DEFAULT_PLAYERS = ["Drew", "Pat", "Sam", "Tim", "Tyler"];
const LEAGUES = [
  { key: "cfb", label: "College", full: "College Football" },
  { key: "nfl", label: "NFL", full: "NFL" }
];

/* ---------- repo detection ---------- */

function detectRepo() {
  if (CONFIG.owner && CONFIG.repo) {
    return { owner: CONFIG.owner, repo: CONFIG.repo, branch: CONFIG.branch };
  }
  const host = location.hostname || "";
  const m = host.match(/^([^.]+)\.github\.io$/i);
  if (m) {
    const owner = m[1];
    const seg = location.pathname.split("/").filter(Boolean);
    // Project page: owner.github.io/repo/...  User page: owner.github.io/...
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

function normalize(data) {
  const d = data && typeof data === "object" ? data : {};
  const players = Array.isArray(d.players) && d.players.length ? d.players : DEFAULT_PLAYERS.slice();
  const weeks = (Array.isArray(d.weeks) ? d.weeks : []).map(w => ({
    id: w.id || w.label || Math.random().toString(36).slice(2),
    label: w.label || w.id || "Untitled week",
    start: w.start || "",
    end: w.end || "",
    entries: w.entries && typeof w.entries === "object" ? w.entries : {}
  }));
  weeks.sort((a, b) => String(a.start || a.id).localeCompare(String(b.start || b.id)));
  return { players, season: d.season || "", weeks };
}

/* ---------- stats ---------- */

function blankRec() { return { w: 0, l: 0 }; }

function computeStats(data) {
  const per = {};
  data.players.forEach(p => {
    per[p] = { name: p, cfb: blankRec(), nfl: blankRec(), all: blankRec(), history: [] };
  });

  const group = { cfb: blankRec(), nfl: blankRec(), all: blankRec() };
  const weekSummaries = [];

  data.weeks.forEach(week => {
    const summary = { id: week.id, label: week.label, start: week.start, w: 0, l: 0, perfect: true, counted: 0 };
    data.players.forEach(p => {
      const e = week.entries[p] || {};
      const marks = [];
      LEAGUES.forEach(lg => {
        const leg = e[lg.key] || {};
        const res = leg.result === "W" ? "W" : leg.result === "L" ? "L" : null;
        marks.push(res);
        if (!res) { summary.perfect = false; return; }
        const bucket = res === "W" ? "w" : "l";
        per[p][lg.key][bucket] += 1;
        per[p].all[bucket] += 1;
        group[lg.key][bucket] += 1;
        group.all[bucket] += 1;
        summary[bucket] += 1;
        summary.counted += 1;
        if (res === "L") summary.perfect = false;
      });
      per[p].history.push({ weekId: week.id, label: week.label, marks });
    });
    weekSummaries.push(summary);
  });

  const rows = data.players.map(p => {
    const s = per[p];
    return {
      ...s,
      cfbPct: pct(s.cfb),
      nflPct: pct(s.nfl),
      allPct: pct(s.all)
    };
  });

  rows.sort((a, b) => (b.allPct - a.allPct) || (b.all.w - a.all.w) || a.name.localeCompare(b.name));

  return {
    rows,
    group,
    groupPct: { cfb: pct(group.cfb), nfl: pct(group.nfl), all: pct(group.all) },
    weekSummaries,
    perfectWeeks: weekSummaries.filter(w => w.counted > 0 && w.perfect).length,
    weeksLogged: data.weeks.length
  };
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

function unitsClass(n) { return n > 0 ? "good" : n < 0 ? "bad" : "even"; }

/* ---------- label helpers ---------- */

function mdy(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "";
  return `${m}/${d}`;
}

function weekendLabel(startIso, endIso) {
  const a = mdy(startIso), b = mdy(endIso);
  if (a && b) return `${a}-${b} Weekend`;
  if (a) return `${a} Weekend`;
  return "";
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
