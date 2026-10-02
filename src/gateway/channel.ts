/** A button (or numbered option, where the app has no buttons). */
export interface Choice {
  id: string;
  label: string;
}

export interface IncomingMessage {
  /** Where replies go (Telegram chat id, WhatsApp number). */
  chatId: string;
  /** Who sent it; checked against the channel's allowlist. */
  senderId: string;
  text: string;
  /** Set when the user tapped a button. */
  choice?: string;
}

/** A chat app MiniClaw can be reached through. */
export interface ChatChannel {
  readonly name: string;
  start(onMessage: (message: IncomingMessage) => void): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
  /** Asks a question with buttons where supported, otherwise as a numbered list. */
  ask(chatId: string, text: string, choices: Choice[]): Promise<void>;
  /** Only allowlisted senders are served; everyone else is ignored. */
  isAllowed(senderId: string): boolean;
  /** The owner's chat, for reminders and briefings created outside this channel. */
  defaultChatId(): string | undefined;
  /** HTTP routes this channel needs on the gateway's server (e.g. a webhook), by path. */
  routes?(): Record<string, (request: Request) => Response | Promise<Response>>;
}

/** Splits long text at line breaks so it fits a chat app's message limit. */
export function splitMessage(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Matches a typed answer ("2", "yes", "Always") to a choice, for apps without buttons. */
export function matchChoice(text: string, choices: Choice[]): string | undefined {
  const t = text.trim().toLowerCase();
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.id;
  const shortcuts: Record<string, string> = { y: "yes", n: "no", a: "always", l: "later" };
  const word = shortcuts[t] ?? t;
  return choices.find((c) => c.id === word || c.label.toLowerCase() === word || c.label.toLowerCase().startsWith(word + " "))?.id;
}
