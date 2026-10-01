import { afterAll, expect, test } from "bun:test";
import { htmlToText, webFetchTool } from "../src/tools/web.ts";

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
