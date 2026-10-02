import { afterAll, expect, test } from "bun:test";
import { htmlToText, pickPath, webFetchTool } from "../src/tools/web.ts";

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/page") {
      return new Response(
        "<html><head><title>Test &amp; Page</title><style>x{}</style></head><body><h1>Hello</h1><script>evil()</script><p>World &lt;3</p></body></html>",
        { headers: { "content-type": "text/html" } },
      );
    }
    if (path === "/to-file") return Response.redirect("file:///etc/passwd", 302);
    if (path === "/api") {
      return Response.json([
        { sha: "a1", commit: { message: "Fix bug", author: { date: "2026-10-01" } }, url: "x".repeat(5000) },
        { sha: "b2", commit: { message: "Add feature", author: { date: "2026-09-30" } }, url: "y".repeat(5000) },
      ]);
    }
    if (path === "/image") return new Response("x", { headers: { "content-type": "image/png" } });
    return new Response("nope", { status: 404 });
  },
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;
const ctx = { workspace: "/tmp" };

test("htmlToText drops scripts and styles and decodes entities", () => {
  expect(htmlToText("<p>a &amp; b</p><script>x()</script><p>&#65;&#x42;</p>")).toBe("a & b\nAB");
});

test("fetches a page as readable, untrusted text", async () => {
  const out = await webFetchTool.run({ url: `${base}/page` }, ctx);
  expect(out).toContain(`<untrusted source="web:${base}/page">`);
  expect(out).toContain("Title: Test & Page");
  expect(out).toContain("Hello\nWorld <3");
  expect(out).not.toContain("evil()");
});

test("redirects to dangerous URLs are refused", async () => {
  expect(await webFetchTool.run({ url: `${base}/to-file` }, ctx)).toContain("Refused to follow redirect");
});

test("non-text content is described, not dumped", async () => {
  expect(await webFetchTool.run({ url: `${base}/image` }, ctx)).toContain("image/png");
});

test("pickPath follows dot paths and * wildcards", () => {
  const data = { owner: { login: "rahul" }, items: [{ n: 1 }, { n: 2 }] };
  expect(pickPath(data, "owner.login")).toBe("rahul");
  expect(pickPath(data, "items.1.n")).toBe(2);
  expect(pickPath(data, "items.*.n")).toEqual([1, 2]);
  expect(pickPath(data, "nope.x")).toBeUndefined();
});

test("fields shrink large JSON responses to what was asked", async () => {
  const out = await webFetchTool.run({ url: `${base}/api`, fields: ["*.commit.message", "*.commit.author.date", "missing"] }, ctx);
  expect(out).toContain('*.commit.message: ["Fix bug","Add feature"]');
  expect(out).toContain('*.commit.author.date: ["2026-10-01","2026-09-30"]');
  expect(out).toContain("missing: (not found)");
  expect(out.length).toBeLessThan(500);
});
