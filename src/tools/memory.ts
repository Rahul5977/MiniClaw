import { z } from "zod";
import { addDays, today } from "../memory/facts.ts";
import type { DailyNotes } from "../memory/notes.ts";
import type { MemoryInbox } from "../memory/inbox.ts";
import { makeRisk } from "../security/risk.ts";
import { truncate, untrusted } from "./format.ts";
import { defineTool } from "./tool.ts";

export function createRememberTool(inbox: MemoryInbox) {
  return defineTool({
    name: "remember",
    description:
      "Propose a lasting fact about the user (preference, personal detail, ongoing situation) for long-term memory. " +
      "The user confirms it before it is saved. Write it in third person, e.g. 'User is vegetarian.'",
    schema: z.object({
      fact: z.string().min(3).max(300).describe("One short fact, third person"),
      expires_in_days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("Only for temporary facts, e.g. 7 for 'this week'"),
    }),
    changesWorkspace: false,
    targetHint: "the fact",
    // Low risk: it only adds to the inbox. Nothing is saved until the user accepts it (I-5).
    assess: () => makeRisk("low", "remember", ["proposes a memory; you confirm before it is saved"]),
    assessTarget: () => makeRisk("low", "remember", ["proposes a memory; you confirm before it is saved"]),
    summarize: (args) => `remember "${args.fact}"`,
    async run(args, ctx) {
      const expires = args.expires_in_days ? addDays(today(), args.expires_in_days) : undefined;
      const proposal = inbox.propose({
        fact: args.fact,
        sessionId: ctx.sessionId,
        expires,
        untrustedSources: ctx.untrustedSources ? [...ctx.untrustedSources] : [],
      });
      return proposal
        ? `Proposed for memory: "${proposal.fact}". It will be saved only after the user confirms it.`
        : `Already known or already waiting for confirmation: "${args.fact}".`;
    },
  });
}

export function createRecallNotesTool(notes: DailyNotes) {
  const risk = () => makeRisk("low", "recall_notes", ["reads MiniClaw's own daily log"]);
  return defineTool({
    name: "recall_notes",
    description: "Read the daily log of what the user asked and what you did on a given day.",
    schema: z.object({
      date: z
        .string()
        .regex(/^(today|yesterday|\d{4}-\d{2}-\d{2})$/)
        .default("today")
        .describe('"today", "yesterday" or a date like 2026-10-01'),
    }),
    changesWorkspace: false,
    targetHint: "the date",
    assess: risk,
    assessTarget: risk,
    summarize: (args) => `recall notes for ${args.date}`,
    async run(args) {
      const date = args.date === "today" ? today() : args.date === "yesterday" ? addDays(today(), -1) : args.date;
      const content = notes.read(date);
      // The log quotes user messages and tool summaries, so it is treated as data.
      return content ? untrusted(`notes:${date}`, truncate(content, 6000)) : `No notes for ${date}.`;
    },
  });
}
