import {
  basename,
  dirname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import GithubSlugger from "npm:github-slugger@2.0.0";
import ignore from "npm:ignore@7.0.5";
import { marked } from "npm:marked@18.0.5";

type Options = {
  inputPath: string;
  outputPath: string;
  excludePatterns: string[];
  title: string;
};

type DocEntry = {
  absPath: string;
  relPath: string;
  title: string;
  sectionId: string;
  html: string;
};

type HeadingMeta = {
  depth: number;
  text: string;
  pathTexts: string[];
  anchorId: string;
  markdownFragment: string;
};

type SourceDoc = {
  absPath: string;
  relPath: string;
  title: string;
  sectionId: string;
  source: string;
  isJson: boolean;
  headings: HeadingMeta[];
};

type SourceDocLookupEntry = {
  sectionId: string;
  isJson: boolean;
  headingAnchorIds: Map<string, string>;
};

type TreeNode = {
  label: string;
  sortKey: string;
  href?: string;
  sectionId?: string;
  children: TreeNode[];
};

type RuntimeAssetSpec = {
  fileName: string;
  sourceUrl: string;
};

const DEFAULT_EXCLUDE_PATTERNS = [
  "_*.md",
  ".*",
  "**/.*/**",
];
const DEFAULT_TITLE = "Render Docs";
const RUNTIME_ASSET_DIR = "assets";
const RUNTIME_ASSET_SPECS: RuntimeAssetSpec[] = [
  {
    fileName: "prism.min.js",
    sourceUrl: "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js",
  },
  {
    fileName: "prism-json.min.js",
    sourceUrl:
      "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-json.min.js",
  },
  {
    fileName: "prism-bash.min.js",
    sourceUrl:
      "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-bash.min.js",
  },
  {
    fileName: "prism-typescript.min.js",
    sourceUrl:
      "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-typescript.min.js",
  },
  {
    fileName: "prism-yaml.min.js",
    sourceUrl:
      "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-yaml.min.js",
  },
  {
    fileName: "mermaid.min.js",
    sourceUrl:
      "https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.min.js",
  },
];

/*
CLI options:
- --input <path>: source document root 경로. 기본값은 현재 working directory(`./`)다.
- --output <path>: 출력 HTML 경로. 기본값은 현재 working directory의 `./output/index.html`이다.
- --exclude <pattern>: gitignore-style exclude pattern. 여러 번 지정 가능하다.
- --title <text>: HTML title / sidebar title. 기본값은 `Render Docs`다.

Default behavior:
- `*.md`, `*.json` 파일을 재귀적으로 수집한다.
- hidden dot path와 nested underscore-prefixed markdown 파일은 기본 exclude에 포함된다.
*/
function parseArgs(args: string[]): Options {
  let inputPath = resolve(Deno.cwd());
  let outputPath = resolve(Deno.cwd(), "output", "index.html");
  const excludePatterns = [...DEFAULT_EXCLUDE_PATTERNS];
  let title = DEFAULT_TITLE;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (
      arg === "--input" || arg === "--output" || arg === "--exclude" ||
      arg === "--title"
    ) {
      const next = args[i + 1];
      if (!next) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--input") {
        inputPath = resolve(Deno.cwd(), next);
      } else if (arg === "--output") {
        outputPath = resolve(Deno.cwd(), next);
      } else if (arg === "--exclude") {
        excludePatterns.push(next);
      } else {
        title = next;
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { inputPath, outputPath, excludePatterns, title };
}

function isExcludedPath(
  relPath: string,
  excludeMatcher: ReturnType<typeof createExcludeMatcher>,
  isDirectory: boolean,
): boolean {
  return excludeMatcher.ignores(relPath) ||
    (isDirectory && excludeMatcher.ignores(`${relPath}/`));
}

async function collectSourceFiles(
  dir: string,
  inputRoot: string,
  excludeMatcher: ReturnType<typeof createExcludeMatcher>,
): Promise<string[]> {
  const results: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const absPath = join(dir, entry.name);
    const relPath = normalizeDocRelPath(relative(inputRoot, absPath));
    if (isExcludedPath(relPath, excludeMatcher, entry.isDirectory)) {
      continue;
    }
    if (entry.isDirectory) {
      results.push(
        ...(await collectSourceFiles(absPath, inputRoot, excludeMatcher)),
      );
      continue;
    }
    if (
      entry.isFile &&
      (entry.name.endsWith(".md") || entry.name.endsWith(".json"))
    ) {
      results.push(absPath);
    }
  }
  return results;
}

function extractTitle(markdown: string, fallback: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? fallback;
}

function toSectionId(relPath: string): string {
  const slug = relPath
    .split("/")
    .map((segment) => toAnchorSlug(segment))
    .join("--");
  return `doc-${slug || "section"}`;
}

function toAnchorSlug(value: string): string {
  const slug = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[`"'‘’“”]/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "section";
}

function toHeadingId(relPath: string, pathTexts: string[]): string {
  const suffix = pathTexts.map((part) => toAnchorSlug(part)).join("--");
  return suffix ? `${toSectionId(relPath)}--${suffix}` : toSectionId(relPath);
}

function extractHeadings(markdown: string, relPath: string): HeadingMeta[] {
  const headings: HeadingMeta[] = [];
  const stack: string[] = [];
  const slugger = new GithubSlugger();
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;

  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        inFence = false;
      }
      continue;
    }

    if (inFence) {
      continue;
    }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (!headingMatch) {
      continue;
    }

    const depth = headingMatch[1].length;
    const text = headingMatch[2].replace(/\s+#+\s*$/, "").trim();
    if (!text) {
      continue;
    }

    stack[depth - 1] = text;
    stack.length = depth;

    if (depth === 1) {
      continue;
    }

    const pathTexts = stack.slice(1);
    const markdownFragment = slugger.slug(text);
    headings.push({
      depth,
      text,
      pathTexts,
      anchorId: toHeadingId(relPath, pathTexts),
      markdownFragment,
    });
  }

  return headings;
}

function titleCaseWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function humanizeText(text: string): string {
  return text
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(" ");
}

function humanizeSegment(segment: string): string {
  return humanizeText(segment);
}

function extractJsonLabel(source: string, relPath: string): string {
  try {
    const parsed = JSON.parse(source);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.title === "string" &&
      parsed.title.trim() !== ""
    ) {
      return parsed.title.trim();
    }
  } catch {
    // fall through to path-based label
  }
  return humanizeText(basename(relPath, ".json"));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeRenderedCodeBlockClasses(html: string): string {
  return html.replace(
    /<pre><code(?: class="([^"]+)")?>/g,
    (_match, classAttr: string | undefined) => {
      const classNames = (classAttr ?? "").split(/\s+/).filter(Boolean);
      const mappedClassNames = classNames.map((className) => {
        switch (className) {
          case "language-jsonc":
            return "language-json";
          case "language-sh":
          case "language-shell":
            return "language-bash";
          case "language-yml":
            return "language-yaml";
          case "language-ts":
            return "language-typescript";
          case "language-js":
            return "language-javascript";
          default:
            return className;
        }
      });

      const nextClasses = Array.from(new Set(mappedClassNames)).join(" ");
      return nextClasses ? `<pre><code class="${nextClasses}">` : "<pre><code>";
    },
  );
}

function normalizeDocRelPath(value: string): string {
  return value.split(sep).join("/");
}

function createExcludeMatcher(patterns: string[]) {
  return ignore().add(patterns);
}

function normalizeMarkdownFragment(value: string): string {
  const trimmed = value.trim().replace(/^#/, "");
  if (!trimmed) {
    return "";
  }

  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

async function loadSourceDocs(options: Options): Promise<SourceDoc[]> {
  const excludeMatcher = createExcludeMatcher(options.excludePatterns);
  const sourceFiles = await collectSourceFiles(
    options.inputPath,
    options.inputPath,
    excludeMatcher,
  );
  const relPaths = sourceFiles
    .map((absPath) => ({
      absPath,
      relPath: normalizeDocRelPath(relative(options.inputPath, absPath)),
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath, "en"));

  return await Promise.all(
    relPaths.map(async ({ absPath, relPath }) => {
      const source = await Deno.readTextFile(absPath);
      const isJson = relPath.endsWith(".json");
      const title = isJson
        ? extractJsonLabel(source, relPath)
        : extractTitle(source, relPath);

      return {
        absPath,
        relPath,
        title,
        sectionId: toSectionId(relPath),
        source,
        isJson,
        headings: isJson ? [] : extractHeadings(source, relPath),
      };
    }),
  );
}

function buildSourceDocLookup(
  docs: SourceDoc[],
): Map<string, SourceDocLookupEntry> {
  return new Map(
    docs.map((doc) => [
      doc.relPath,
      {
        sectionId: doc.sectionId,
        isJson: doc.isJson,
        headingAnchorIds: new Map(
          doc.headings.map((heading) => [
            heading.markdownFragment,
            heading.anchorId,
          ]),
        ),
      },
    ]),
  );
}

function resolveTargetDocRelPath(
  currentRelPath: string,
  hrefPath: string,
  docLookup: Map<string, SourceDocLookupEntry>,
): string | null {
  if (hrefPath === "") {
    return currentRelPath;
  }
  const currentDir = posix.dirname(currentRelPath);
  const exactRelPath = posix.resolve("/", currentDir, hrefPath).slice(1);
  if (docLookup.has(exactRelPath)) {
    return exactRelPath;
  }
  if (/\.(?:md|json)$/i.test(hrefPath)) {
    return exactRelPath;
  }

  for (const extension of [".md", ".json"]) {
    const candidateRelPath = posix.resolve(
      "/",
      currentDir,
      `${hrefPath}${extension}`,
    )
      .slice(1);
    if (docLookup.has(candidateRelPath)) {
      return candidateRelPath;
    }
  }

  return null;
}

function shouldOpenInNewTab(href: string): boolean {
  return href !== "" && !href.startsWith("#");
}

function renderAnchorTag(
  beforeHref: string,
  href: string,
  afterHref: string,
  openInNewTab: boolean,
): string {
  const attrs = `${beforeHref}${afterHref}`;
  const targetAttr = openInNewTab && !/\btarget\s*=/i.test(attrs)
    ? ' target="_blank"'
    : "";
  const relAttr = openInNewTab && !/\brel\s*=/i.test(attrs)
    ? ' rel="noopener noreferrer"'
    : "";

  return `<a${beforeHref}href="${escapeHtml(href)}"${afterHref}${targetAttr}${relAttr}>`;
}

function rewriteLocalMarkdownLinks(
  html: string,
  currentRelPath: string,
  docLookup: Map<string, SourceDocLookupEntry>,
): string {
  return html.replace(
    /<a\b([^>]*)\bhref="([^"]+)"([^>]*)>/g,
    (match, beforeHref, rawHref: string, afterHref) => {
      if (
        rawHref === "" ||
        rawHref.startsWith("/") ||
        /^[a-z][a-z0-9+.-]*:/i.test(rawHref) ||
        rawHref.startsWith("//")
      ) {
        if (rawHref === "") {
          return match;
        }
        return renderAnchorTag(
          beforeHref,
          rawHref,
          afterHref,
          shouldOpenInNewTab(rawHref),
        );
      }

      const [hrefPath, ...fragmentParts] = rawHref.split("#");
      const targetRelPath = resolveTargetDocRelPath(
        currentRelPath,
        hrefPath,
        docLookup,
      );
      if (!targetRelPath) {
        return renderAnchorTag(
          beforeHref,
          rawHref,
          afterHref,
          shouldOpenInNewTab(rawHref),
        );
      }

      const targetDoc = docLookup.get(normalizeDocRelPath(targetRelPath));
      if (!targetDoc) {
        return renderAnchorTag(
          beforeHref,
          rawHref,
          afterHref,
          shouldOpenInNewTab(rawHref),
        );
      }

      const fragment = normalizeMarkdownFragment(fragmentParts.join("#"));
      let nextHref = `#${targetDoc.sectionId}`;

      if (fragment !== "") {
        if (targetDoc.isJson) {
          return renderAnchorTag(
            beforeHref,
            rawHref,
            afterHref,
            shouldOpenInNewTab(rawHref),
          );
        }
        const anchorId = targetDoc.headingAnchorIds.get(fragment);
        if (!anchorId) {
          return renderAnchorTag(
            beforeHref,
            rawHref,
            afterHref,
            shouldOpenInNewTab(rawHref),
          );
        }
        nextHref = `#${anchorId}`;
      }

      return renderAnchorTag(beforeHref, nextHref, afterHref, false);
    },
  );
}

