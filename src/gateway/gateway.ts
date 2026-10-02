import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Runtime } from "../runtime.ts";
import type { Reminder } from "../scheduler/reminders.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import type { ChatChannel, IncomingMessage } from "./channel.ts";
import { Conversation } from "./conversation.ts";

const BRIEFING_PROMPT =
  "(Scheduled morning briefing — the user did not type this and is not waiting for a reply.) " +
  "Call list_reminders and recall_notes with date \"yesterday\". Then write a friendly briefing in at most 8 short lines: " +
  "a greeting, today's reminders, and anything notable from yesterday. Don't ask questions.";

export interface GatewayOptions {
  /** "<channel>:<chatId>" for reminders made outside a chat app (e.g. in the CLI). */
  defaultChat?: string;
  answerTimeoutMs?: number;
  schedulerIntervalMs?: number;
  /** Daily briefing time "HH:MM" (local), and where to remember the last day it was sent. */
  briefing?: { time: string; stateFile: string };
  /** HTTP server for webhooks (and later the dashboard). Localhost by default; use a tunnel to expose it. */
  http?: { host: string; port: number };
}

/**
 * The long-running process: receives messages from every chat app, routes each chat
 * to its own Conversation, and delivers reminders. Only allowlisted senders are served.
 */
export class Gateway {
  private conversations = new Map<string, Conversation>();
  private ignored = new Set<string>();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private briefingTimer: ReturnType<typeof setInterval> | null = null;
  readonly scheduler: Scheduler;

  constructor(
    private runtime: Runtime,
    private channels: ChatChannel[],
    private options: GatewayOptions = {},
  ) {
    this.scheduler = new Scheduler(runtime.reminders, (r) => this.deliver(r), options.schedulerIntervalMs);

  }

  async start(): Promise<void> {
    for (const channel of this.channels) {
      await channel.start((message) => void this.receive(channel, message));
    }
    this.startHttp();
    this.scheduler.start();
    if (this.options.briefing) this.briefingTimer = setInterval(() => void this.maybeBrief(), 30_000);
  }

  /** The URL of the HTTP server, if one is running. */
  get url(): string | undefined {
    return this.server ? `http://${this.server.hostname}:${this.server.port}` : undefined;
  }

  private startHttp(): void {
    const routes = Object.assign({}, ...this.channels.map((c) => c.routes?.() ?? {})) as Record<
      string,
      (request: Request) => Response | Promise<Response>
    >;
    if (Object.keys(routes).length === 0) return;
    const { host = "127.0.0.1", port = 8787 } = this.options.http ?? {};
    this.server = Bun.serve({
      hostname: host,
      port,
      fetch: (request) => {
        const route = routes[new URL(request.url).pathname];
        return route ? route(request) : new Response("Not found", { status: 404 });
      },
    });
    console.log(`[gateway] HTTP server on ${this.url}`);
  }

  async stop(): Promise<void> {
    this.scheduler.stop();
    if (this.briefingTimer) clearInterval(this.briefingTimer);
    this.server?.stop(true);
    for (const conversation of this.conversations.values()) conversation.stop();
    await Promise.all(this.channels.map((c) => c.stop().catch(() => {})));
  }

  /** I-9: stops every running request in every chat and blocks risky actions. */
  panic(source: string): void {
    this.runtime.guard.pause(source);
    for (const conversation of this.conversations.values()) conversation.stop();
  }

  resume(): void {
    this.runtime.guard.resume();
  }

  conversation(channel: ChatChannel, chatId: string): Conversation {
    const key = `${channel.name}:${chatId}`;
    let conversation = this.conversations.get(key);
    if (!conversation) {
      conversation = new Conversation(this.runtime, channel, chatId, this, this.options.answerTimeoutMs);
      this.conversations.set(key, conversation);
    }
    return conversation;
  }

  async receive(channel: ChatChannel, message: IncomingMessage): Promise<void> {
    if (!channel.isAllowed(message.senderId)) {
      // Ignore silently (replying would confirm the bot exists), but log each stranger once.
      const key = `${channel.name}:${message.senderId}`;
      if (!this.ignored.has(key)) console.warn(`[${channel.name}] ignoring message from non-allowlisted sender ${message.senderId}`);
      this.ignored.add(key);
      return;
    }
    try {
      await this.conversation(channel, message.chatId).handle(message);
    } catch (error) {
      console.error(`[${channel.name}] error handling message: ${(error as Error).message}`);
    }
  }

  /**
   * Proactive daily briefing: once per day at the configured time, MiniClaw writes
   * to the owner first. Returns true if it was sent now.
   */
  async maybeBrief(now = new Date()): Promise<boolean> {
    const briefing = this.options.briefing;
    if (!briefing || this.runtime.guard.paused) return false;
    const today = now.toLocaleDateString("en-CA"); // YYYY-MM-DD
    const [h, m] = briefing.time.split(":").map(Number);
    const due = new Date(now);
    due.setHours(h!, m!, 0, 0);
    if (now < due) return false;
    if (existsSync(briefing.stateFile) && readFileSync(briefing.stateFile, "utf8").trim() === today) return false;

    const target = this.defaultTarget();
    if (!target) return false;
    // Mark first, so a slow or failed briefing is not retried every 30 seconds.
    writeFileSync(briefing.stateFile, today);
    return this.conversation(target.channel, target.chatId).runTask(BRIEFING_PROMPT, { fresh: true });
  }

  /** Where a reminder goes: the chat it was set in, else the default chat. */
  private target(reminder: Reminder): { channel: ChatChannel; chatId: string } | null {
    const origin = this.runtime.sessions.target(reminder.sessionId);
    const fromChat = origin?.chatId ? this.channels.find((c) => c.name === origin.channel) : undefined;
    if (fromChat && origin?.chatId) return { channel: fromChat, chatId: origin.chatId };
    return this.defaultTarget();
  }

  private defaultTarget(): { channel: ChatChannel; chatId: string } | null {
    if (this.options.defaultChat) {
      const [name, ...rest] = this.options.defaultChat.split(":");
      const channel = this.channels.find((c) => c.name === name);
      if (channel && rest.length) return { channel, chatId: rest.join(":") };
    }
    for (const channel of this.channels) {
      const chatId = channel.defaultChatId();
      if (chatId) return { channel, chatId };
    }
    return null;
  }

  private async deliver(reminder: Reminder): Promise<boolean> {
    if (this.runtime.guard.paused) return false; // /panic also pauses the scheduler
    const target = this.target(reminder);
    if (!target) return false;
    await target.channel.send(target.chatId, `⏰ Reminder: ${reminder.text}`);
    return true;
  }
}
