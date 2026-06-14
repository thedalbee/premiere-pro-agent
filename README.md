# premiere-pro-agent

<p align="center">
  <video src="https://github.com/user-attachments/assets/a6377eda-b02f-4186-9d7c-46269457fb44" controls></video>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/premiere-pro-agent"><img alt="npm" src="https://img.shields.io/npm/v/premiere-pro-agent?color=cb3837&logo=npm"></a>
  <a href="https://www.npmjs.com/package/premiere-pro-agent"><img alt="downloads" src="https://img.shields.io/npm/dt/premiere-pro-agent?color=blue"></a>
  <a href="https://www.npmjs.com/package/premiere-pro-agent"><img alt="weekly" src="https://img.shields.io/npm/dw/premiere-pro-agent?color=blue&label=installs%2Fweek"></a>
  <a href="https://github.com/thedalbee/premiere-pro-agent/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/thedalbee/premiere-pro-agent?style=flat&logo=github"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/premiere-pro-agent?color=green"></a>
</p>

> CLI that lets AI agents edit your Adobe Premiere Pro timeline.

`ppro` — one command to cut silence, build rough cuts, and verify timelines in Premiere Pro, driven by any AI agent (Claude Code, Codex, Cursor) or your own scripts.

## Why

AI agents are great at deciding *what* to cut — they can read a transcript, find the silences, the retakes, the filler. They are terrible at *doing* it, because Premiere Pro has no scriptable surface an agent can drive reliably.

`ppro` closes that gap:

- **A real CLI, not a chat tool.** Deterministic commands with `--json` output and exit codes. Any agent (or cron job) can drive it.
- **Fast builds via direct `.prproj` writes.** A 1,100-clip rough cut lands in the timeline in seconds — no per-clip API calls, no flaky automation loops.
- **Verification built in.** Every build is checked clip-by-clip: no gaps, no overlaps, video/audio in sync. Checkpoints snapshot your project before changes.
- **100% local.** Localhost-only bridge, local Whisper transcription, no telemetry, no API keys, nothing leaves your machine.

## Cost

You pay for nothing new. If you already have **Adobe Premiere Pro** and an AI agent subscription (e.g. **Claude Code**), that's the entire bill — this tool and everything it uses (ffmpeg, local Whisper) is free and open source. No extra API costs.

## Requirements

