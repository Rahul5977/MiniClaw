import { splitMessage, type ChatChannel, type Choice, type IncomingMessage } from "../gateway/channel.ts";

export interface TelegramOptions {
  /** From @BotFather. */
  token: string;
  /** Numeric Telegram user ids allowed to use the bot (from @userinfobot). */
  allowedUsers: string[];
  apiBase?: string;
  /** Long-poll timeout in seconds. */
  pollTimeout?: number;
}

interface TelegramUser {
  id: number;
}
interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
}
interface Update {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: { id: string; from: TelegramUser; data?: string; message?: TelegramMessage };
}

const MAX_MESSAGE = 4000; // Telegram's limit is 4096

/** Telegram Bot API over plain fetch with long polling (no webhook or public URL needed). */
export class TelegramChannel implements ChatChannel {
  readonly name = "telegram";
  private offset = 0;
  private running = false;
  private poller: Promise<void> | null = null;
  private controller = new AbortController();

  constructor(private options: TelegramOptions) {}

  /** Never lets the token reach logs or error messages. */
  private redact(text: string): string {
    return text.replaceAll(this.options.token, "<token>");
  }

  private async call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const base = this.options.apiBase ?? "https://api.telegram.org";
    let res: Response;
    try {
      res = await fetch(`${base}/bot${this.options.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: this.controller.signal,
      });
    } catch (error) {
      throw new Error(this.redact(`Telegram ${method} failed: ${(error as Error).message}`));
    }
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(this.redact(`Telegram ${method}: ${json.description ?? `HTTP ${res.status}`}`));
    return json.result as T;
  }

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    const me = await this.call<{ username: string }>("getMe").catch((error: Error) => {
      throw new Error(`${error.message}. Check TELEGRAM_BOT_TOKEN.`);
    });
    console.log(`[telegram] connected as @${me.username}`);
    this.running = true;
    this.poller = this.poll(onMessage);
  }

  private async poll(onMessage: (message: IncomingMessage) => void): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      try {
        const updates = await this.call<Update[]>("getUpdates", {
          offset: this.offset,
          timeout: this.options.pollTimeout ?? 30,
          allowed_updates: ["message", "callback_query"],
        });
        backoff = 1000;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handle(update, onMessage).catch((error) => console.error(`[telegram] ${this.redact(error.message)}`));
        }
      } catch (error) {
        if (!this.running) break;
        console.error(`[telegram] ${(error as Error).message}; retrying in ${backoff / 1000}s`);
        await Bun.sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async handle(update: Update, onMessage: (message: IncomingMessage) => void): Promise<void> {
    const message = update.message;
    if (message?.from) {
      const senderId = String(message.from.id);
      if (message.text !== undefined) {
        onMessage({ chatId: String(message.chat.id), senderId, text: message.text });
      } else if (this.isAllowed(senderId)) {
        await this.send(String(message.chat.id), "Sorry, I can only read text messages for now.");
      }
      return;
    }

    const query = update.callback_query;
    if (query?.message && query.data) {
      await this.call("answerCallbackQuery", { callback_query_id: query.id });
      if (!this.isAllowed(String(query.from.id))) return;
      // Show what was chosen and remove the buttons so they can't be pressed twice.
      const keyboard = (query.message as { reply_markup?: { inline_keyboard?: { text: string; callback_data: string }[][] } }).reply_markup;
      const label = keyboard?.inline_keyboard?.flat().find((b) => b.callback_data === query.data)?.text ?? query.data;
      await this.call("editMessageText", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        text: `${query.message.text ?? ""}\n\n→ ${label}`,
      }).catch(() => {}); // the message may be too old to edit; the answer still counts
      onMessage({ chatId: String(query.message.chat.id), senderId: String(query.from.id), text: label, choice: query.data });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller.abort();
    await this.poller?.catch(() => {});
  }

  async send(chatId: string, text: string): Promise<void> {
    for (const part of splitMessage(text, MAX_MESSAGE)) {
      await this.call("sendMessage", { chat_id: chatId, text: part });
    }
  }

  async ask(chatId: string, text: string, choices: Choice[]): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text: text.slice(0, MAX_MESSAGE),
      reply_markup: { inline_keyboard: [choices.map((c) => ({ text: c.label, callback_data: c.id }))] },
    });
  }

  isAllowed(senderId: string): boolean {
    return this.options.allowedUsers.includes(senderId);
  }

  defaultChatId(): string | undefined {
    // In a private chat with the bot, the chat id is the user's id.
    return this.options.allowedUsers[0];
  }
}
