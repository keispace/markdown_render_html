import { assertEquals, assertMatch, assertThrows } from "jsr:@std/assert";
import { _testing } from "./render-doc-html.ts";

const { parseArgs, extractPageNumber, buildPages, renderIndexHtml } = _testing;

Deno.test("extractPageNumber extracts leading digits from the first path segment", () => {
  assertEquals(extractPageNumber("0-overview/00-overview.md"), "0");
  assertEquals(extractPageNumber("1-mydata-schema/10-mydata-model.md"), "1");
  assertEquals(
    extractPageNumber("2-mydata-permission-meta/assets/meta.json"),
    "2",
  );
  assertEquals(extractPageNumber("12-long-prefix/doc.md"), "12");

  assertThrows(
    () => extractPageNumber("no-prefix/doc.md"),
    Error,
    'Cannot assign page number to path: no-prefix/doc.md — first segment "no-prefix" has no leading digits.',
  );
});

Deno.test("parseArgs parses --split-top-level-number flag correctly", () => {
  const defaultOpts = parseArgs([]);
  assertEquals(defaultOpts.splitTopLevelNumber, false);

  const splitOpts = parseArgs(["--split-top-level-number"]);
  assertEquals(splitOpts.splitTopLevelNumber, true);

  const customOpts = parseArgs([
    "--input",
    "/tmp/docs",
    "--output",
    "/tmp/docs/output/index.html",
    "--split-top-level-number",
    "--title",
    "Custom Title",
  ]);
  assertEquals(customOpts.splitTopLevelNumber, true);
  assertEquals(customOpts.title, "Custom Title");
});

Deno.test("buildPages groups entries by page number in ascending order", () => {
  const mockEntries = [
    {
      absPath: "/tmp/docs/1-schema/10.md",
      relPath: "1-schema/10.md",
      title: "Doc 10",
      sectionId: "doc-1-schema--10-md",
      html: "<p>10</p>",
      pageHref: "1.html",
    },
    {
      absPath: "/tmp/docs/0-intro/00.md",
      relPath: "0-intro/00.md",
      title: "Doc 00",
      sectionId: "doc-0-intro--00-md",
      html: "<p>00</p>",
      pageHref: "0.html",
    },
    {
      absPath: "/tmp/docs/1-schema/11.md",
      relPath: "1-schema/11.md",
      title: "Doc 11",
      sectionId: "doc-1-schema--11-md",
      html: "<p>11</p>",
      pageHref: "1.html",
    },
  ];

  const pages = buildPages(mockEntries);
  assertEquals(pages.length, 2);
  assertEquals(pages[0].pageNumber, "0");
  assertEquals(pages[0].pageHref, "0.html");
  assertEquals(pages[0].entries.length, 1);

  assertEquals(pages[1].pageNumber, "1");
  assertEquals(pages[1].pageHref, "1.html");
  assertEquals(pages[1].entries.length, 2);
});

Deno.test("renderIndexHtml generates redirect landing page", () => {
  const mockPages = [
    {
      pageNumber: "0",
      pageHref: "0.html",
      entries: [
        {
          absPath: "/tmp/0.md",
          relPath: "0-intro/00.md",
          title: "Intro",
          sectionId: "doc-0-intro--00-md",
          html: "",
          pageHref: "0.html",
        },
      ],
    },
    {
      pageNumber: "1",
      pageHref: "1.html",
      entries: [
        {
          absPath: "/tmp/1.md",
          relPath: "1-schema/10.md",
          title: "Schema",
          sectionId: "doc-1-schema--10-md",
          html: "",
          pageHref: "1.html",
        },
      ],
    },
  ];

  const allEntries = [...mockPages[0].entries, ...mockPages[1].entries];
  const html = renderIndexHtml(
    mockPages,
    allEntries,
    "Test Title",
    "index.css",
  );

  assertMatch(html, /location\.replace\('0\.html'\)/);
  assertMatch(html, /"doc-0-intro--00-md":"0\.html"/);
  assertMatch(html, /"doc-1-schema--10-md":"1\.html"/);
});