function injectHeadingIds(html: string, headings: HeadingMeta[]): string {
  let headingIndex = 0;

  return html.replace(
    /<h([2-6])>([\s\S]*?)<\/h\1>/g,
    (match, depthText, innerHtml) => {
      const heading = headings[headingIndex];
      if (!heading) {
        return match;
      }

      headingIndex += 1;
      return `<h${depthText} id="${heading.anchorId}">${innerHtml}</h${depthText}>`;
    },
  );
}

async function buildEntries(
  sourceDocs: SourceDoc[],
  docLookup: Map<string, SourceDocLookupEntry>,
): Promise<DocEntry[]> {
  return await Promise.all(
    sourceDocs.map(async (doc) => {
      const html = doc.isJson
        ? `<h1>${
          escapeHtml(doc.title)
        }</h1>\n<pre><code class="language-json">${
          escapeHtml(doc.source)
        }</code></pre>`
        : normalizeRenderedCodeBlockClasses(
          rewriteLocalMarkdownLinks(
            injectHeadingIds(
              await marked.parse(doc.source, {
                async: true,
                gfm: true,
              }),
              doc.headings,
            ),
            doc.relPath,
            docLookup,
          ),
        );

      return {
        absPath: doc.absPath,
        relPath: doc.relPath,
        title: doc.title,
        sectionId: doc.sectionId,
        html,
      };
    }),
  );
}

