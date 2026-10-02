import type { Runtime } from "../runtime.ts";
import type { Reminder } from "../scheduler/reminders.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import type { ChatChannel, IncomingMessage } from "./channel.ts";
import { Conversation } from "./conversation.ts";

export interface GatewayOptions {
  /** "<channel>:<chatId>" for reminders made outside a chat app (e.g. in the CLI). */
  defaultChat?: string;
  answerTimeoutMs?: number;
  schedulerIntervalMs?: number;
}

/**
 * The long-running process: receives messages from every chat app, routes each chat
 * to its own Conversation, and delivers reminders. Only allowlisted senders are served.
 */
export class Gateway {
  private conversations = new Map<string, Conversation>();
  private ignored = new Set<string>();
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
    this.scheduler.start();
  }

  async stop(): Promise<void> {
    this.scheduler.stop();
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

  /** Where a reminder goes: the chat it was set in, else the default chat. */
  private target(reminder: Reminder): { channel: ChatChannel; chatId: string } | null {
    const origin = this.runtime.sessions.target(reminder.sessionId);
    const fromChat = origin?.chatId ? this.channels.find((c) => c.name === origin.channel) : undefined;
    if (fromChat && origin?.chatId) return { channel: fromChat, chatId: origin.chatId };

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
