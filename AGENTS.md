# AGENTS.md — ppro agent reference

This is the driving contract for AI agents (Claude Code, Codex, Cursor, scripts) that
operate the `ppro` CLI to edit Adobe Premiere Pro timelines.

---

## Core chain

```
ppro transcribe <file>   →  <stem>.transcript.json   (word-level timestamps)
ppro silence <file>      →  <stem>.silence.json       (silent ranges)

  [agent reads both files and decides what to remove]

ppro checkpoint          →  ~/.ppro/checkpoints/<project>/<timestamp>.prproj
ppro cut <file> --remove <ranges.json>  →  <stem>.cut.json
```

**Division of labor:**
- `ppro` handles all mechanical Premiere interaction.
- The agent's job is to decide *which ranges to remove* by reasoning over the
  transcript and silence JSON. Dead air, failed retakes, filler words, and
  repeated sentences are judgment calls — `ppro` never makes them for you.

`transcribe` and `silence` can run in any order (or in parallel); neither
needs Premiere. Always `checkpoint` before `cut`.

---

## Premiere connection requirements

| Command      | Premiere must be running + plugin connected | Project must be open |
|---|---|---|
| `setup`      | No  | No  |
| `doctor`     | No  | No  |
| `status`     | No  | No  |
| `silence`    | No  | No  |
| `transcribe` | No  | No  |
| `checkpoint` | Yes | Yes |
| `cut`        | Yes (for project path lookup and sequence creation); or pass `--prproj` | Yes (unless `--prproj` is passed) |

`cut` closes the project file, patches it directly, then reopens it. If
Premiere is not connected, you must supply `--prproj <path.prproj>` and the
target sequence must already exist in that file.

---

## Exit codes

| Code | Constant         | Meaning | What the agent should do |
|---|---|---|---|
| 0    | `OK`             | Success | Continue |
| 1    | `FAILED`         | Operation failed (internal error, UPIA rejected install, plugin threw) | Read stderr, do not retry blindly |
| 2    | `USAGE`          | Bad arguments or missing file | Fix the command and retry |
| 3    | `NO_CONNECTION`  | Plugin not connected (status only — see note) | Ensure Premiere is open with the panel loaded |
| 4    | `MISSING_DEPENDENCY` | ffmpeg or mlx-whisper not found, or macOS not detected | Run `ppro doctor` and install what's missing |
| 5    | `VALIDATION`     | Build completed but post-build checks failed (clip count mismatch, gap detected, duration off) | Inspect `<stem>.cut.json` → `validation.failures`; restore from checkpoint if needed |

**Important: exit 3 is only emitted by `status`.** Other commands that need Premiere
throw exceptions when the plugin is absent, which the CLI catches and returns as
exit 1 (`FAILED`). Specifically:
- `checkpoint` with no Premiere → exit 1 (throws "no project open")
- `cut` with no Premiere and no `--prproj` → exit 2 (USAGE: "cannot determine .prproj path")
- `cut` with `--prproj` supplied but plugin disconnected → proceeds with inject; Premiere
  connection is optional when the project file path is known

Check `ppro status --json` to diagnose a connection problem when exit 1 occurs on
`checkpoint` or `cut`.

`doctor` returns exit 4 when any check has status `"fail"` (not exit 1).

---

## --json contract

Every command accepts `--json`. When used:

- **stdout** is pure JSON, pretty-printed (`null` if there is nothing to report).
- **stderr** carries all progress notes and human-readable messages.
- The top-level object always contains `"ok": true | false`.

Parse stdout; ignore stderr. Never scrape stderr for structured data.

### Output shapes

**`ppro silence --json`**
```json
{
  "ok": true,
  "output": "/path/to/episode.silence.json",
  "count": 42,
  "totalSec": 87.3,
  "longestSec": 4.12,
  "silenceShare": 0.142,
  "speechSec": 524.7
}
```
Full detail is in `<stem>.silence.json`:
```json
{
  "source": "/abs/path/episode.mp4",
  "mediaDurationSec": 612.0,
  "settings": { "thresholdDb": -30, "minDurationSec": 0.5, "padLeadSec": 0.1, "padTailSec": 0.15 },
  "stats": { "count": 42, "totalSec": 87.3, "longestSec": 4.12, "silenceShare": 0.142, "speechSec": 524.7 },
  "ranges": [{ "start": 12.1, "end": 14.5, "duration": 2.4 }, ...]
}
```

**`ppro transcribe --json`**
```json
{
  "ok": true,
  "output": "/path/to/episode.transcript.json",
  "words": 3241,
  "language": "ko",
  "mediaDurationSec": 612.0,
  "transcribeSec": 43
}
```
Full detail is in `<stem>.transcript.json`:
```json
{
  "model": "mlx-community/whisper-large-v3-turbo",
  "language": "ko",
  "durationSec": 612.0,
  "words": [{ "text": "안녕하세요", "start": 0.24, "end": 0.72, "confidence": 0.9812 }, ...],
  "text": "full transcript text..."
}
```

**`ppro checkpoint --json`**
```json
{ "ok": true, "checkpointPath": "~/.ppro/checkpoints/MyProject/2026-06-13T12-00-00Z.prproj", "projectPath": "/path/MyProject.prproj" }
```

