# Markdown Render HTML

[English README](./Readme.md)

`markdown_render_html`은 Markdown/JSON 문서 트리를 단일 정적 HTML 문서
사이트로 변환하는 Deno 기반 유틸리티입니다. 기본적으로 다음을 제공합니다.

- sidebar navigation
- single-doc / all-docs view mode
- 로컬 Markdown 링크의 내부 anchor 변환
- syntax highlighting
- Mermaid diagram 렌더링
- 코드블록 copy button
- light / dark / system theme

## 이 저장소에 들어있는 것

```text
markdown_render_html/
├── docs/
│   └── assets/index.png
├── sample/
│   ├── deploy-output.sh
│   └── docs/
│       ├── 00-overview.md
│       ├── data/profile.json
│       └── guide/getting-started.md
├── render-doc-html.ts
├── Readme.md
└── Readme_kr.md
```

이 저장소에는 renderer 자체와 로컬에서 바로 돌려볼 수 있는 작은 `sample/`
문서셋을 함께 둡니다. 프로젝트별 preset, deploy script, output 디렉토리는 이
스크립트를 사용하는 쪽 저장소에서 관리하는 것을 기본으로 합니다.

## 요구사항

- Deno 2.x
- 렌더 시 네트워크 접근 가능 환경
  - 첫 실행 시 Deno가 npm dependency를 내려받음
  - 렌더 시 Prism / Mermaid runtime JS를 `output/assets/`로 내려받음

## Deno 설치

### macOS / Linux

```bash
curl -fsSL https://deno.land/install.sh | sh
```

### Homebrew

```bash
brew install deno
```

### Windows PowerShell

```powershell
irm https://deno.land/install.ps1 | iex
```

### 설치 확인

```bash
deno --version
```

## 빠른 시작

```bash
git clone https://github.com/keispace/markdown_render_html.git
cd markdown_render_html

deno run -A ./render-doc-html.ts \
  --input /path/to/docs \
  --output /path/to/docs/output/index.html \
  --title "Project Docs"
```

생성물:

- `/path/to/docs/output/index.html`
- `/path/to/docs/output/index.css`
- `/path/to/docs/output/assets/*.js`

## 포함된 sample 실행

```bash
deno run -A ./render-doc-html.ts \
  --input ./sample/docs \
  --output ./sample/output/index.html \
  --title "Sample Docs"
```

렌더 후에는 브라우저에서 `./sample/output/index.html`을 열면 됩니다.

- 공개 URL이 필요하면 sample을 자신의 Surge 도메인으로 배포해서 사용하면 됩니다.
- 스크린샷:

![Sample Docs screenshot](./docs/assets/index.png)

렌더된 sample output을 Surge에 배포하려면:

```bash
printf '%s\n' 'your-project.surge.sh' > ./sample/output/CNAME
./sample/deploy-output.sh
```

스크립트는 `./sample/output/CNAME`에 들어 있는 도메인을 기준으로 `surge`를
실행합니다. `your-project.surge.sh` 부분은 자신의 Surge 도메인으로 바꿔서
사용하면 됩니다.

## CLI 옵션

| 옵션 | 의미 | 기본값 |
| --- | --- | --- |
| `--input <path>` | source root | `./` |
| `--output <path>` | output HTML 경로 | `./output/index.html` |
| `--exclude <pattern>` | gitignore-style exclude pattern, 반복 지정 가능 | `_*.md`, `.*`, `**/.*/**` |
| `--title <text>` | HTML `<title>` + sidebar title | `Render Docs` |

## 지원 입력 형식

- `*.md`
- `*.json`

그 외 형식은 직접 렌더하지 않습니다. 필요하면 Markdown 안에 감싸서 포함하는
방식으로 사용합니다.

## 기본 동작

1. input root 아래에서 Markdown/JSON 파일을 재귀 탐색합니다.
2. exclude pattern은 디렉토리 진입 전부터 적용합니다.
3. Markdown 문서는 첫 H1을 title로 사용합니다.
4. JSON 파일은 JSON code block으로 렌더합니다.
5. CSS는 별도 `.css` 파일로 분리합니다.
6. Prism / Mermaid runtime JS를 `output/assets/`에 내려받습니다.
7. 생성된 HTML은 외부 CDN이 아니라 로컬 asset만 참조합니다.

## 문서 작성 규칙

### 제목 / 라벨

- 각 Markdown 문서에는 명확한 H1을 두는 편이 좋습니다.
- sidebar label이 이상하면 renderer 하드코딩으로 보정하지 말고 파일명, 폴더명,
  H1을 수정해서 맞춥니다.

### 링크

- standard markdown link를 사용합니다.
- 가능하면 아래처럼 **명시적인 상대 경로 + heading fragment**를 씁니다.

```md
[Schema](./contract/schema.md#basic-structure)
```

- 로컬 `.md`, `.json` 링크는 output HTML에서 내부 anchor로 다시 씁니다.
- 확장자 없는 로컬 링크도 지원합니다.

```md
[Schema](./contract/schema)
```

- 외부 `http(s):`, `mailto:`, `//`, 절대 경로(`/...`) 링크는 그대로 둡니다.
- 내부 문서 anchor로 다시 쓰지 않은 링크는 새 창에서 엽니다.

### internal note

- 렌더에서 빼고 싶은 internal note는 `_*.md`로 둡니다.
- dot hidden path도 기본 제외됩니다.

## 코드블록 / Mermaid

- 일반 코드블록에는 copy button이 붙습니다.
- ```` ```mermaid ```` fenced block은 SVG diagram으로 렌더합니다.
- Mermaid 렌더 실패 시에는 원본 code block을 fallback으로 그대로 보여줍니다.

## 출력 결과

생성 사이트는 기본적으로 다음을 포함합니다.

- sidebar tree navigation
- single-doc / all-docs mode
- prev / next navigation
- internal hash navigation
- code copy buttons
- Prism highlighting
- Mermaid diagrams
- light / dark / system theme

## consumer repo에서의 예시

```bash
deno run -A /path/to/markdown_render_html/render-doc-html.ts \
  --input /path/to/docs \
  --output /path/to/docs/output/index.html \
  --exclude index.md \
  --exclude '**/private/**' \
  --title 'Project Docs'
```

## 배포 (선택)

이 renderer는 정적 파일만 생성하므로, 결과물은 아무 static host에나 올릴 수
있습니다. CLI로 빠르게 올리고 싶다면 [Surge](https://surge.sh/)가 생성된 output
디렉토리 하나를 바로 배포하기에 간단한 선택지입니다.

```bash
npm install --global surge
surge /path/to/docs/output your-project.surge.sh
```

위 명령은 생성된 `index.html`, `index.css`, `assets/` 디렉토리를 그대로 업로드합니다.

## 현재 한계

- 현재는 render 시점 네트워크 접근이 필요합니다.
- Markdown/JSON만 직접 렌더합니다.
- unresolved local link에 대한 별도 warning report는 아직 없습니다.
