import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhatsAppWebChannel, type WaSocketLike } from "../src/channels/whatsappWeb.ts";
import type { IncomingMessage } from "../src/gateway/channel.ts";

const root = mkdtempSync(join(tmpdir(), "miniclaw-waweb-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ME = "919000000001";
const FRIEND = "919000000002";

/** Fake Baileys socket: tests emit events; sent messages are recorded. */
class FakeSocket implements WaSocketLike {
  listeners = new Map<string, ((arg: any) => void)[]>();
  sent: { jid: string; text: string; id: string }[] = [];
  ended = false;
  user = { id: `${ME}:7@s.whatsapp.net`, lid: "55555:7@lid" };
  ev = {
    on: (event: string, listener: (arg: any) => void) => {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    },
  };
  emit(event: string, arg: unknown) {
    for (const l of this.listeners.get(event) ?? []) l(arg);
  }
  async sendMessage(jid: string, content: { text: string }) {
    const id = `out${this.sent.length}`;
    this.sent.push({ jid, text: content.text, id });
    return { key: { id } };
  }
  end() {
    this.ended = true;
  }
}

async function setup(allowed = [ME]) {
  const sockets: FakeSocket[] = [];
  const channel = new WhatsAppWebChannel({
    authDir: join(root, "auth"),
    allowedNumbers: allowed,
    connect: async (onQr) => {
      const s = new FakeSocket();
      sockets.push(s);
      queueMicrotask(() => onQr("QR-DATA"));
      return s;
    },
  });
  const received: IncomingMessage[] = [];
  await channel.start((m) => received.push(m));
  const socket = sockets[0]!;
  socket.emit("connection.update", { connection: "open" });
  const incoming = (key: object, message: object = { conversation: "hi" }) =>
    socket.emit("messages.upsert", { type: "notify", messages: [{ key, message }] });
  return { channel, socket, sockets, received, incoming };
}

test("messages from an allowlisted friend number arrive; groups and broadcasts don't", async () => {
  const t = await setup([FRIEND]);
  t.incoming({ remoteJid: `${FRIEND}@s.whatsapp.net`, id: "1" });
  t.incoming({ remoteJid: "12345@g.us", participant: `${FRIEND}@s.whatsapp.net`, id: "2" });
  t.incoming({ remoteJid: "status@broadcast", id: "3" });
  expect(t.received).toEqual([{ chatId: `${FRIEND}@s.whatsapp.net`, senderId: FRIEND, text: "hi" }]);
});

test("lid-addressed chats use the phone number from remoteJidAlt for the allowlist", async () => {
  const t = await setup([FRIEND]);
  t.incoming({ remoteJid: "77777@lid", remoteJidAlt: `${FRIEND}@s.whatsapp.net`, id: "1" }, { extendedTextMessage: { text: "yo" } });
  expect(t.received).toEqual([{ chatId: "77777@lid", senderId: FRIEND, text: "yo" }]);
});

test("your own messages count only in the self-chat, and the bot's replies are skipped", async () => {
  const t = await setup([ME]);
  t.incoming({ remoteJid: `${FRIEND}@s.whatsapp.net`, fromMe: true, id: "a" }, { conversation: "see you at 5" });
  t.incoming({ remoteJid: `${ME}@s.whatsapp.net`, fromMe: true, id: "b" }, { conversation: "weather?" });
  t.incoming({ remoteJid: "55555@lid", fromMe: true, id: "c" }, { conversation: "via lid" });
  expect(t.received.map((m) => [m.senderId, m.text])).toEqual([
    [ME, "weather?"],
    [ME, "via lid"],
  ]);

  await t.channel.send(`${ME}@s.whatsapp.net`, "It's sunny");
  const echo = t.socket.sent[0]!;
  expect(echo.text).toBe("🦀 It's sunny");
  t.incoming({ remoteJid: `${ME}@s.whatsapp.net`, fromMe: true, id: echo.id }, { conversation: echo.text });
  expect(t.received).toHaveLength(2); // no reply loop
});

test("questions are numbered lists", async () => {
  const t = await setup();
  await t.channel.ask("x@s.whatsapp.net", "Allow?", [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]);
  expect(t.socket.sent[0]?.text).toBe("🦀 Allow?\n\nReply with a number:\n1. Yes\n2. No");
});

test("reconnects after a drop, but not after logout; sending while offline fails", async () => {
  const t = await setup();
  t.socket.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await Bun.sleep(10);
  expect(t.sockets).toHaveLength(2);
  await expect(t.channel.send("x", "hi")).rejects.toThrow(/not connected/);

  t.sockets[1]!.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await Bun.sleep(10);
  expect(t.sockets).toHaveLength(2);
});

test("allowlist and default chat", async () => {
  const t = await setup(["+91 90000 00001"]);
  expect(t.channel.isAllowed(ME)).toBe(true);
  expect(t.channel.isAllowed(FRIEND)).toBe(false);
  expect(t.channel.defaultChatId()).toBe(`${ME}@s.whatsapp.net`);
  await t.channel.stop();
  expect(t.socket.ended).toBe(true);
});
