import { afterAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { WhatsAppCloudChannel } from "../src/channels/whatsappCloud.ts";
import type { IncomingMessage } from "../src/gateway/channel.ts";

const SECRET = "app-secret";
const posts: { path: string; auth: string | null; body: any }[] = [];
let failWith: { code: number; message: string } | null = null;

/** A tiny fake of the Graph API messages endpoint. */
const graph = Bun.serve({
  port: 0,
  async fetch(req) {
    posts.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.json() });
    if (failWith) return Response.json({ error: failWith }, { status: 400 });
    return Response.json({ messages: [{ id: "wamid.x" }] });
  },
});
afterAll(() => graph.stop(true));

function channel() {
  const c = new WhatsAppCloudChannel({
    token: "TOKEN",
    phoneNumberId: "PNID",
    appSecret: SECRET,
    verifyToken: "my-verify",
    allowedNumbers: ["+91 98765 43210"],
    apiBase: `http://127.0.0.1:${graph.port}`,
  });
  const received: IncomingMessage[] = [];
  void c.start((m) => received.push(m));
  return { c, received };
}

function webhook(c: WhatsAppCloudChannel, payload: unknown, secret = SECRET) {
  const body = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return c.webhook(new Request("http://x/webhooks/whatsapp", { method: "POST", body, headers: { "x-hub-signature-256": signature } }));
}

const messages = (...msgs: object[]) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messages: msgs } }] }] });

test("webhook verification handshake", async () => {
  const { c } = channel();
  const ok = await c.webhook(new Request("http://x/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=my-verify&hub.challenge=12345"));
  expect(await ok.text()).toBe("12345");
  const bad = await c.webhook(new Request("http://x/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1"));
  expect(bad.status).toBe(403);
});

test("signed text and button replies are delivered once; forged ones are rejected", async () => {
  const { c, received } = channel();
  const text = { from: "919876543210", id: "m1", type: "text", text: { body: "hello" } };
  expect((await webhook(c, messages(text))).status).toBe(200);
  await webhook(c, messages(text)); // duplicate delivery
  await webhook(c, messages({ from: "919876543210", id: "m2", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "yes", title: "Yes" } } }));
  expect(received).toEqual([
    { chatId: "919876543210", senderId: "919876543210", text: "hello" },
    { chatId: "919876543210", senderId: "919876543210", text: "Yes", choice: "yes" },
  ]);

  const forged = await webhook(c, messages({ from: "919876543210", id: "m3", type: "text", text: { body: "rm -rf" } }), "wrong-secret");
  expect(forged.status).toBe(401);
  const unsigned = await c.webhook(new Request("http://x/webhooks/whatsapp", { method: "POST", body: "{}" }));
  expect(unsigned.status).toBe(401);
  expect(received).toHaveLength(2);
});

test("send posts text with the bearer token; ask uses reply buttons", async () => {
  const { c } = channel();
  posts.length = 0;
  await c.send("919876543210", "hi");
  expect(posts[0]).toMatchObject({ path: "/PNID/messages", auth: "Bearer TOKEN", body: { to: "919876543210", type: "text", text: { body: "hi" } } });

  await c.ask("919876543210", "Allow?", [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]);
  expect(posts[1]?.body.interactive.action.buttons).toEqual([
    { type: "reply", reply: { id: "yes", title: "Yes" } },
    { type: "reply", reply: { id: "no", title: "No" } },
  ]);
});

test("more than 3 choices fall back to a numbered list", async () => {
  const { c } = channel();
  posts.length = 0;
  await c.ask("1", "Pick", [1, 2, 3, 4].map((n) => ({ id: `${n}`, label: `Option ${n}` })));
  expect(posts[0]?.body.text.body).toContain("Reply with a number:\n1. Option 1");
});

test("WhatsApp's 24-hour rule is explained in the error", async () => {
  const { c } = channel();
  failWith = { code: 131047, message: "Re-engagement message" };
  const error = await c.send("1", "late reminder").catch((e: Error) => e);
  failWith = null;
  expect((error as Error).message).toContain("more than 24 hours");
});

test("allowlist ignores formatting of numbers", () => {
  const { c } = channel();
  expect(c.isAllowed("919876543210")).toBe(true);
  expect(c.isAllowed("+91-98765-43210")).toBe(true);
  expect(c.isAllowed("15550001111")).toBe(false);
  expect(c.defaultChatId()).toBe("919876543210");
});
