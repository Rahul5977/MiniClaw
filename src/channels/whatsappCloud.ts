import { createHmac, timingSafeEqual } from "node:crypto";
import { splitMessage, type ChatChannel, type Choice, type IncomingMessage } from "../gateway/channel.ts";

export interface WhatsAppCloudOptions {
  /** Access token (temporary from the Meta app dashboard, or a system-user token). */
  token: string;
  /** "Phone number ID" from WhatsApp > API Setup (not the phone number itself). */
  phoneNumberId: string;
  /** App secret (App settings > Basic), used to verify webhook signatures. */
  appSecret: string;
  /** Any string you choose; enter the same one when configuring the webhook in Meta. */
  verifyToken: string;
  /** Phone numbers allowed to use the bot, with country code, e.g. "919876543210". */
  allowedNumbers: string[];
  apiBase?: string;
}

export const WHATSAPP_WEBHOOK_PATH = "/webhooks/whatsapp";

const MAX_MESSAGE = 4000;
const MAX_BUTTON_BODY = 1024;

interface WebhookMessage {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  interactive?: { type: string; button_reply?: { id: string; title: string } };
  button?: { payload: string; text: string };
}

export const digits = (phone: string) => phone.replace(/\D/g, "");

/**
 * WhatsApp Business Cloud API (official). Meta pushes messages to a webhook on the
 * gateway's HTTP server; every request's signature is checked with the app secret.
 * Note: outside the 24-hour window after the user's last message, WhatsApp only
 * allows pre-approved template messages, so late reminders can be refused.
 */
export class WhatsAppCloudChannel implements ChatChannel {
  readonly name = "whatsapp";
  private onMessage: ((message: IncomingMessage) => void) | null = null;
  private seen = new Set<string>();
  private allowed: Set<string>;

  constructor(private options: WhatsAppCloudOptions) {
    this.allowed = new Set(options.allowedNumbers.map(digits));
  }

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    this.onMessage = onMessage;
    console.log(`[whatsapp] waiting for webhooks at ${WHATSAPP_WEBHOOK_PATH}`);
  }

  async stop(): Promise<void> {
    this.onMessage = null;
  }

  routes() {
    return { [WHATSAPP_WEBHOOK_PATH]: (request: Request) => this.webhook(request) };
  }

  async webhook(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET") {
      // Meta's one-time verification when you set up the webhook.
      const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === this.options.verifyToken;
      return ok ? new Response(url.searchParams.get("hub.challenge") ?? "") : new Response("Forbidden", { status: 403 });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const raw = await request.text();
    if (!this.validSignature(raw, request.headers.get("x-hub-signature-256"))) {
      console.warn("[whatsapp] rejected a webhook with a bad signature");
      return new Response("Bad signature", { status: 401 });
    }
    let payload: { entry?: { changes?: { value?: { messages?: WebhookMessage[] } }[] }[] };
    try {
      payload = JSON.parse(raw);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) this.dispatch(message);
      }
    }
    // Always 200 quickly; otherwise Meta retries the delivery.
    return new Response("OK");
  }

  private validSignature(raw: string, header: string | null): boolean {
    if (!header?.startsWith("sha256=")) return false;
    const expected = createHmac("sha256", this.options.appSecret).update(raw).digest();
    const given = Buffer.from(header.slice(7), "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private dispatch(message: WebhookMessage): void {
    if (this.seen.has(message.id)) return; // Meta may deliver the same message twice
    this.seen.add(message.id);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);

    const base = { chatId: message.from, senderId: message.from };
    if (message.type === "text" && message.text) {
      this.onMessage?.({ ...base, text: message.text.body });
    } else if (message.type === "interactive" && message.interactive?.button_reply) {
      const { id, title } = message.interactive.button_reply;
      this.onMessage?.({ ...base, text: title, choice: id });
    } else if (message.type === "button" && message.button) {
      this.onMessage?.({ ...base, text: message.button.text, choice: message.button.payload });
    } else if (this.isAllowed(message.from)) {
      void this.send(message.from, "Sorry, I can only read text messages for now.").catch(() => {});
    }
  }

  private async post(body: Record<string, unknown>): Promise<void> {
    const base = this.options.apiBase ?? "https://graph.facebook.com/v26.0";
    const res = await fetch(`${base}/${this.options.phoneNumberId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }),
    });
    if (res.ok) return;
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
    const code = json.error?.code;
    const hint =
      code === 131047
        ? " (more than 24 hours since the user's last message; WhatsApp only allows template messages now)"
        : code === 190
          ? " (the access token is invalid or expired; temporary tokens last 24 hours)"
          : "";
    throw new Error(`WhatsApp send failed: ${json.error?.message ?? `HTTP ${res.status}`}${hint}`);
  }

  async send(chatId: string, text: string): Promise<void> {
    for (const part of splitMessage(text, MAX_MESSAGE)) {
      await this.post({ to: chatId, type: "text", text: { preview_url: false, body: part } });
    }
  }

  async ask(chatId: string, text: string, choices: Choice[]): Promise<void> {
    const buttonsFit = choices.length <= 3 && choices.every((c) => c.label.length <= 20);
    if (!buttonsFit) {
      // Fall back to a numbered list; Conversation matches typed answers.
      const list = choices.map((c, i) => `${i + 1}. ${c.label}`).join("\n");
      return this.send(chatId, `${text}\n\nReply with a number:\n${list}`);
    }
    let body = text;
    if (body.length > MAX_BUTTON_BODY) {
      await this.send(chatId, body);
      body = "Choose:";
    }
    await this.post({
      to: chatId,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: { buttons: choices.map((c) => ({ type: "reply", reply: { id: c.id, title: c.label } })) },
      },
    });
  }

  isAllowed(senderId: string): boolean {
    return this.allowed.has(digits(senderId));
  }

  defaultChatId(): string | undefined {
    return this.options.allowedNumbers.map(digits)[0];
  }
}
