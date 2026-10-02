import { expect, test } from "bun:test";
import { openDatabase } from "../src/db/database.ts";
import { ReminderStore, resolveWhen } from "../src/scheduler/reminders.ts";
import { Scheduler } from "../src/scheduler/scheduler.ts";
import { createReminderTools } from "../src/tools/reminders.ts";

const now = new Date("2026-10-02T15:00:00");
const at = (s: string) => new Date(s).getTime();

test("resolveWhen understands minutes, clock times and dates", () => {
  expect(resolveWhen({ in_minutes: 30 }, now)).toBe(at("2026-10-02T15:30:00"));
  expect(resolveWhen({ at: "18:00" }, now)).toBe(at("2026-10-02T18:00:00"));
  expect(resolveWhen({ at: "09:30" }, now)).toBe(at("2026-10-03T09:30:00")); // passed today → tomorrow
  expect(resolveWhen({ at: "2026-10-05 07:15" }, now)).toBe(at("2026-10-05T07:15:00"));
});

test("resolveWhen explains bad input", () => {
  expect(resolveWhen({}, now)).toContain("Give in_minutes");
  expect(resolveWhen({ in_minutes: 5, at: "10:00" }, now)).toContain("not both");
  expect(resolveWhen({ at: "tomorrow" }, now)).toContain("Could not understand");
  expect(resolveWhen({ at: "25:00" }, now)).toContain("not a valid time");
  expect(resolveWhen({ at: "2026-01-01 10:00" }, now)).toContain("in the past");
});

test("one-off reminders are delivered once; failed deliveries are retried", async () => {
  const store = new ReminderStore(openDatabase(":memory:"));
  store.add({ sessionId: "s", text: "call mom", dueAt: at("2026-10-02T15:00:00") });
  store.add({ sessionId: "s", text: "later", dueAt: at("2026-10-02T20:00:00") });

  let online = false;
  const sent: string[] = [];
  const scheduler = new Scheduler(store, async (r) => {
    if (online) sent.push(r.text);
    return online;
  });
  expect(await scheduler.tick(at("2026-10-02T15:01:00"))).toBe(0); // channel offline
  online = true;
  expect(await scheduler.tick(at("2026-10-02T15:02:00"))).toBe(1);
  expect(await scheduler.tick(at("2026-10-02T15:03:00"))).toBe(0);
  expect(sent).toEqual(["call mom"]);
  expect(store.pending().map((r) => r.text)).toEqual(["later"]);
});

test("repeating reminders move to the next future occurrence", async () => {
  const store = new ReminderStore(openDatabase(":memory:"));
  store.add({ sessionId: "s", text: "water plants", dueAt: at("2026-09-28T08:00:00"), repeat: "daily" });
  await new Scheduler(store, async () => true).tick(at("2026-10-02T08:30:00"));
  expect(store.pending()[0]?.dueAt).toBe(at("2026-10-03T08:00:00")); // missed days are skipped, not spammed
});

test("a paused scheduler delivers nothing", async () => {
  const store = new ReminderStore(openDatabase(":memory:"));
  store.add({ sessionId: "s", text: "x", dueAt: 0 });
  const scheduler = new Scheduler(store, async () => true);
  scheduler.paused = true;
  expect(await scheduler.tick()).toBe(0);
});

test("reminder tools set, list and cancel", async () => {
  const store = new ReminderStore(openDatabase(":memory:"));
  const { setReminder: set, listReminders: list, cancelReminder: cancel } = createReminderTools(store);
  const ctx = { workspace: "/tmp", sessionId: "telegram:abc" };
  expect(await set.run({ text: "stretch", in_minutes: 10, repeat: "daily" }, ctx)).toMatch(/Reminder #1 set for .*, then daily: "stretch"/);
  expect(await set.run({ text: "x", at: "nonsense" }, ctx)).toContain("Error: Could not understand");
  expect(store.pending()[0]).toMatchObject({ sessionId: "telegram:abc", repeat: "daily" });
  expect(await list.run({}, ctx)).toMatch(/^#1 .* \(daily\): stretch$/);
  expect(await cancel.run({ id: 1 }, ctx)).toBe('Cancelled reminder #1: "stretch".');
  expect(await cancel.run({ id: 1 }, ctx)).toBe("There is no upcoming reminder #1.");
  expect(await list.run({}, ctx)).toBe("No upcoming reminders.");
});
