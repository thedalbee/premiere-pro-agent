#!/usr/bin/env node
// Track npm installs + GitHub stars/traffic for premiere-pro-agent.
// Requires `gh auth login` for traffic endpoints (admin-only).
//
// Usage:
//   node scripts/track-installs.mjs            # human-readable
//   node scripts/track-installs.mjs --json     # machine-readable
//   node scripts/track-installs.mjs --watch    # poll every 5 min
//   node scripts/track-installs.mjs --log      # append to history.jsonl

import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "premiere-pro-agent";
const REPO = "thedalbee/premiere-pro-agent";
const HERE = dirname(fileURLToPath(import.meta.url));
const HISTORY = join(HERE, "..", ".tracking", "history.jsonl");
const SOCIAL_DOMAINS = {
  "threads.net": "Meta Threads",
  "threads.com": "Meta Threads",
  "twitter.com": "X / Twitter",
  "t.co": "X / Twitter",
  "x.com": "X / Twitter",
  "news.ycombinator.com": "Hacker News",
  "reddit.com": "Reddit",
  "out.reddit.com": "Reddit",
  "old.reddit.com": "Reddit",
  "lobste.rs": "Lobsters",
  "producthunt.com": "Product Hunt",
};

function ghToken() {
  try {
    return execSync("gh auth token", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function fetchNpmRange(range) {
  const r = await fetch(`https://api.npmjs.org/downloads/range/${range}/${PKG}`);
  if (r.status === 404) return { downloads: [], notIndexed: true };
  if (!r.ok) throw new Error(`npm api ${r.status}`);
  return r.json();
}

async function fetchGithub() {
  const r = await fetch(`https://api.github.com/repos/${REPO}`, {
    headers: { "User-Agent": "ppro-tracker" },
  });
  if (!r.ok) throw new Error(`github api ${r.status}`);
  const j = await r.json();
  return {
    stars: j.stargazers_count,
    forks: j.forks_count,
    watchers: j.subscribers_count,
    open_issues: j.open_issues_count,
  };
}

async function fetchTraffic(endpoint, token) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/traffic/${endpoint}`, {
    headers: {
      "User-Agent": "ppro-tracker",
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (r.status === 403 || r.status === 404) return null;
  if (!r.ok) throw new Error(`gh traffic ${endpoint} ${r.status}`);
  return r.json();
}

function classifyReferrer(name) {
  const key = name.toLowerCase();
  for (const [domain, label] of Object.entries(SOCIAL_DOMAINS)) {
    if (key === domain || key.endsWith("." + domain)) return label;
  }
  return null;
}

async function snapshot() {
  const [day, week, month] = await Promise.all([
    fetchNpmRange("last-day"),
    fetchNpmRange("last-week"),
    fetchNpmRange("last-month"),
  ]);
  const repo = await fetchGithub();
  const token = ghToken();
  let referrers = null;
  let views = null;
  let clones = null;
  if (token) {
    [referrers, views, clones] = await Promise.all([
      fetchTraffic("popular/referrers", token),
      fetchTraffic("views", token),
      fetchTraffic("clones", token),
    ]);
  }
  const sum = (data) => data.downloads.reduce((s, d) => s + d.downloads, 0);
  const notIndexed = day.notIndexed || week.notIndexed;

  return {
    timestamp: new Date().toISOString(),
    npm: {
      not_indexed: notIndexed,
      last_day: sum(day),
      last_week: sum(week),
      last_month: sum(month),
      by_day: week.downloads || [],
    },
    github: {
      ...repo,
      traffic: {
        available: token != null && referrers != null,
        referrers: referrers ?? [],
        views: views ?? null,
        clones: clones ?? null,
      },
    },
  };
}

function printHuman(snap) {
  const { npm, github, timestamp } = snap;
  console.log(`\n📦 premiere-pro-agent  @  ${timestamp}`);
  if (npm.not_indexed) {
    console.log(`  (npm-stat not indexed yet — wait 24-48h after publish)`);
  } else {
    console.log(`  installs/day    ${npm.last_day}`);
    console.log(`  installs/week   ${npm.last_week}`);
    console.log(`  installs/month  ${npm.last_month}`);
  }
  console.log(`\n⭐ github`);
  console.log(`  stars           ${github.stars}`);
  console.log(`  forks           ${github.forks}`);
  console.log(`  watchers        ${github.watchers}`);
  console.log(`  open issues     ${github.open_issues}`);
  if (!npm.not_indexed && npm.by_day.length) {
    console.log(`\n  installs (last 7d):`);
    for (const d of npm.by_day) {
      const bar = "▇".repeat(Math.min(d.downloads, 40));
      console.log(`  ${d.day}  ${String(d.downloads).padStart(4)}  ${bar}`);
    }
  }

  if (!github.traffic.available) {
    console.log(`\n  (gh traffic skipped — run 'gh auth login' for referrer/views data)`);
  } else {
    const v = github.traffic.views;
    const c = github.traffic.clones;
    console.log(`\n🌐 traffic (14d window)`);
    console.log(`  views           ${v?.count ?? 0}  (uniques ${v?.uniques ?? 0})`);
    console.log(`  clones          ${c?.count ?? 0}  (uniques ${c?.uniques ?? 0})`);

    if (github.traffic.referrers.length === 0) {
      console.log(`\n  referrers       (none yet — direct or unattributed traffic only)`);
    } else {
      console.log(`\n  referrers:`);
      for (const r of github.traffic.referrers) {
        const label = classifyReferrer(r.referrer);
        const tag = label ? `  ← ${label}` : "";
        const bar = "▇".repeat(Math.min(r.count, 40));
        console.log(
          `  ${r.referrer.padEnd(28)} ${String(r.count).padStart(4)} views (${String(r.uniques).padStart(3)} unique) ${bar}${tag}`,
        );
      }
    }

    if (v?.views?.length) {
      console.log(`\n  daily views:`);
      for (const day of v.views.slice(-7)) {
        const bar = "▇".repeat(Math.min(day.count, 40));
        console.log(
          `  ${day.timestamp.slice(0, 10)}  ${String(day.count).padStart(4)} (${String(day.uniques).padStart(3)})  ${bar}`,
        );
      }
    }
  }
  console.log("");
}

function logHistory(snap) {
  try {
    mkdirSync(dirname(HISTORY), { recursive: true });
    const compact = {
      t: snap.timestamp,
      npm_dy: snap.npm.last_day,
      npm_wk: snap.npm.last_week,
      npm_mo: snap.npm.last_month,
      stars: snap.github.stars,
      forks: snap.github.forks,
      views: snap.github.traffic.views?.count ?? null,
      v_uniques: snap.github.traffic.views?.uniques ?? null,
      clones: snap.github.traffic.clones?.count ?? null,
      c_uniques: snap.github.traffic.clones?.uniques ?? null,
      top_referrers: snap.github.traffic.referrers.slice(0, 5).map((r) => ({
        domain: r.referrer,
        views: r.count,
        uniques: r.uniques,
      })),
    };
    appendFileSync(HISTORY, JSON.stringify(compact) + "\n");
  } catch (e) {
    console.error("history log error:", e.message);
  }
}

const argv = new Set(process.argv.slice(2));

if (argv.has("--watch")) {
  while (true) {
    try {
      const snap = await snapshot();
      console.clear();
      printHuman(snap);
      if (argv.has("--log")) logHistory(snap);
    } catch (e) {
      console.error("error:", e.message);
    }
    await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
  }
} else {
  const snap = await snapshot();
  if (argv.has("--log")) logHistory(snap);
  if (argv.has("--json")) {
    console.log(JSON.stringify(snap, null, 2));
  } else {
    printHuman(snap);
  }
}
