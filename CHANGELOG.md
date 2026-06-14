# Changelog

All notable changes to `premiere-pro-agent` are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/). Versioning is
[SemVer](https://semver.org/) — while pre-1.0, a minor bump (0.1 → 0.2) means new
features with no breaking changes, and a patch means fixes only.

## [0.2.0] — Unreleased

> **Draft prepared 2026-06-14.** Not yet released. The cut is gated on (a) live
> verification of captions import and the `undo` destructive path, and (b) the
> current publishing pause. No breaking changes vs 0.1.0 — everything below is
> additive and defaults/output schemas are preserved.

### Added
- **`ppro cleanup`** — reports reclaimable caches (Whisper model dir, project
  checkpoints, Premiere media cache) with per-category sizes and the cost of
  removing each. Nothing is deleted without `--yes` **and** explicit category
  names (or `--all`); `--yes` on its own deletes nothing. Ephemeral temp is never
  a target.
- **`ppro gaps <transcript.json>`** — derives removal ranges from transcript word
  boundaries (gap between `word[i].end` and `word[i+1].start`), with no amplitude
  measurement. Output is `ppro cut --remove` compatible. The "transcript is truth"
  dead-air path.
- **`ppro silence --adaptive [--margin N]`** — restricts detection to the voice
  band (300–3400 Hz) and derives the threshold from the recording's own noise
  floor (5th-percentile per-window RMS + margin) instead of the fixed −30 dB.
  Off by default; `silence.json` output schema is unchanged.
- **`--dry-run`** for `cut` (and `undo`) — preview the planned build with no file
  changes.
- **Windows (experimental)** — platform-branched paths and a zero-dependency
  `.ccx` packaging route. Runtime is not yet verified on Windows hardware.
- First-run Whisper model-download UX for `transcribe`.
- Configurable Premiere-launch timeouts via `PPRO_REOPEN_TIMEOUT_MS`,
  `PPRO_RECONNECT_TIMEOUT_MS`, `PPRO_PROJECT_INFO_TIMEOUT_MS` (defaults unchanged).

### Changed
- After a destructive build, plugin reconnect now waits up to 180 s (was 30 s)
  and prints a liveness note every ~10 s, so a slowly-launching Premiere no longer
  triggers a false-alarm warning. The cut is already verified at the file level,
  so the longer wait carries no risk.
- Slow-launch reopen/reconnect messages reworded from alarming
  (`WARNING … failed`) to informational (`changes are saved … no manual action
  needed`). The `project.close` failure still warns — that one is a real problem.

### Security
- WS origin rejection available as opt-in, observe-only mode
  (`PPRO_ENFORCE_ORIGIN=1`); default stays observe-only until real UXP origins are
  confirmed from the bridge log.

### Notes / not yet shipped
- **Partial:** `silence --adaptive` is the dependency-free slice of the
  silence-VAD evolution. Silero VAD itself is **not** included (it needs a
  user-side install decision — torch vs onnxruntime — and an empirical check on a
  real recording).
- **Code-complete but not exposed in this version** (gated on live verification):
  the captions-inject library and the `undo` destructive-restore path. They are
  not reachable from the CLI in 0.2.0.

## [0.1.0] — 2026-06-12

### Added
- Initial public release. Rough-cut pipeline: `setup`, `doctor`, `status`,
  `transcribe`, `silence`, `cut`, `checkpoint`. Edits land via direct `.prproj`
  injection through a local daemon and a UXP panel, bypassing the flaky UXP API.