**`ppro cut --json`** (inject mode, default)
```json
{
  "ok": true,
  "mode": "inject",
  "media": "/abs/path/episode.mp4",
  "prproj": "/abs/path/MyProject.prproj",
  "sequence": "episode_CUT",
  "backup": "/abs/path/MyProject.prproj.bak",
  "debugFile": "...",
  "createdAt": "2026-06-13T12:00:00.000Z",
  "predicted": { "clips": 87, "durationSec": 524.7 },
  "actual": { "injected": 87, "objectsCreated": 520 },
  "validation": { "failures": [], "wellFormed": true, "allRefsResolved": true, "videoTrackItemCount": 87, "audioTrackItemCount": 87 }
}
```
`"ok": false` with `validation.failures` populated means exit 5.

**`ppro status --json`**
```json
{
  "ok": true,
  "daemon": { "version": "0.x.x", "protocol": 1, "pid": 12345 },
  "plugin": { "connected": true, "version": "0.x.x", "protocolMatches": true },
  "project": { "open": true, "name": "MyProject", "path": "/abs/path/MyProject.prproj", "sequenceCount": 3, "activeSequence": { "name": "MASTER" } }
}
```

**`ppro doctor --json`**
```json
{
  "ok": false,
  "checks": [
    { "name": "macOS", "status": "ok", "detail": "..." },
    { "name": "Premiere Pro", "status": "ok", "detail": "26.x — running" },
    { "name": "bridge", "status": "info", "detail": "port 7300 ..." },
    { "name": "ffmpeg", "status": "fail", "detail": "not found", "hint": "brew install ffmpeg" },
    { "name": "whisper", "status": "ok", "detail": "..." }
  ]
}
```
Status values: `"ok"` | `"info"` | `"fail"`. `"info"` is neutral (never causes exit 4).

---

## --remove format (cut)

`--remove` takes a **path to a JSON file**, not an inline range string. Pass it one or
more times to merge ranges from multiple sources:

```bash
ppro cut episode.mp4 --remove episode.silence.json --remove retakes.json
```

The file must contain either a bare array or an object with a `ranges` key:

```json
[{ "start": 12.1, "end": 14.5 }, { "start": 88.0, "end": 91.3 }]
```
```json
{ "ranges": [{ "start": 12.1, "end": 14.5 }] }
```

`start` and `end` are seconds (numbers). `end` must be greater than `start`.
The `.silence.json` output from `ppro silence` already matches the `{ ranges: [...] }`
shape — pass it directly.

---

## Output files and how they chain

| File | Produced by | Consumed by |
|---|---|---|
| `<stem>.silence.json` | `ppro silence` | agent (reasoning), `ppro cut --remove` |
| `<stem>.transcript.json` | `ppro transcribe` | agent (reasoning only — not passed to `cut`) |
| `<stem>.cut.json` | `ppro cut` | agent (validation check) |

The transcript is for the agent's reasoning only. `ppro cut` does not accept a
transcript file; the agent must convert its decisions into a ranges JSON file and pass
that via `--remove`.

---

## cut modes

`cut` has two modes:

**Inject (default):** Patches the `.prproj` XML directly without per-clip API calls.
Handles 1,000+ clips in seconds. Requires the project file path (auto-detected from
Premiere if connected, or pass `--prproj`). Creates a `.bak` file beside the prproj
before writing. After injection it reopens the project in Premiere and verifies clip
counts and XML integrity.

**Live (`--live`):** Places clips via the Premiere UXP API, one call per clip. Slower
and requires an active plugin connection. Supports `--template` (copy track mixer from
an existing sequence), `--overwrite` (clear V1/A1 before placing), and `--resume`
(skip clips already placed, for retry after interruption).

Use inject mode unless you specifically need live-mode features.

---

## Checkpoint policy

Run `ppro checkpoint` before every `cut`. The checkpoint:
- Saves the project in Premiere (so disk state matches Premiere state).
- Copies the `.prproj` to `~/.ppro/checkpoints/<project-name>/<timestamp>.prproj`.

To restore: close the project in Premiere, copy the checkpoint file over the original,
reopen. `ppro cut` auto-checkpoints in `--live` mode unless `--no-checkpoint` is passed.
In inject mode, it does not auto-checkpoint — do it explicitly.

---

## Silence detection defaults

| Flag | Default | Notes |
|---|---|---|
| `--threshold` | `-30` dB | Louder = more silence detected; adjust for noisy rooms |
| `--min-duration` | `0.5` s | Gaps shorter than this are ignored |
| `--pad-lead` | `0.1` s | Time kept after speech ends before the cut starts |
| `--pad-tail` | `0.15` s | Time kept before speech resumes after the cut ends |

Padding prevents cutting into breath sounds. The `.silence.json` `ranges` field
already has padding applied.

---

## Sequence naming

`cut` creates or targets a sequence named `<stem>_CUT` by default (where `<stem>` is
the media filename without extension). Override with `--sequence NAME`. If the sequence
does not exist, inject mode will attempt to create it via UXP before injecting.

---

## Typical agent session

```bash
# 1. Verify environment
ppro doctor --json

# 2. Check connection (needed for checkpoint and cut)
ppro status --json

# 3. Analyze the source file (no Premiere needed)
ppro silence episode.mp4 --json
ppro transcribe episode.mp4 --language ko --json

# 4. [Agent reads episode.silence.json and episode.transcript.json]
# [Agent writes its removal decisions to, e.g., episode.removals.json]

# 5. Snapshot before any destructive operation
ppro checkpoint --json

# 6. Build the cut
ppro cut episode.mp4 --remove episode.removals.json --sequence EPISODE_CUT --json

# 7. Check result
# Parse episode.cut.json → validation.failures
# If ok=false → restore checkpoint, revise removals, retry
```
