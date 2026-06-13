#!/usr/bin/env node
// Track npm installs + GitHub stars for premiere-pro-agent
// Usage:
//   node scripts/track-installs.mjs            # human-readable
//   node scripts/track-installs.mjs --json     # machine-readable
//   node scripts/track-installs.mjs --watch    # poll every 5 min

const PKG = "premiere-pro-agent";
const REPO = "thedalbee/premiere-pro-agent";

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

async function snapshot() {
  const [day, week, month] = await Promise.all([
    fetchNpmRange("last-day"),
    fetchNpmRange("last-week"),
    fetchNpmRange("last-month"),
  ]);
  const repo = await fetchGithub();
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
    github: repo,
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
    console.log(`\n  recent 7 days:`);
    for (const d of npm.by_day) {
      const bar = "▇".repeat(Math.min(d.downloads, 40));
      console.log(`  ${d.day}  ${String(d.downloads).padStart(4)}  ${bar}`);
    }
  }
  console.log("");
}

const argv = new Set(process.argv.slice(2));

if (argv.has("--watch")) {
  while (true) {
    try {
      const snap = await snapshot();
      console.clear();
      printHuman(snap);
    } catch (e) {
      console.error("error:", e.message);
    }
    await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
  }
} else {
  const snap = await snapshot();
  if (argv.has("--json")) {
    console.log(JSON.stringify(snap, null, 2));
  } else {
    printHuman(snap);
  }
}