function sortTree(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map((node) => ({
      ...node,
      children: sortTree(node.children),
    }))
    .sort((a, b) => {
      const aIsBranch = a.href === undefined;
      const bIsBranch = b.href === undefined;
      if (aIsBranch !== bIsBranch) {
        return aIsBranch ? 1 : -1;
      }
      return a.sortKey.localeCompare(b.sortKey, "en");
    });
}

function buildSidebarTree(entries: DocEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];

  for (const entry of entries) {
    const parts = entry.relPath.split("/");
    const groups = parts.slice(0, -1);
    let cursor = roots;

    for (const group of groups) {
      const label = humanizeSegment(group);
      let node = cursor.find((candidate) =>
        candidate.href === undefined && candidate.label === label
      );
      if (!node) {
        node = {
          label,
          sortKey: group,
          children: [],
        };
        cursor.push(node);
      }
      cursor = node.children;
    }

    cursor.push({
      label: entry.title,
      sortKey: entry.relPath,
      href: `#${entry.sectionId}`,
      sectionId: entry.sectionId,
      children: [],
    });
  }

  return sortTree(roots);
}

function renderTree(nodes: TreeNode[], className: string): string {
  const items = nodes
    .map((node) => {
      if (node.href) {
        return `<li class="tree-leaf"><a href="${node.href}" data-doc-target="${
          escapeHtml(node.sectionId ?? "")
        }">${escapeHtml(node.label)}</a></li>`;
      }

      return `<li class="tree-branch"><details open><summary>${
        escapeHtml(node.label)
      }</summary>${renderTree(node.children, "tree-children")}</details></li>`;
    })
    .join("\n");

  return `<ul class="${className}">${items}</ul>`;
}

