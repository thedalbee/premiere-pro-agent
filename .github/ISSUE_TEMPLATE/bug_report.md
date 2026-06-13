---
name: Bug report
about: Something broke. Start with `ppro doctor --json` so we can help fast.
title: ""
labels: bug
assignees: ""
---

<!--
First, please paste your environment. Almost every bug report needs it, and it
is one command:

    ppro doctor --json

Paste the full output below. (It reports your OS, Node version, whether Premiere
and ffmpeg/whisper were found — no personal data, no file contents.)
-->

## `ppro doctor --json` output

```json
PASTE HERE
```

## What did you run?

The exact `ppro` command(s), including flags:

```bash

```

## What happened?

Paste the full terminal output. If you used `--json`, paste that too. If a
command hung or crashed, say which one and at what step.

## What did you expect?

A short description of the expected result.

## Connection state (if relevant)

If the problem involves Premiere (status, checkpoint, live cut, captions),
paste:

```
ppro status --json
```

and confirm: did you restart Premiere **after** `ppro setup`, and is the
**Premiere Pro Agent** panel open and visible on screen?

## Anything else?

Screenshots, the contents of `~/.ppro/bridge-origins.log`, or other context.
