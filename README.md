# premiere-pro-agent

Local CLI for building Adobe Premiere Pro cut sequences from timestamp ranges.

`ppro` handles the mechanical Premiere Pro project operations. You choose the
ranges to remove and pass them as JSON.

## Install

```bash
npm install -g premiere-pro-agent
```

Requires Node.js 20 or newer.

## Basic use

```bash
ppro doctor --json
ppro setup

ppro silence episode.mp4 --json
ppro transcribe episode.mp4 --language ko --json

ppro checkpoint --json
ppro cut episode.mp4 --remove episode.removals.json --json
```

`ppro cut` reads removal ranges from a JSON file. The file can be a bare array
or an object with a `ranges` key:

```json
{
  "ranges": [
    { "start": 12.1, "end": 14.5 },
    { "start": 88.0, "end": 91.3 }
  ]
}
```

Run `ppro checkpoint` before `ppro cut` when editing an open Premiere Pro
project.

## Notes

This project is not affiliated with or endorsed by Adobe.

## License

MIT