function renderHtml(
  entries: DocEntry[],
  title: string,
  runtimeAssetHrefs: string[],
): string {
  const generatedAt = new Date().toISOString();
  const navTree = renderTree(buildSidebarTree(entries), "tree-root");
  const firstSectionId = entries[0]?.sectionId ?? "";
  const docOrderJson = JSON.stringify(
    entries.map(({ sectionId, title }) => ({ sectionId, title })),
  ).replaceAll(
    "<",
    "\\u003c",
  );

  const sections = entries
    .map(
      (entry) => `
      <section id="${entry.sectionId}" class="doc-section">
        ${entry.html}
      </section>`,
    )
    .join('\n<hr class="section-divider" />\n');
  const runtimeAssetScripts = runtimeAssetHrefs
    .map((href) => `    <script defer src="${escapeHtml(href)}"></script>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <script>
      (() => {
        const storageKey = 'render-doc-theme-mode';
        let themeMode = 'system';

        try {
          const stored = window.localStorage.getItem(storageKey);
          if (stored === 'light' || stored === 'dark' || stored === 'system') {
            themeMode = stored;
          }
        } catch {
          // ignore storage access failure
        }

        const prefersDark = window.matchMedia &&
          window.matchMedia('(prefers-color-scheme: dark)').matches;
        const resolvedTheme = themeMode === 'system'
          ? (prefersDark ? 'dark' : 'light')
          : themeMode;

        document.documentElement.dataset.themeMode = themeMode;
        document.documentElement.dataset.themeResolved = resolvedTheme;
      })();
    </script>
${runtimeAssetScripts}
    <style>
      :root {
        color-scheme: light;
        --bg: #ffffff;
        --surface: #f6f8fa;
        --surface-2: #eef2f6;
        --text: #1f2328;
        --muted: #59636e;
        --border: #d0d7de;
        --code-bg: #f6f8fa;
        --link: #0969da;
        --syntax-plain: #1f2328;
        --syntax-comment: #6e7781;
        --syntax-keyword: #cf222e;
        --syntax-string: #0a3069;
        --syntax-number: #953800;
        --syntax-property: #0550ae;
        --syntax-title: #8250df;
        --syntax-meta: #7a3e00;
      }

      :root[data-theme-resolved="dark"] {
        color-scheme: dark;
        --bg: #0d1117;
        --surface: #161b22;
        --surface-2: #1f2630;
        --text: #e6edf3;
        --muted: #9da7b3;
        --border: #30363d;
        --code-bg: #161b22;
        --link: #58a6ff;
        --syntax-plain: #e6edf3;
        --syntax-comment: #8b949e;
        --syntax-keyword: #ff7b72;
        --syntax-string: #a5d6ff;
        --syntax-number: #f2cc60;
        --syntax-property: #79c0ff;
        --syntax-title: #d2a8ff;
        --syntax-meta: #ffa657;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--text);
        background: var(--bg);
        line-height: 1.6;
      }
      body[data-view-mode="single"] .doc-section {
        display: none;
      }
      body[data-view-mode="single"] .doc-section.is-active-doc {
        display: block;
      }
      body[data-view-mode="single"] .section-divider {
        display: none;
      }
      a { color: var(--link); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .page {
        display: grid;
        grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
        min-height: 100vh;
        transition: grid-template-columns 180ms ease;
      }
      .sidebar {
        position: sticky;
        top: 0;
        align-self: start;
        display: flex;
        flex-direction: column;
        height: 100vh;
        max-height: 100vh;
        min-height: 0;
        overflow: hidden;
        padding: 24px 20px 32px;
        border-right: 1px solid var(--border);
        background: var(--surface);
        transition:
          transform 180ms ease,
          opacity 180ms ease,
          padding 180ms ease,
          border-color 180ms ease;
      }
      @supports (height: 100dvh) {
        .sidebar {
          height: 100dvh;
          max-height: 100dvh;
        }
      }
      body[data-sidebar-viewport="wide"][data-sidebar-open="false"] .page {
        grid-template-columns: minmax(0, 0) minmax(0, 1fr);
      }
      body[data-sidebar-viewport="wide"][data-sidebar-open="false"] .sidebar {
        padding: 0;
        border-right-color: transparent;
        opacity: 0;
        pointer-events: none;
        overflow: hidden;
      }
      .sidebar h1 {
        margin: 0 0 8px;
        font-size: 1.3rem;
      }
      .meta {
        margin: 0 0 20px;
        color: var(--muted);
        font-size: 0.9rem;
      }
      .sidebar-scroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
        scrollbar-gutter: stable;
        padding-right: 4px;
      }
      .sidebar ul {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .tree-root,
      .tree-children {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .tree-root > li + li,
      .tree-children > li + li {
        margin-top: 8px;
      }
      .tree-branch details {
        padding-left: 2px;
      }
      .tree-branch summary {
        cursor: pointer;
        font-weight: 600;
        color: var(--text);
        list-style: none;
        margin: 0;
      }
      .tree-branch summary::-webkit-details-marker {
        display: none;
      }
      .tree-branch summary::before {
        content: "▾";
        display: inline-block;
        width: 1em;
        color: var(--muted);
      }
      .tree-branch details:not([open]) summary::before {
        content: "▸";
      }
      .tree-children {
        margin-top: 8px;
        margin-left: 16px;
        padding-left: 12px;
        border-left: 1px solid var(--border);
      }
      .tree-leaf a {
        display: block;
        color: var(--text);
        text-decoration: none;
        padding: 2px 0;
      }
      .tree-leaf a:hover {
        color: var(--link);
        text-decoration: underline;
      }
      .tree-leaf a.is-active-doc-link {
        color: var(--link);
        font-weight: 600;
      }
      .content {
        min-width: 0;
        padding: 32px clamp(20px, 4vw, 48px) 48px;
      }
      .content-toolbar {
        max-width: 1100px;
        margin: 0 auto 24px;
        position: sticky;
        top: 0;
        z-index: 10;
        background: color-mix(in srgb, var(--bg) 92%, transparent);
        backdrop-filter: blur(8px);
        padding-bottom: 12px;
      }
      .view-tabs {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
      }
      .theme-control {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .view-tab,
      .single-doc-nav button {
        appearance: none;
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--text);
        padding: 5px 10px;
        border-radius: 999px;
        cursor: pointer;
        font: inherit;
        line-height: 1.2;
        white-space: nowrap;
      }
      .view-tab.is-active {
        background: var(--surface-2);
        border-color: var(--link);
        color: var(--link);
        font-weight: 600;
      }
      .toolbar-icon-button,
      .theme-icon-button {
        appearance: none;
        border: 0;
        background: transparent;
        color: var(--muted);
        padding: 4px 6px;
        border-radius: 8px;
        cursor: pointer;
        font: inherit;
        line-height: 1.2;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .toolbar-icon-button:hover,
      .theme-icon-button:hover {
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 88%, transparent);
      }
      .toolbar-icon-button:focus-visible,
      .theme-icon-button:focus-visible {
        outline: 2px solid var(--link);
        outline-offset: 2px;
      }
      .theme-icon-button.is-active {
        color: var(--link);
        background: color-mix(in srgb, var(--surface-2) 94%, transparent);
      }
      .sidebar-toggle-icon {
        width: 18px;
        height: 18px;
        display: block;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .sidebar-toggle-icon [data-icon-state] {
        display: none;
      }
      .toolbar-icon-button[data-sidebar-state="open"] .sidebar-toggle-icon [data-icon-state="open"],
      .toolbar-icon-button[data-sidebar-state="closed"] .sidebar-toggle-icon [data-icon-state="closed"] {
        display: block;
      }
      .sidebar-backdrop {
        position: fixed;
        inset: 0;
        z-index: 35;
        background: rgba(15, 23, 42, 0.32);
        opacity: 0;
        pointer-events: none;
        transition: opacity 180ms ease;
      }
      .single-doc-nav {
        display: none;
        max-width: 1100px;
        margin: 24px auto 0;
        padding-top: 20px;
        border-top: 1px solid var(--border);
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }
      body[data-view-mode="single"] .single-doc-nav {
        display: flex;
      }
      .single-doc-nav__current {
        flex: 1 1 auto;
        text-align: center;
        color: var(--muted);
        font-size: 0.95rem;
        min-width: 0;
      }
      .single-doc-nav button[disabled] {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .back-to-top {
        position: fixed;
        right: 20px;
        bottom: 100px;
        z-index: 30;
        appearance: none;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--surface) 92%, transparent);
        color: var(--text);
        padding: 6px 10px;
        border-radius: 999px;
        cursor: pointer;
        font: inherit;
        line-height: 1.2;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
        opacity: 0;
        pointer-events: none;
        transform: translateY(8px);
        transition: opacity 160ms ease, transform 160ms ease;
        backdrop-filter: blur(8px);
      }
      .back-to-top.is-visible {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0);
      }
      .doc-section {
        max-width: 1100px;
        margin: 0 auto;
        scroll-margin-top: 96px;
      }
      .section-divider {
        max-width: 1100px;
        margin: 40px auto;
        border: 0;
        border-top: 1px solid var(--border);
      }
      h1, h2, h3, h4, h5, h6 {
        line-height: 1.25;
        scroll-margin-top: 96px;
      }
      table {
        border-collapse: collapse;
        width: 100%;
        margin: 16px 0 24px;
        display: block;
        overflow-x: auto;
      }
      th, td {
        border: 1px solid var(--border);
        padding: 8px 12px;
        vertical-align: top;
      }
      th { background: var(--surface); text-align: left; }
      code {
        font-family: ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Consolas, monospace;
        font-style: italic;
        background: var(--code-bg);
        padding: 0.15em 0.4em;
        border-radius: 6px;
      }
      code[class*="language-"],
      pre[class*="language-"] {
        color: var(--syntax-plain);
        background: transparent;
      }
      .token.comment,
      .token.prolog,
      .token.doctype,
      .token.cdata {
        color: var(--syntax-comment);
      }
      .token.keyword,
      .token.boolean,
      .token.null,
      .token.symbol {
        color: var(--syntax-keyword);
      }
      .token.string,
      .token.char,
      .token.attr-value,
      .token.regex {
        color: var(--syntax-string);
      }
      .token.number,
      .token.constant,
      .token.inserted {
        color: var(--syntax-number);
      }
      .token.attr-name,
      .token.property,
      .token.parameter,
      .token.selector {
        color: var(--syntax-property);
      }
      .token.function,
      .token.class-name,
      .token.maybe-class-name {
        color: var(--syntax-title);
      }
      .token.operator,
      .token.important,
      .token.punctuation,
      .token.builtin {
        color: var(--syntax-meta);
      }
      .code-block {
        position: relative;
      }
      .mermaid-block {
        margin: 16px 0 24px;
      }
      .mermaid-diagram {
        overflow-x: auto;
        padding: 16px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--code-bg);
      }
      .mermaid-diagram svg {
        display: block;
        max-width: 100%;
        height: auto;
        margin: 0 auto;
      }
      .mermaid-diagram.is-error {
        color: var(--muted);
      }
      .mermaid-diagram__message {
        font-size: 0.95rem;
      }
      .mermaid-block pre.mermaid-source {
        margin-top: 12px;
      }
      .code-copy-button {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 2;
        appearance: none;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--surface) 92%, transparent);
        color: var(--muted);
        width: 30px;
        height: 28px;
        border-radius: 8px;
        cursor: pointer;
        font: inherit;
        line-height: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(8px);
      }
      .code-copy-button:hover {
        color: var(--text);
        border-color: var(--link);
      }
      .code-copy-button:focus-visible {
        outline: 2px solid var(--link);
        outline-offset: 2px;
      }
      .code-copy-button.is-copied {
        color: var(--link);
        border-color: var(--link);
      }
      pre {
        overflow: auto;
        padding: 16px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--code-bg);
      }
      pre.has-copy-button {
        padding-top: 44px;
      }
      pre code {
        display: block;
        padding: 0;
        background: transparent;
      }
      blockquote {
        margin: 16px 0;
        padding: 0 16px;
        border-left: 4px solid var(--border);
        color: var(--muted);
      }
      @media (max-width: 960px) {
        .page { grid-template-columns: 1fr; }
        .sidebar {
          position: fixed;
          left: 0;
          top: 0;
          bottom: 0;
          height: auto;
          width: min(320px, calc(100vw - 28px));
          max-height: none;
          border-right: 1px solid var(--border);
          border-bottom: 0;
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.2);
          transform: translateX(-104%);
          z-index: 40;
        }
        body[data-sidebar-viewport="narrow"] .sidebar {
          opacity: 1;
          padding: 24px 20px 32px;
          pointer-events: none;
          overflow: auto;
        }
        body[data-sidebar-viewport="narrow"][data-sidebar-open="true"] .sidebar {
          transform: translateX(0);
          pointer-events: auto;
        }
        body[data-sidebar-viewport="narrow"][data-sidebar-open="true"] .sidebar-backdrop {
          opacity: 1;
          pointer-events: auto;
        }
        .theme-control {
          width: 100%;
          margin-left: 0;
          justify-content: flex-start;
        }
      }
    </style>
  </head>
  <body data-view-mode="single" data-active-doc="${
    escapeHtml(firstSectionId)
  }" data-sidebar-open="true" data-sidebar-viewport="wide">
    <div class="page">
      <aside class="sidebar" id="sidebar-panel">
        <h1>${escapeHtml(title)}</h1>
        <p class="meta">Generated at ${escapeHtml(generatedAt)}</p>
        <div class="sidebar-scroll">
          ${navTree}
        </div>
      </aside>
      <main class="content">
        <div class="content-toolbar">
          <div class="view-tabs">
            <button class="toolbar-icon-button" type="button" id="sidebar-toggle-button" aria-controls="sidebar-panel" aria-expanded="true" aria-label="Hide navigation" title="Hide navigation" data-sidebar-state="open">
              <svg class="sidebar-toggle-icon" viewBox="0 0 20 20" aria-hidden="true">
                <rect x="2.75" y="3.25" width="14.5" height="13.5" rx="2"></rect>
                <path d="M7.4 4.9v10.2"></path>
                <g data-icon-state="open">
                  <path d="M12.4 8.1 9.8 10l2.6 1.9"></path>
                </g>
                <g data-icon-state="closed">
                  <path d="M10 8.1 12.6 10 10 11.9"></path>
                </g>
              </svg>
            </button>
            <button class="view-tab is-active" type="button" data-view-mode="single">Single Doc</button>
            <button class="view-tab" type="button" data-view-mode="all">All Docs</button>
            <div class="theme-control" role="group" aria-label="Theme">
              <button class="theme-icon-button" type="button" data-theme-mode="system" aria-label="System theme" title="System theme">◐</button>
              <button class="theme-icon-button" type="button" data-theme-mode="light" aria-label="Light theme" title="Light theme">☀</button>
              <button class="theme-icon-button" type="button" data-theme-mode="dark" aria-label="Dark theme" title="Dark theme">☾</button>
            </div>
          </div>
        </div>
        ${sections}
        <div class="single-doc-nav">
          <button type="button" id="prev-doc-button">← Previous</button>
          <div class="single-doc-nav__current" id="single-doc-current-label"></div>
          <button type="button" id="next-doc-button">Next →</button>
        </div>
      </main>
    </div>
    <button type="button" class="sidebar-backdrop" id="sidebar-backdrop" aria-label="Close navigation"></button>
    <button type="button" class="back-to-top" id="back-to-top-button">↑ Top</button>
    <script>
      (() => {
        const root = document.documentElement;
        const body = document.body;
        const sectionSelector = '.doc-section';
        const sectionNodes = Array.from(document.querySelectorAll(sectionSelector));
        const sectionIds = new Set(sectionNodes.map((node) => node.id));
        const internalAnchors = Array.from(document.querySelectorAll('a[href^="#"]'));
        const viewTabs = Array.from(document.querySelectorAll('[data-view-mode]'));
        const docTriggers = Array.from(document.querySelectorAll('[data-doc-target]'));
        const prevDocButton = document.getElementById('prev-doc-button');
        const nextDocButton = document.getElementById('next-doc-button');
        const currentDocLabel = document.getElementById('single-doc-current-label');
        const sidebarToggleButton = document.getElementById('sidebar-toggle-button');
        const sidebarBackdrop = document.getElementById('sidebar-backdrop');
        const backToTopButton = document.getElementById('back-to-top-button');
        const themeButtons = Array.from(document.querySelectorAll('[data-theme-mode]'));
        const narrowSidebarQuery = window.matchMedia('(max-width: 960px)');
        const themePreferenceQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const themeStorageKey = 'render-doc-theme-mode';
        const docOrder = ${docOrderJson};

        let activeDoc = body.dataset.activeDoc || (sectionNodes[0] ? sectionNodes[0].id : '');
        let sidebarOpen = true;
        let mermaidRenderToken = 0;
        let mermaidRenderQueued = false;

        const syncDocState = () => {
          body.dataset.activeDoc = activeDoc;
          const activeIndex = docOrder.findIndex((entry) => entry.sectionId === activeDoc);
          const activeEntry = activeIndex >= 0 ? docOrder[activeIndex] : null;

          sectionNodes.forEach((node) => {
            node.classList.toggle('is-active-doc', node.id === activeDoc);
          });
          docTriggers.forEach((trigger) => {
            trigger.classList.toggle('is-active-doc-link', trigger.dataset.docTarget === activeDoc);
          });

          if (currentDocLabel) {
            currentDocLabel.textContent = activeEntry ? activeEntry.title : '';
          }
          if (prevDocButton) {
            prevDocButton.disabled = activeIndex <= 0;
          }
          if (nextDocButton) {
            nextDocButton.disabled = activeIndex < 0 || activeIndex >= docOrder.length - 1;
          }
        };

        const normalizeHashTarget = (targetId) => {
          const rawTargetId = (targetId || '').replace(/^#/, '');
          if (!rawTargetId) {
            return '';
          }

          try {
            return decodeURIComponent(rawTargetId);
          } catch {
            return rawTargetId;
          }
        };

        const resolveDocId = (targetId) => {
          const normalizedTargetId = normalizeHashTarget(targetId);
          if (!normalizedTargetId) {
            return '';
          }
          if (sectionIds.has(normalizedTargetId)) {
            return normalizedTargetId;
          }
          const targetNode = document.getElementById(normalizedTargetId);
          const sectionNode = targetNode ? targetNode.closest(sectionSelector) : null;
          return sectionNode ? sectionNode.id : '';
        };

        const scrollToTarget = (targetId) => {
          const normalizedTargetId = normalizeHashTarget(targetId);
          const targetNode = normalizedTargetId ? document.getElementById(normalizedTargetId) : null;
          const fallbackNode = activeDoc ? document.getElementById(activeDoc) : null;
          const nodeToScroll = targetNode || fallbackNode;
          if (nodeToScroll) {
            nodeToScroll.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
          window.scrollTo({ top: 0, behavior: 'smooth' });
        };

        const syncBackToTopVisibility = () => {
          if (!backToTopButton) {
            return;
          }
          backToTopButton.classList.toggle('is-visible', window.scrollY > 160);
        };

        const syncSidebarState = () => {
          const sidebarViewport = narrowSidebarQuery.matches ? 'narrow' : 'wide';
          body.dataset.sidebarViewport = sidebarViewport;
          body.dataset.sidebarOpen = sidebarOpen ? 'true' : 'false';

          if (sidebarToggleButton) {
            const label = sidebarOpen ? 'Hide navigation' : 'Show navigation';
            sidebarToggleButton.dataset.sidebarState = sidebarOpen ? 'open' : 'closed';
            sidebarToggleButton.setAttribute('aria-label', label);
            sidebarToggleButton.setAttribute('title', label);
            sidebarToggleButton.setAttribute('aria-expanded', sidebarOpen ? 'true' : 'false');
          }
        };

        const setSidebarOpen = (nextOpen) => {
          sidebarOpen = nextOpen;
          syncSidebarState();
        };

        const toggleSidebar = () => {
          setSidebarOpen(!sidebarOpen);
        };

        const syncSidebarViewportDefaults = () => {
          const nextViewport = narrowSidebarQuery.matches ? 'narrow' : 'wide';
          if (body.dataset.sidebarViewport !== nextViewport) {
            sidebarOpen = nextViewport === 'wide';
          }
          syncSidebarState();
        };

        const resolveThemeMode = (themeMode) => {
          if (themeMode === 'light' || themeMode === 'dark') {
            return themeMode;
          }
          return themePreferenceQuery.matches ? 'dark' : 'light';
        };

        const applyThemeMode = (themeMode, persist) => {
          const nextThemeMode =
            themeMode === 'light' || themeMode === 'dark' || themeMode === 'system'
              ? themeMode
              : 'system';

          root.dataset.themeMode = nextThemeMode;
          root.dataset.themeResolved = resolveThemeMode(nextThemeMode);

          themeButtons.forEach((button) => {
            const isActive = button instanceof HTMLElement &&
              button.dataset.themeMode === nextThemeMode;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
          });

          if (persist) {
            try {
              window.localStorage.setItem(themeStorageKey, nextThemeMode);
            } catch {
              // ignore storage access failure
            }
          }

          scheduleMermaidRender();
        };

        const getMermaidApi = () => {
          const candidate = window.mermaid;
          if (
            candidate &&
            typeof candidate.initialize === 'function' &&
            typeof candidate.render === 'function'
          ) {
            return candidate;
          }
          return null;
        };

        const installMermaidBlocks = () => {
          const codeNodes = Array.from(document.querySelectorAll('pre > code.language-mermaid'));

          codeNodes.forEach((codeNode, index) => {
            const pre = codeNode.parentElement;
            const parentNode = pre?.parentNode;
            if (!(pre instanceof HTMLElement) || !parentNode || pre.dataset.mermaidReady === 'true') {
              return;
            }

            pre.dataset.mermaidReady = 'true';
            pre.classList.add('mermaid-source');

            const wrapper = document.createElement('div');
            wrapper.className = 'mermaid-block';
            wrapper.dataset.mermaidSource = codeNode.textContent || '';
            wrapper.dataset.mermaidIndex = String(index);

            const diagram = document.createElement('div');
            diagram.className = 'mermaid-diagram';
            diagram.setAttribute('aria-label', 'Mermaid diagram');

            parentNode.insertBefore(wrapper, pre);
            wrapper.appendChild(diagram);
            wrapper.appendChild(pre);
          });
        };

        const renderMermaidDiagrams = async () => {
          const mermaidApi = getMermaidApi();
          const mermaidBlocks = Array.from(document.querySelectorAll('.mermaid-block'));
          if (!mermaidApi || mermaidBlocks.length === 0) {
            return;
          }

          const nextToken = ++mermaidRenderToken;
          mermaidApi.initialize({
            startOnLoad: false,
            securityLevel: 'loose',
            theme: root.dataset.themeResolved === 'dark' ? 'dark' : 'default',
          });

          for (const block of mermaidBlocks) {
            if (!(block instanceof HTMLElement)) {
              continue;
            }
            const diagram = block.querySelector('.mermaid-diagram');
            const pre = block.querySelector('pre.mermaid-source');
            const source = block.dataset.mermaidSource || '';
            if (!(diagram instanceof HTMLElement) || !(pre instanceof HTMLElement) || source.trim() === '') {
              continue;
            }

            try {
              const { svg, bindFunctions } = await mermaidApi.render(
                'mermaid-diagram-' + nextToken + '-' +
                  (block.dataset.mermaidIndex || '0'),
                source,
              );
              if (nextToken !== mermaidRenderToken) {
                return;
              }
              diagram.classList.remove('is-error');
              diagram.innerHTML = svg;
              if (typeof bindFunctions === 'function') {
                bindFunctions(diagram);
              }
              pre.hidden = true;
            } catch {
              diagram.classList.add('is-error');
              diagram.replaceChildren();
              const message = document.createElement('div');
              message.className = 'mermaid-diagram__message';
              message.textContent = 'Mermaid render failed. Showing source instead.';
              diagram.appendChild(message);
              pre.hidden = false;
            }
          }
        };

        const scheduleMermaidRender = () => {
          const mermaidApi = getMermaidApi();
          if (!mermaidApi || mermaidRenderQueued) {
            return;
          }
          mermaidRenderQueued = true;
          window.requestAnimationFrame(async () => {
            mermaidRenderQueued = false;
            await renderMermaidDiagrams();
          });
        };

        const fallbackCopyText = (text) => {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.setAttribute('readonly', '');
          textarea.style.position = 'fixed';
          textarea.style.top = '0';
          textarea.style.left = '0';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();

          try {
            return document.execCommand('copy');
          } finally {
            textarea.remove();
          }
        };

        const writeClipboardText = async (text) => {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return;
          }

          if (!fallbackCopyText(text)) {
            throw new Error('Copy failed');
          }
        };

        const installCopyButtons = () => {
          const codeNodes = Array.from(document.querySelectorAll('pre > code'));

          codeNodes.forEach((codeNode) => {
            const pre = codeNode.parentElement;
            const parentNode = pre?.parentNode;
            if (!(pre instanceof HTMLElement) || !parentNode || pre.dataset.copyButtonReady === 'true') {
              return;
            }
            if (codeNode.classList.contains('language-mermaid') || pre.closest('.mermaid-block')) {
              return;
            }

            pre.dataset.copyButtonReady = 'true';
            pre.classList.add('has-copy-button');

            const wrapper = document.createElement('div');
            wrapper.className = 'code-block';
            parentNode.insertBefore(wrapper, pre);
            wrapper.appendChild(pre);

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'code-copy-button';
            button.setAttribute('aria-label', 'Copy code block');
            button.setAttribute('title', 'Copy code');
            button.textContent = '⧉';

            let resetTimer = 0;
            const resetButton = () => {
              button.classList.remove('is-copied');
              button.textContent = '⧉';
              button.setAttribute('title', 'Copy code');
            };

            button.addEventListener('click', async () => {
              if (resetTimer) {
                window.clearTimeout(resetTimer);
              }

              try {
                await writeClipboardText(codeNode.textContent || '');
                button.classList.add('is-copied');
                button.textContent = '✓';
                button.setAttribute('title', 'Copied');
              } catch {
                button.classList.remove('is-copied');
                button.textContent = '!';
                button.setAttribute('title', 'Copy failed');
              }

              resetTimer = window.setTimeout(() => {
                resetButton();
              }, 1400);
            });

            wrapper.appendChild(button);
          });
        };

        const setMode = (mode) => {
          body.dataset.viewMode = mode;
          viewTabs.forEach((tab) => {
            tab.classList.toggle('is-active', tab.dataset.viewMode === mode);
          });
        };

        const activateDoc = (docId, switchToSingle) => {
          if (!docId) {
            return;
          }
          activeDoc = docId;
          if (switchToSingle) {
            setMode('single');
          }
          syncDocState();
        };

        const activateTarget = (targetId, switchToSingle, shouldScroll) => {
          const docId = resolveDocId(targetId);
          if (!docId) {
            return;
          }
          activateDoc(docId, switchToSingle);
          if (shouldScroll) {
            scrollToTarget(targetId || docId);
          }
        };

        viewTabs.forEach((tab) => {
          tab.addEventListener('click', () => {
            const mode = tab.dataset.viewMode || 'all';
            setMode(mode);
            syncDocState();
          });
        });

        internalAnchors.forEach((anchor) => {
          anchor.addEventListener('click', (event) => {
            const href = anchor.getAttribute('href') || '';
            const targetId = href.replace(/^#/, '');
            const docId = resolveDocId(targetId);
            if (!docId) {
              return;
            }

            const isDocRootTarget = sectionIds.has(targetId);
            activateDoc(docId, false);

            if (body.dataset.viewMode === 'single') {
              event.preventDefault();
              if (window.location.hash !== href) {
                history.pushState(null, '', href);
              }
              if (!isDocRootTarget) {
                scrollToTarget(targetId);
              }
            }

            if (body.dataset.sidebarViewport === 'narrow') {
              setSidebarOpen(false);
            }
          });
        });

        if (prevDocButton) {
          prevDocButton.addEventListener('click', () => {
            const activeIndex = docOrder.findIndex((entry) => entry.sectionId === activeDoc);
            if (activeIndex > 0) {
              const previousDocId = docOrder[activeIndex - 1].sectionId;
              history.pushState(null, '', '#' + previousDocId);
              activateDoc(previousDocId, false);
            }
          });
        }

        if (nextDocButton) {
          nextDocButton.addEventListener('click', () => {
            const activeIndex = docOrder.findIndex((entry) => entry.sectionId === activeDoc);
            if (activeIndex >= 0 && activeIndex < docOrder.length - 1) {
              const nextDocId = docOrder[activeIndex + 1].sectionId;
              history.pushState(null, '', '#' + nextDocId);
              activateDoc(nextDocId, false);
            }
          });
        }

        if (backToTopButton) {
          backToTopButton.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          });
        }

        if (sidebarToggleButton) {
          sidebarToggleButton.addEventListener('click', () => {
            toggleSidebar();
          });
        }

        if (sidebarBackdrop) {
          sidebarBackdrop.addEventListener('click', () => {
            if (body.dataset.sidebarViewport === 'narrow') {
              setSidebarOpen(false);
            }
          });
        }

        themeButtons.forEach((button) => {
          button.addEventListener('click', () => {
            const nextThemeMode = button instanceof HTMLElement
              ? button.dataset.themeMode || 'system'
              : 'system';
            applyThemeMode(nextThemeMode, true);
          });
        });

        window.addEventListener('hashchange', () => {
          const hashId = normalizeHashTarget(window.location.hash);
          const docId = resolveDocId(hashId);
          if (!docId) {
            return;
          }
          activateDoc(docId, false);
          if (body.dataset.viewMode === 'single' && hashId && !sectionIds.has(hashId)) {
            window.requestAnimationFrame(() => {
              scrollToTarget(hashId);
            });
          }
        });

        const initialHashId = normalizeHashTarget(window.location.hash);
        if (initialHashId) {
          const docId = resolveDocId(initialHashId);
          if (docId) {
            activeDoc = docId;
          }
        }

        syncDocState();
        syncSidebarViewportDefaults();
        applyThemeMode(root.dataset.themeMode || 'system', false);
        installMermaidBlocks();
        installCopyButtons();
        syncBackToTopVisibility();

        if (typeof narrowSidebarQuery.addEventListener === 'function') {
          narrowSidebarQuery.addEventListener('change', syncSidebarViewportDefaults);
        } else if (typeof narrowSidebarQuery.addListener === 'function') {
          narrowSidebarQuery.addListener(syncSidebarViewportDefaults);
        }
        if (typeof themePreferenceQuery.addEventListener === 'function') {
          themePreferenceQuery.addEventListener('change', () => {
            if ((root.dataset.themeMode || 'system') === 'system') {
              applyThemeMode('system', false);
            }
          });
        } else if (typeof themePreferenceQuery.addListener === 'function') {
          themePreferenceQuery.addListener(() => {
            if ((root.dataset.themeMode || 'system') === 'system') {
              applyThemeMode('system', false);
            }
          });
        }
        window.addEventListener('scroll', syncBackToTopVisibility, { passive: true });
        window.addEventListener('load', () => {
          scheduleMermaidRender();
        }, { once: true });

        if (body.dataset.viewMode === 'single' && initialHashId && !sectionIds.has(initialHashId)) {
          window.requestAnimationFrame(() => {
            scrollToTarget(initialHashId);
          });
        }
      })();
    </script>
  </body>
</html>
`;
}

function splitInlineStylesheet(
  html: string,
  cssHref: string,
): { html: string; css: string } {
  const styleMatch = html.match(/<style>\s*([\s\S]*?)\s*<\/style>/);
  if (!styleMatch) {
    throw new Error("Expected an inline stylesheet in rendered HTML.");
  }

  return {
    css: `${styleMatch[1].trim()}\n`,
    html: html.replace(
      styleMatch[0],
      `    <link rel="stylesheet" href="${escapeHtml(cssHref)}" />`,
    ),
  };
}

async function syncRuntimeAssets(outputDir: string): Promise<string[]> {
  const runtimeAssetDir = join(outputDir, RUNTIME_ASSET_DIR);
  await Deno.mkdir(runtimeAssetDir, { recursive: true });

  return await Promise.all(
    RUNTIME_ASSET_SPECS.map(async ({ fileName, sourceUrl }) => {
      const response = await fetch(sourceUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to download runtime asset ${sourceUrl}: ${response.status} ${response.statusText}`,
        );
      }

      const assetPath = join(runtimeAssetDir, fileName);
      await Deno.writeTextFile(assetPath, await response.text());
      console.log(`Synced runtime asset to ${assetPath}`);
      return `${RUNTIME_ASSET_DIR}/${fileName}`;
    }),
  );
}

async function main() {
  const options = parseArgs(Deno.args);
  const sourceDocs = await loadSourceDocs(options);
  const docLookup = buildSourceDocLookup(sourceDocs);
  const entries = await buildEntries(sourceDocs, docLookup);
  if (entries.length === 0) {
    throw new Error("No markdown documents matched the current include rules.");
  }

  const outputDir = dirname(options.outputPath);
  const htmlBaseName = basename(options.outputPath).replace(/\.[^.]+$/, "") ||
    "index";
  const cssFileName = `${htmlBaseName}.css`;
  const cssPath = join(outputDir, cssFileName);
  const runtimeAssetHrefs = await syncRuntimeAssets(outputDir);
  const html = renderHtml(entries, options.title, runtimeAssetHrefs);
  const splitOutput = splitInlineStylesheet(html, cssFileName);
  await Deno.mkdir(outputDir, { recursive: true });
  await Deno.writeTextFile(cssPath, splitOutput.css);
  await Deno.writeTextFile(options.outputPath, splitOutput.html);
  console.log(`Wrote stylesheet to ${cssPath}`);
  console.log(`Wrote ${entries.length} docs to ${options.outputPath}`);
}

if (import.meta.main) {
  await main();
}
