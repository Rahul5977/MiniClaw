import { mkdirSync } from "node:fs";
import { splitMessage, type ChatChannel, type Choice, type IncomingMessage } from "../gateway/channel.ts";
import { digits } from "./whatsappCloud.ts";

/** The parts of a Baileys socket this channel uses (a fake implements it in tests). */
export interface WaSocketLike {
  ev: { on(event: string, listener: (arg: any) => void): void };
  sendMessage(jid: string, content: { text: string }): Promise<{ key?: { id?: string | null } } | undefined>;
  end(error?: Error): void;
  user?: { id: string; lid?: string };
}

export interface WhatsAppWebOptions {
  /** Where the linked-device session is stored. Treat it like a password. */
  authDir: string;
  /** Numbers allowed to use the bot, with country code. Include your own for "Message yourself" mode. */
  allowedNumbers: string[];
  /** Added before every reply so they are easy to tell apart, especially in the self-chat. */
  replyPrefix?: string;
  /** Opens a socket; defaults to Baileys. Injected in tests. */
  connect?: (onQr: (qr: string) => void) => Promise<WaSocketLike>;
}

const LOGGED_OUT = 401;
const MAX_MESSAGE = 4000;

/** "919876543210:12@s.whatsapp.net" → "919876543210" */
const userPart = (jid: string | null | undefined) => (jid ? jid.split("@")[0]!.split(":")[0]! : "");
const isPhoneJid = (jid: string | null | undefined) => !!jid && jid.endsWith("@s.whatsapp.net");

/** Baileys wants a pino-style logger; MiniClaw keeps it quiet unless DEBUG is set. */
const quietLogger = {
  level: "silent",
  child() {
    return quietLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn(...args: unknown[]) {
    if (process.env.DEBUG) console.warn("[baileys]", ...args);
  },
  error(...args: unknown[]) {
    if (process.env.DEBUG) console.error("[baileys]", ...args);
  },
};

async function connectWithBaileys(authDir: string, onQr: (qr: string) => void): Promise<WaSocketLike> {
  const baileys = await import("baileys");
  const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir);
  const latest = await baileys.fetchLatestBaileysVersion().catch(() => null);
  const socket = baileys.default({
    auth: state,
    logger: quietLogger as never,
    browser: baileys.Browsers.macOS("MiniClaw"),
    markOnlineOnConnect: false, // keep notifications on your phone
    syncFullHistory: false,
    ...(latest?.version && { version: latest.version }),
  });
  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("connection.update", (update: { qr?: string }) => update.qr && onQr(update.qr));
  return socket as unknown as WaSocketLike;
}

/**
 * Unofficial WhatsApp via Baileys (the WhatsApp Web protocol), linked with a QR code.
 * Against WhatsApp's terms of service: the number can be banned, so use a spare one.
 *
 * Two ways to use it:
 * - link a spare number and message it from your phone, or
 * - link your own number and use the "Message yourself" chat. Only that self-chat is
 *   answered, never your messages to other people, and the bot's own replies are skipped.
 */
export class WhatsAppWebChannel implements ChatChannel {
  readonly name = "whatsapp-web";
  private socket: WaSocketLike | null = null;
  private connected = false;
  private stopping = false;
  private sentIds = new Set<string>();
  private allowed: Set<string>;
  private onMessage: ((message: IncomingMessage) => void) | null = null;