- macOS (Apple Silicon) or Windows (experimental) — see [Platform support](#platform-support)
- Adobe Premiere Pro 25.6+ (tested on 26.x) with the Creative Cloud desktop app
- Node.js 20+
- `ffmpeg` (for `silence` / `transcribe`)
- For `transcribe`: Python with [`mlx-whisper`](https://github.com/ml-explore/mlx-examples) (`pip install mlx-whisper`) — **macOS Apple Silicon only**. On Windows, bring your own transcript and pass removal ranges to `ppro cut`.

`ppro doctor` checks all of this for you.

## Install

```bash
npm install -g premiere-pro-agent
ppro doctor          # verify environment (Premiere found, ffmpeg, whisper)
ppro setup           # package and install the UXP panel via Adobe's plugin installer
```

Then restart Premiere Pro and open the **Premiere Pro Agent** panel (via **Window > UXP > Premiere Pro Agent** — see [Troubleshooting](#troubleshooting) if you can't find it), then verify the full connection:

```bash
ppro status          # daemon ✓, plugin connected ✓, open project info
```

`ppro status` is the real green light. `ppro doctor` checks your environment; it does not check whether the panel is loaded.

## Quick start: a rough cut from a raw recording

```bash
# 1. Find silence in the source file
ppro silence ~/footage/episode.mp4 --min-duration 0.35

# 2. (Optional) word-level transcript for smarter cut decisions
ppro transcribe ~/footage/episode.mp4 --language ko

# 3. Snapshot the project before touching it
ppro checkpoint

# 4. Build the cut — pass a JSON file of ranges to remove (the silence.json from
#    step 1, or your own [{start,end}] / {ranges:[...]} list)
ppro cut ~/footage/episode.mp4 --sequence MY_CUT --remove episode.silence.json
```

`cut` writes clips directly into the project file and verifies the result (clip counts, zero gaps, V/A alignment) before reporting success. Pass an empty sequence that already has your track mixer set up, and the cut inherits it.

## Commands

| Command | What it does | Needs Premiere? |
|---|---|---|
| `ppro setup` | Install the bundled Premiere panel (one-time) | No |
| `ppro doctor` | Check the environment: Premiere app, ffmpeg, whisper | No |
| `ppro silence` | Find silent ranges to remove (ffmpeg, outputs `<stem>.silence.json`) | No |
| `ppro transcribe` | Transcribe media to word-level timestamps (local Whisper, no API key) | No |
| `ppro status` | Show daemon, plugin, and open project state | Plugin must be connected |
| `ppro checkpoint` | Save the project and snapshot the `.prproj` file | Plugin must be connected |
| `ppro cut` | Cut ranges out of a media file into a Premiere sequence | See note |

`cut` note: by default, `cut` patches the `.prproj` file directly (no live Premiere required if you pass `--prproj` and the target sequence already exists). It does need Premiere connected to *create* a missing sequence, or when using `--live` mode.

All commands support `--json` for machine-readable output (progress goes to stderr).

## Using it from an AI agent

Tell your agent something like:

> Use the `ppro` CLI. Run `ppro silence` and `ppro transcribe` on `episode.mp4`, decide which ranges are dead air or failed retakes, then `ppro checkpoint` and `ppro cut` with those ranges. Always check the JSON output of each step.

The `--json` outputs are designed to be chained: `silence` and `transcribe` produce files an agent can reason over, and `cut` accepts the resulting decisions.

## How it works

```
your agent → ppro CLI → daemon (127.0.0.1:7201) → UXP panel (ws:7300) → Premiere Pro
                          └─ direct .prproj writes for bulk timeline builds
```

The daemon starts automatically on first use and manages a WebSocket bridge to the UXP panel. Bulk operations (like placing a thousand clips) bypass the automation API entirely: the project file is closed, patched, reopened, and verified — which is why builds take seconds instead of minutes and don't crash the scripting runtime.

## Security

All communication stays on `127.0.0.1`. Nothing is sent to external servers:

- **Localhost-only bridge.** The daemon binds to `127.0.0.1:7201` (control) and `127.0.0.1:7300` (plugin WebSocket) — it never listens on a public interface. The bridge logs the Origin of every WebSocket upgrade (`~/.ppro/bridge-origins.log`) and can **reject browser web origins** (`http(s)://`) — the defense against DNS-rebinding / cross-site WebSocket hijacking. It ships in observe-only mode (logs, does not block) so an unverified setup is never locked out; set `PPRO_ENFORCE_ORIGIN=1` to enforce once the log confirms your plugin's Origin is non-http. (A daemon↔plugin token handshake is planned as additional hardening.)
- **No telemetry.** Zero usage data is collected. Stars and npm download counts are the only metrics tracked, and only by the platforms themselves.
- **No API keys required.** When used, transcription runs locally via `mlx-whisper` (macOS Apple Silicon). The tool never contacts a cloud STT service.
- **The maker cannot see your machine.** This tool has no remote-access surface. `ppro setup` is the only network-adjacent operation (it packages and installs a local `.ccx` file via Adobe's own installer — no download from this project's servers).
- **No postinstall scripts.** Installation is opt-in via `ppro setup`. Nothing runs automatically on `npm install`.

## FAQ

**Premiere Pro already has text-based editing and silence removal — why this?**

Premiere's built-in tools are GUI-only and manual. `ppro` gives those same results from the terminal — which means an AI agent can decide what to cut, run the command, verify the output JSON, and loop without you touching the mouse. It also means you can batch-process multiple files from a shell script.

**How is this different from AutoCut, TimeBolt, or Firecut?**

Those are paid GUI plugins that work inside Premiere's interface. `ppro` is:
- Free and open source (MIT)
- Terminal-native — any agent, script, or CI job can call it
- Designed for agent-driven workflows where the decision logic is in the agent, not a preset

**Will this work with agents other than Claude Code?**

Yes. Any tool that can run shell commands works — Codex, Cursor, Aider, a cron job, a Python script. The `--json` flag is there so anything can parse the output.

**Is this affiliated with Adobe?**

No. See [Disclaimer](#disclaimer).

## Troubleshooting

Start every bug report with `ppro doctor --json` and paste the output.

### Daemon port conflict — "port 7201 is held by another process"

The daemon's control port (7201) is occupied by a leftover process from a previous session.

```bash
lsof -nP -i :7201       # find what's holding the port
kill <PID>              # kill the old process if it's a stale ppro daemon
ppro status             # verify connection resumes
```

If `ppro status` reports "something answered on 7201 but it is not our daemon", a different application has taken the port. Identify it with the `lsof` command above and stop it.

### Panel not loading — "plugin not connected" after setup

`ppro doctor` passes, but `ppro status` shows the plugin is not connected.

1. Confirm Premiere Pro restarted **after** `ppro setup` completed.
2. Open the panel: in Premiere Pro, go to **Window > UXP > Premiere Pro Agent**. There is no "Extensions" submenu in modern Premiere — the panel lives in the UXP plugins area, not under Extensions.
3. The panel must be **visible on screen** (not just open in a tab) for the bridge to activate.
4. Run `ppro status` again.

If the panel appears in the menu but crashes on load, re-run `ppro setup` to reinstall.

### `ppro setup` fails — "UPIA reported failure: Failed to install, status = -267"

Error code -267 means `EXMAN_FAILED_INVALID_MANIFEST` — the plugin's manifest is rejected by Adobe's installer. This is a packaging bug; re-running `ppro setup` with the current version should fix it. If it persists, open an issue with your `ppro doctor --json` output and the full UPIA error text.

Separately, if `ppro setup` says "Adobe Unified Plugin Installer Agent not found", you need to install the [Adobe Creative Cloud desktop app](https://creativecloud.adobe.com/apps/download/creative-cloud) first.

### Daemon won't start — plugin shows "port 7300 not in use" in doctor

`ppro doctor` reports `port 7300 not in use` — this is normal (it means the daemon has not started yet, not that something is wrong). The daemon starts on demand the first time you run a command that needs it (`ppro status`, `ppro cut`, etc.).

If `ppro status` keeps failing after the first successful run, check for a stale process on 7201 (see above).

### Protocol mismatch — status shows "re-run `ppro setup`"

The daemon version and the installed panel version don't match. Run `ppro setup` again — it is idempotent and will reinstall to the current version.

## Platform support

| Capability | macOS (Apple Silicon) | Windows |
|---|---|---|
| `doctor` `setup` `status` `silence` `cut` `checkpoint` + caption injection | ✅ supported | 🧪 experimental |
| `transcribe` (local Whisper STT) | ✅ | ❌ — Apple-Silicon `mlx` only |

- **macOS (Apple Silicon)** is the primary, fully-exercised platform.
- **Windows** is **experimental**: platform branching, a dependency-free `.ccx` packager, and platform-aware `setup`/`doctor` are implemented and CI-tested on `windows-latest`, but the Windows + Premiere runtime (panel install, Premiere discovery, daemon spawn) is **not yet verified on real hardware**.
- `ppro transcribe` runs a local Apple-Silicon model and is **macOS-only**. On Windows, generate a transcript with any tool and pass removal ranges to `ppro cut`.
- `ppro doctor` reports exactly what your platform supports.

## Roadmap

- Caption track placement (same direct-write technique)
- Creative Cloud Marketplace listing
- Windows runtime hardening (experimental support already shipped — see [Platform support](#platform-support))

## Disclaimer

Unofficial. Not affiliated with or endorsed by Adobe. "Adobe" and "Premiere Pro" are trademarks of Adobe Inc., used here only to describe compatibility.

## License

[MIT](LICENSE)
