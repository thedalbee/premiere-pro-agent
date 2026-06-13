# premiere-pro-agent

<p align="center">
  <img src="assets/logo.png" alt="premiere-pro-agent logo" width="200" />
</p>

> CLI that lets AI agents edit your Adobe Premiere Pro timeline.

`ppro` — one command to cut silence, build rough cuts, and verify timelines in Premiere Pro, driven by any AI agent (Claude Code, Codex, Cursor) or your own scripts.

<p align="center">
  <video src="https://github.com/user-attachments/assets/a6377eda-b02f-4186-9d7c-46269457fb44" controls></video>
</p>

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

- macOS on Apple Silicon (Windows support planned)
- Adobe Premiere Pro 25.0+ (tested on 26.x) with the Creative Cloud desktop app
- Node.js 20+
- For `transcribe` / `silence`: `ffmpeg` and Python with [`mlx-whisper`](https://github.com/ml-explore/mlx-examples) (`pip install mlx-whisper`)

`ppro doctor` checks all of this for you.

## Install

```bash
npm install -g premiere-pro-agent
ppro setup     # packages and installs the Premiere Pro panel via Adobe's plugin installer
```

Then restart Premiere Pro, open the **Premiere Pro Agent** panel (UXP plugins area), and verify:

```bash
ppro status    # daemon ✓, plugin connected ✓, open project info
```

## Quick start: a rough cut from a raw recording

```bash
# 1. Find silence in the source file
ppro silence ~/footage/episode.mp4 --min-duration 0.35

# 2. (Optional) word-level transcript for smarter cut decisions
ppro transcribe ~/footage/episode.mp4 --language ko

# 3. Snapshot the project before touching it
ppro checkpoint

# 4. Build the cut — removed ranges out, everything else placed gap-free
ppro cut ~/footage/episode.mp4 --sequence MY_CUT --remove 12.5-14.2 --remove 88.0-91.3
```

`cut` writes clips directly into the project file and verifies the result (clip counts, zero gaps, V/A alignment) before reporting success. Pass an empty sequence that already has your track mixer set up, and the cut inherits it.

## Commands

| Command | What it does |
|---|---|
| `ppro setup` | Install the bundled Premiere panel (one-time) |
| `ppro doctor` | Check the environment: Premiere, plugin bridge, ffmpeg, whisper |
| `ppro status` | Show daemon, plugin, and open project state |
| `ppro silence` | Find silent ranges to remove (ffmpeg, outputs `<stem>.silence.json`) |
| `ppro transcribe` | Transcribe media to word-level timestamps (local Whisper, no API key) |
| `ppro cut` | Cut ranges out of a media file into a Premiere sequence |
| `ppro checkpoint` | Save the project and snapshot the `.prproj` file |

All commands support `--json` for machine-readable output (progress goes to stderr).

## Using it from an AI agent

Tell your agent something like:

> Use the `ppro` CLI. Run `ppro silence` and `ppro transcribe` on `episode.mp4`, decide which ranges are dead air or failed retakes, then `ppro checkpoint` and `ppro cut` with those ranges. Always check the JSON output of each step.

The `--json` outputs are designed to be chained: `silence` and `transcribe` produce files an agent can reason over, and `cut` accepts the resulting decisions.

## How it works

```
your agent → ppro CLI → local daemon (127.0.0.1) → UXP panel → Premiere Pro
                          └─ direct .prproj writes for bulk timeline builds
```

The daemon starts automatically on first use. Bulk operations (like placing a thousand clips) bypass the automation API entirely: the project file is closed, patched, reopened, and verified — which is why builds take seconds instead of minutes and don't crash the scripting runtime.

## Roadmap

- Caption track placement (same direct-write technique)
- Creative Cloud Marketplace listing
- Windows support

## Disclaimer

Unofficial. Not affiliated with or endorsed by Adobe. "Adobe" and "Premiere Pro" are trademarks of Adobe Inc., used here only to describe compatibility.

## License

[MIT](LICENSE)
