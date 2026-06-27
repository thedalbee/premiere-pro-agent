# premiere-pro-agent

[English](README.md) | [한국어](README.ko.md)

本地 CLI，用于根据时间戳范围创建 Adobe Premiere Pro 剪辑序列。

`ppro` 负责处理 Premiere Pro 项目操作。你选择要移除的时间范围，并以
JSON 文件传入。

## 安装

```bash
npm install -g premiere-pro-agent
```

需要 Node.js 20 或更高版本。

## 基本用法

```bash
ppro doctor --json
ppro setup

ppro silence episode.mp4 --json
ppro transcribe episode.mp4 --language ko --json

ppro checkpoint --json
ppro cut episode.mp4 --remove episode.removals.json --json
```

`ppro cut` 从 JSON 文件读取要移除的时间范围。该文件可以是数组，也可以
是带有 `ranges` 字段的对象。

```json
{
  "ranges": [
    { "start": 12.1, "end": 14.5 },
    { "start": 88.0, "end": 91.3 }
  ]
}
```

编辑已打开的 Premiere Pro 项目时，请先运行 `ppro checkpoint`，再运行
`ppro cut`。

## 说明

本项目与 Adobe 无关联，也未获得 Adobe 认可。

## 许可证

MIT
