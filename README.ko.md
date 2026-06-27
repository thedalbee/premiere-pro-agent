# premiere-pro-agent

[English](README.md) | [中文](README.zh-CN.md)

타임스탬프 범위로 Adobe Premiere Pro 컷 시퀀스를 만드는 로컬 CLI입니다.

`ppro`는 Premiere Pro 프로젝트 작업을 처리합니다. 사용자는 잘라낼 구간을
직접 고르고 JSON으로 전달합니다.

## 설치

```bash
npm install -g premiere-pro-agent
```

Node.js 20 이상이 필요합니다.

## 기본 사용

```bash
ppro doctor --json
ppro setup

ppro silence episode.mp4 --json
ppro transcribe episode.mp4 --language ko --json

ppro checkpoint --json
ppro cut episode.mp4 --remove episode.removals.json --json
```

`ppro cut`은 JSON 파일에서 제거할 구간을 읽습니다. 파일은 배열만 담아도
되고, `ranges` 키를 가진 객체여도 됩니다.

```json
{
  "ranges": [
    { "start": 12.1, "end": 14.5 },
    { "start": 88.0, "end": 91.3 }
  ]
}
```

열려 있는 Premiere Pro 프로젝트를 편집할 때는 `ppro cut`을 실행하기 전에
`ppro checkpoint`를 먼저 실행하세요.

## 참고

이 프로젝트는 Adobe와 관련이 없으며 Adobe의 보증을 받지 않습니다.

## 라이선스

MIT
