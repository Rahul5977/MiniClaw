import type { Reminder, ReminderStore } from "./reminders.ts";

/** Returns true if the reminder reached the user; false keeps it pending for a retry. */
export type Deliver = (reminder: Reminder) => Promise<boolean>;

/** Checks for due reminders every `intervalMs` and delivers them. */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  paused = false;

  constructor(
    private store: ReminderStore,
    private deliver: Deliver,
    private intervalMs = 15_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs one check; returns how many reminders were delivered. */
  async tick(now = Date.now()): Promise<number> {
    if (this.paused || this.ticking) return 0;
    this.ticking = true;
    let delivered = 0;
    try {
      for (const reminder of this.store.due(now)) {
        let ok = false;
        try {
          ok = await this.deliver(reminder);
        } catch (error) {
          console.error(`Reminder #${reminder.id} could not be delivered: ${(error as Error).message}`);
        }
        if (ok) {
          this.store.markDelivered(reminder, now);
          delivered++;
        }
      }
    } finally {
      this.ticking = false;
    }
    return delivered;
  }
}
