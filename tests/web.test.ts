import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import dns from "node:dns/promises";
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

/** Makes DNS return these addresses, one lookup after another (the last one repeats). */
function fakeDns(...addresses: string[]) {
  let call = 0;
  return spyOn(dns, "lookup").mockImplementation((async () => {
    const address = addresses[Math.min(call++, addresses.length - 1)]!;
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  }) as never);
}
afterEach(() => (dns.lookup as { mockRestore?: () => void }).mockRestore?.());

test("a public name that resolves to a local address is blocked at approval", async () => {
  fakeDns("127.0.0.1");
  const risk = await webFetchTool.assess({ url: "http://127.0.0.1.nip.io/admin" }, ctx);
  expect(risk.level).toBe("blocked");
  expect(risk.reasons.at(-1)).toContain("resolves to 127.0.0.1");
});

test("a name rebound to a local address after approval is refused at fetch time", async () => {
  fakeDns("93.184.215.14", "::ffff:10.0.0.1");
  expect((await webFetchTool.assess({ url: "http://rebind.example/" }, ctx)).level).toBe("medium");
  expect(await webFetchTool.run({ url: "http://rebind.example/" }, ctx)).toContain("resolves to ::ffff:10.0.0.1");
});

test("a name that can't be looked up is not fetched", async () => {
  spyOn(dns, "lookup").mockRejectedValue(new Error("ENOTFOUND"));
  expect(await webFetchTool.run({ url: "http://nowhere.example/" }, ctx)).toContain("Could not look up nowhere.example");
});
