import { afterAll, expect, test } from "bun:test";
import { TelegramChannel } from "../src/channels/telegram.ts";
import type { IncomingMessage } from "../src/gateway/channel.ts";

const TOKEN = "123456:SECRET-TOKEN";
const calls: { method: string; body: any }[] = [];
let queue: any[] = [];

/** A tiny fake of the Telegram Bot API. */
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const [, bot, method] = new URL(req.url).pathname.split("/");
    if (bot !== `bot${TOKEN}`) return Response.json({ ok: false, description: "Unauthorized" }, { status: 401 });
    const body = (await req.json()) as any;
    calls.push({ method: method!, body });
    if (method === "getMe") return Response.json({ ok: true, result: { username: "MiniClawTestBot" } });
    if (method === "getUpdates") {
      const updates = queue.filter((u) => u.update_id >= (body.offset ?? 0));
      queue = [];
      if (updates.length === 0) await Bun.sleep(20);
      return Response.json({ ok: true, result: updates });
    }
    return Response.json({ ok: true, result: {} });
  },
});
afterAll(() => server.stop(true));
const apiBase = `http://127.0.0.1:${server.port}`;

async function started() {
  const channel = new TelegramChannel({ token: TOKEN, allowedUsers: ["42"], apiBase, pollTimeout: 0 });
  const received: IncomingMessage[] = [];
  await channel.start((m) => received.push(m));
  return { channel, received };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
};

test("text messages become IncomingMessages and the offset advances", async () => {
  const { channel, received } = await started();
  queue.push({ update_id: 7, message: { message_id: 1, chat: { id: 42 }, from: { id: 42 }, text: "hello" } });
  await until(() => received.length === 1);
  expect(received[0]).toEqual({ chatId: "42", senderId: "42", text: "hello" });
  await until(() => calls.some((c) => c.method === "getUpdates" && c.body.offset === 8));
  await channel.stop();
});

test("button taps answer the callback, show the choice, and arrive as a choice", async () => {
  const { channel, received } = await started();
  calls.length = 0;
  queue.push({
    update_id: 20,
    callback_query: {
      id: "cb1",
      from: { id: 42 },
      data: "yes",
      message: { message_id: 5, chat: { id: 42 }, text: "🔐 Allow?", reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: "yes" }]] } },
    },
  });
  await until(() => received.length === 1);
  expect(received[0]).toEqual({ chatId: "42", senderId: "42", text: "Yes", choice: "yes" });
  expect(calls.find((c) => c.method === "answerCallbackQuery")?.body).toEqual({ callback_query_id: "cb1" });
  expect(calls.find((c) => c.method === "editMessageText")?.body.text).toBe("🔐 Allow?\n\n→ Yes");
  await channel.stop();
});

test("non-text messages from the owner get a polite reply", async () => {
  const { channel } = await started();
  calls.length = 0;
  queue.push({ update_id: 30, message: { message_id: 2, chat: { id: 42 }, from: { id: 42 }, photo: [{}] } });
  await until(() => calls.some((c) => c.method === "sendMessage"));
  expect(calls.find((c) => c.method === "sendMessage")?.body.text).toContain("only read text");
  await channel.stop();
});

test("send splits long text; ask attaches inline buttons", async () => {
  const channel = new TelegramChannel({ token: TOKEN, allowedUsers: ["42"], apiBase });
  calls.length = 0;
  await channel.send("42", "word ".repeat(2000));
  expect(calls.filter((c) => c.method === "sendMessage").length).toBe(3);

  await channel.ask("42", "Allow?", [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]);
  expect(calls.at(-1)?.body.reply_markup).toEqual({
    inline_keyboard: [[{ text: "Yes", callback_data: "yes" }, { text: "No", callback_data: "no" }]],
  });
});

test("a bad token fails clearly without leaking the token", async () => {
  const channel = new TelegramChannel({ token: "wrong:TOKEN-XYZ", allowedUsers: [], apiBase });
  const error = await channel.start(() => {}).catch((e: Error) => e);
  expect((error as Error).message).toContain("Unauthorized. Check TELEGRAM_BOT_TOKEN.");

  const offline = new TelegramChannel({ token: "1:LEAKY", allowedUsers: [], apiBase: "http://127.0.0.1:9" });
  const err2 = await offline.start(() => {}).catch((e: Error) => e);
  expect((err2 as Error).message).not.toContain("LEAKY");
});

test("allowlist and default chat", () => {
  const channel = new TelegramChannel({ token: TOKEN, allowedUsers: ["42", "7"], apiBase });
  expect(channel.isAllowed("42")).toBe(true);
  expect(channel.isAllowed("99")).toBe(false);
  expect(channel.defaultChatId()).toBe("42");
});