  constructor(private options: WhatsAppWebOptions) {
    this.allowed = new Set(options.allowedNumbers.map(digits));
  }

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    this.onMessage = onMessage;
    mkdirSync(this.options.authDir, { recursive: true });
    await this.open();
  }

  private async open(): Promise<void> {
    const connect = this.options.connect ?? ((onQr) => connectWithBaileys(this.options.authDir, onQr));
    const socket = await connect((qr) => this.showQr(qr));
    this.socket = socket;

    socket.ev.on("connection.update", (update: { connection?: string; lastDisconnect?: { error?: any } }) => {
      if (update.connection === "open") {
        this.connected = true;
        console.log(`[whatsapp-web] connected as ${userPart(socket.user?.id)}`);
      }
      if (update.connection === "close") {
        this.connected = false;
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if (this.stopping) return;
        if (code === LOGGED_OUT) {
          console.error(`[whatsapp-web] logged out. Delete ${this.options.authDir} and restart to link again.`);
          return;
        }
        console.log(`[whatsapp-web] connection closed (${code ?? "unknown"}), reconnecting…`);
        setTimeout(() => void this.open().catch((e) => console.error(`[whatsapp-web] ${e.message}`)), code === 515 ? 0 : 3000);
      }
    });
    socket.ev.on("messages.upsert", (event: { type: string; messages: any[] }) => {
      if (event.type !== "notify") return;
      for (const message of event.messages) this.dispatch(message);
    });
  }

  private showQr(qr: string): void {
    console.log("\n[whatsapp-web] Link MiniClaw: on your phone open WhatsApp > Settings > Linked devices > Link a device, and scan:\n");
    import("qrcode-terminal")
      .then((m) => (m.default ?? m).generate(qr, { small: true }))
      .catch(() => console.log(qr));
  }

  /** True if this jid is the linked account itself (the "Message yourself" chat). */
  private isSelf(jid: string | null | undefined): boolean {
    const user = this.socket?.user;
    if (!jid || !user) return false;
    const part = userPart(jid);
    return part === userPart(user.id) || (!!user.lid && part === userPart(user.lid));
  }

  dispatch(message: any): void {
    const key = message.key ?? {};
    const chat: string = key.remoteJid ?? "";
    if (!chat || chat.endsWith("@g.us") || chat.endsWith("@broadcast") || chat.endsWith("@newsletter")) return;
    if (key.id && this.sentIds.has(key.id)) return; // our own reply echoing back

    let senderId: string;
    if (key.fromMe) {
      // Your own messages only count in the self-chat, never in chats with other people.
      if (!this.isSelf(chat)) return;
      senderId = userPart(this.socket?.user?.id);
    } else {
      // Prefer the phone-number form; newer WhatsApp may address chats by an opaque "lid".
      const candidates = [key.remoteJid, key.remoteJidAlt, key.participant, key.participantAlt];
      senderId = userPart(candidates.find(isPhoneJid) ?? chat);
    }

    const content = message.message ?? {};
    const text: string | undefined = content.conversation ?? content.extendedTextMessage?.text;
    if (text === undefined) {
      if (this.isAllowed(senderId)) void this.send(chat, "Sorry, I can only read text messages for now.").catch(() => {});
      return;
    }
    this.onMessage?.({ chatId: chat, senderId, text });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.socket?.end();
    this.socket = null;
  }

  async send(chatId: string, text: string): Promise<void> {
    if (!this.socket || !this.connected) throw new Error("WhatsApp (linked device) is not connected yet");
    for (const part of splitMessage(`${this.options.replyPrefix ?? "🦀 "}${text}`, MAX_MESSAGE)) {
      const sent = await this.socket.sendMessage(chatId, { text: part });
      const id = sent?.key?.id;
      if (id) {
        this.sentIds.add(id);
        if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value!);
      }
    }
  }

  /** No reliable buttons on WhatsApp Web, so questions are numbered; answers are matched by matchChoice. */
  async ask(chatId: string, text: string, choices: Choice[]): Promise<void> {
    const list = choices.map((c, i) => `${i + 1}. ${c.label}`).join("\n");
    await this.send(chatId, `${text}\n\nReply with a number:\n${list}`);
  }

  isAllowed(senderId: string): boolean {
    return this.allowed.has(digits(senderId));
  }

  defaultChatId(): string | undefined {
    const first = this.options.allowedNumbers.map(digits)[0];
    return first ? `${first}@s.whatsapp.net` : undefined;
  }
}

