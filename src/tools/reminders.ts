import { z } from "zod";
import { formatDue, resolveWhen, type ReminderStore } from "../scheduler/reminders.ts";
import { makeRisk } from "../security/risk.ts";
import { defineTool } from "./tool.ts";

// Reminders only send the user a message later, so they are low risk.
const lowRisk = (scope: string) => () => makeRisk("low", scope, ["only sends you a message later"]);

export function createReminderTools(store: ReminderStore) {
  const setReminder = defineTool({
    name: "set_reminder",
    description:
      "Remind the user about something later by sending them a message. " +
      'Give either in_minutes (e.g. 30) or at ("18:00" or "2026-10-03 09:30", 24-hour local time).',
    schema: z.object({
      text: z.string().min(1).max(300).describe("What to remind the user about"),
      in_minutes: z.number().int().min(1).max(60 * 24 * 365).optional(),
      at: z.string().optional().describe('"HH:MM" or "YYYY-MM-DD HH:MM", local time'),
      repeat: z.enum(["daily", "weekly"]).optional().describe("Only for repeating reminders"),
    }),
    changesWorkspace: false,
    changesState: true,
    targetHint: "the reminder text",
    assess: lowRisk("set_reminder"),
    assessTarget: lowRisk("set_reminder"),
    summarize: (args) => `remind "${args.text}"`,
    async run(args, ctx) {
      const due = resolveWhen(args);
      if (typeof due === "string") return `Error: ${due}`;
      const reminder = store.add({ sessionId: ctx.sessionId ?? "cli", text: args.text, dueAt: due, repeat: args.repeat });
      const repeat = args.repeat ? `, then ${args.repeat}` : "";
      return `Reminder #${reminder.id} set for ${formatDue(due)}${repeat}: "${reminder.text}". It is delivered while \`miniclaw gateway\` is running.`;
    },
  });

  const listReminders = defineTool({
    name: "list_reminders",
    description: "List the user's upcoming reminders.",
    schema: z.object({}),
    changesWorkspace: false,
    targetHint: "nothing",
    assess: lowRisk("list_reminders"),
    assessTarget: lowRisk("list_reminders"),
    summarize: () => "list reminders",
    async run() {
      const pending = store.pending();
      if (pending.length === 0) return "No upcoming reminders.";
      return pending.map((r) => `#${r.id} ${formatDue(r.dueAt)}${r.repeat ? ` (${r.repeat})` : ""}: ${r.text}`).join("\n");
    },
  });

  const cancelReminder = defineTool({
    name: "cancel_reminder",
    description: "Cancel an upcoming reminder by its number (see list_reminders).",
    schema: z.object({ id: z.number().int().positive() }),
    changesWorkspace: false,
    changesState: true,
    targetHint: "reminder number",
    assess: lowRisk("cancel_reminder"),
    assessTarget: lowRisk("cancel_reminder"),
    summarize: (args) => `cancel reminder #${args.id}`,
    async run(args) {
      const cancelled = store.cancel(args.id);
      return cancelled ? `Cancelled reminder #${cancelled.id}: "${cancelled.text}".` : `There is no upcoming reminder #${args.id}.`;
    },
  });

  return { setReminder, listReminders, cancelReminder };
}
