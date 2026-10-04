// A local stand-in for the Telegram Bot API, so the dashboard recording can show a live
// approval without real accounts. POST /inject {"text": "..."} sends a message as user 42.
let queue: unknown[] = [];
let updateId = 1;
Bun.serve({
  port: 8999,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/inject") {
      const { text } = (await req.json()) as { text: string };
      queue.push({ update_id: updateId++, message: { message_id: updateId, chat: { id: 42 }, from: { id: 42 }, text } });
      return new Response("queued\n");
    }
    const method = url.pathname.split("/")[2];
    const body = (await req.json().catch(() => ({}))) as { text?: string };
    if (method === "getMe") return Response.json({ ok: true, result: { username: "MiniClawDemoBot" } });
    if (method === "getUpdates") {
      const out = queue;
      queue = [];
      if (!out.length) await Bun.sleep(500);
      return Response.json({ ok: true, result: out });
    }
    if (method === "sendMessage") console.log(`bot → ${String(body.text).replace(/\n/g, " ⏎ ").slice(0, 160)}`);
    return Response.json({ ok: true, result: { message_id: 1 } });
  },
});
console.log("fake Telegram on :8999");
