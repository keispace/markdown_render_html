# Markdown Render HTML

## 1. 목적

- `render-doc-html.ts`를 **md/json 문서 트리 -> 단일 HTML 문서 사이트** 변환용 범용 스크립트로 쓴다.
- 이 문서는 스크립트 사용 설명서이며, redesign source tree 밖에 두어 output source와 분리한다.

## 2. 범위

- 입력 파일: `*.md`, `*.json`
- 출력 파일: `<name>.html` + 같은 basename의 `<name>.css` + `assets/*.js`
- 용도: 공유용 정적 문서 페이지
- 비목표:
  - 임의의 바이너리/첨부 자산 번들러
  - md/json 외 파일 포맷 직접 렌더러

## 3. CLI 옵션

| 옵션 | 의미 | 기본값 |
| --- | --- | --- |
| `--input <path>` | source root | `./` |
| `--output <path>` | output html path | `./output/index.html` |
| `--exclude <pattern>` | input root 기준 gitignore-style exclude pattern, 여러 번 지정 가능 | `_*.md`, `.*`, `**/.*/**` |
| `--title <text>` | HTML `<title>` + sidebar title | `Render Docs` |

## 4. 기본 동작

1. input root 아래에서 `*.md`, `*.json`을 재귀 수집한다.
2. exclude pattern에 걸리는 path는 디렉토리 단계부터 탐색/렌더 대상에서 제외한다.
3. markdown은 `marked`로 렌더하고, JSON은 `<pre><code class="language-json">` 블록으로 렌더한다.
4. 출력 시 inline CSS를 분리해 `<output basename>.css`로 저장한다.
5. Prism / Mermaid runtime JS는 render 시점에 jsDelivr에서 내려받아 `output/assets/*.js`로 저장하고, HTML은 그 로컬 asset을 참조한다.
6. sidebar는 **폴더 알파벳 순 -> 파일 알파벳 순**으로 정렬한다.

## 5. 문서 제목 / 라벨 규칙

- markdown 문서 title은 **첫 H1**을 쓴다.
- H1이 없으면 relative path를 fallback title로 쓴다.
- JSON artifact는 top-level `title`이 있으면 그 값을 쓰고, 없으면 filename을 humanize해서 쓴다.
- label이 어색하면 renderer 하드코딩으로 보정하지 않고 **파일명/폴더명/H1**을 수정해서 맞춘다.

## 6. 링크 규칙

### 6.1 지원하는 링크

- standard markdown link를 쓴다.
- 상대 경로 `.md` / `.json` 링크는 generated HTML에서 내부 anchor로 다시 쓴다.
- 확장자 없는 상대 링크도 `.md` -> `.json` 순으로 후보를 찾아 내부 anchor로 해석한다.
- 같은 문서 안의 `#fragment` 링크도 내부 heading anchor로 동작한다.
- `http(s):`, `mailto:`, `//`, 절대 경로(`/...`) 링크는 그대로 둔다.

### 6.2 authoring rule

- 문서 간 참조는 **plain path text가 아니라 markdown 링크**를 쓴다.
- 가능하면 `./foo.md#bar`처럼 **명시적인 상대 경로 + heading fragment**를 우선한다.
- 확장자 없는 링크도 지원하지만, source 가독성을 위해 `.md`를 명시하는 편이 낫다.
- exclude 대상 문서로 링크하면 output에서는 내부 anchor rewrite가 되지 않을 수 있으니, public output에서 노출할 링크는 포함 대상 문서를 가리키게 유지한다.

## 7. heading / id 규칙

- section id는 relative path를 unicode-safe slug로 바꿔 만든다.
- heading fragment는 `github-slugger` 기준으로 계산해 source markdown fragment와 output anchor를 맞춘다.
- 파일명/H1에 한글이 있어도 internal anchor 충돌 가능성을 줄이는 방향으로 동작한다.

## 8. 코드블록 / 다이어그램

- 일반 코드블록은 copy button이 붙는다.
- Prism client-side highlighting을 사용한다.
- Prism / Mermaid runtime은 output의 local `assets/*.js`를 참조한다.
- ```` ```mermaid ```` fenced block은 Mermaid runtime으로 SVG diagram으로 렌더한다.
- Mermaid render 실패 시 source `pre`를 fallback으로 다시 보여준다.

## 9. UI 기능

- sidebar navigation
- single doc / all docs mode
- prev / next navigation
- internal hash navigation
- copy button
- light / dark / system theme
- narrow viewport drawer sidebar

## 10. 예시

### 10.1 범용 기본 실행

```bash
cd /path/to/docs
deno run -A /path/to/markdown_render_html/render-doc-html.ts
```

생성물:

- `./output/index.html`
- `./output/index.css`
- `./output/assets/*.js`

### 10.2 커스텀 출력

```bash
deno run -A /path/to/markdown_render_html/render-doc-html.ts \
  --input ./docs \
  --output ./site/index.html \
  --exclude index.md \
  --exclude '**/private/**' \
  --title 'Project Docs'
```

### 10.3 현재 redesign preset

```bash
deno run -A /Users/evankim/dev/git/newnal/newnal-supabase/script/markdown_render_html/render-doc-html.ts \
  --input /Users/evankim/dev/git/newnal/newnal-supabase/.ai/plans/redesign \
  --output /Users/evankim/dev/git/newnal/newnal-supabase/.ai/plans/redesign/output/index.html \
  --exclude index.md \
  --exclude '**/artifacts/asis/**' \
  --title 'Redesign Docs'
```

## 11. 내부 문서 작성 규칙

- output에 싣고 싶지 않은 internal note는 `_*.md`로 둔다.
- dot hidden path(`.foo`, `.bar/...`)는 기본 제외다.
- md/json 외 source는 직접 렌더하지 않는다. 필요하면 md에 감싸서 넣는다.
- 범용 동작을 깨는 프로젝트별 label/sort 예외는 renderer에 하드코딩하지 않는다.

## 12. 현재 한계

- runtime page는 local asset만 쓰지만, render 시점에는 Prism / Mermaid JS를 jsDelivr에서 내려받으므로 **build network access**가 필요하다.
- md/json 외 파일 포맷은 직접 렌더하지 않는다.
- exclude/unresolved local link에 대한 별도 warning report는 아직 없다.
