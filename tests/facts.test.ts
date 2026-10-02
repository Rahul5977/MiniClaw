import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDays, FactStore } from "../src/memory/facts.ts";

const root = mkdtempSync(join(tmpdir(), "miniclaw-facts-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const day = (d: string) => new Date(`${d}T10:00:00`);

test("facts are written as readable Markdown and read back", () => {
  const store = new FactStore(join(root, "a/MEMORY.md"));
  store.add("User is vegetarian.", undefined, day("2026-10-02"));
  store.add("User is in Goa this week.", "2026-10-09", day("2026-10-02"));

  const file = readFileSync(store.path, "utf8");
  expect(file).toStartWith("# Memory");
  expect(file).toContain("- User is vegetarian. <!-- added:2026-10-02 -->");
  expect(file).toContain("- User is in Goa this week. <!-- added:2026-10-02 expires:2026-10-09 -->");
  expect(store.all(day("2026-10-02")).map((f) => f.text)).toEqual(["User is vegetarian.", "User is in Goa this week."]);
});

test("expired facts disappear and can be cleaned up", () => {
  const store = new FactStore(join(root, "b/MEMORY.md"));
  store.add("Temporary", "2026-10-09", day("2026-10-02"));
  expect(store.all(day("2026-10-09"))).toHaveLength(1); // still valid on the last day
  expect(store.all(day("2026-10-10"))).toHaveLength(0);
  expect(store.removeExpired(day("2026-10-10")).map((f) => f.text)).toEqual(["Temporary"]);
  expect(readFileSync(store.path, "utf8")).not.toContain("Temporary");
});

test("hand-written lines are understood and other lines are preserved", () => {
  const path = join(root, "c/MEMORY.md");
  new FactStore(path).add("seed");
  writeFileSync(path, "# Memory\n\n## Food\n- Loves biryani\n* Hates okra <!-- added:2026-01-01 -->\n");
  const store = new FactStore(path);
  expect(store.all().map((f) => f.text)).toEqual(["Loves biryani", "Hates okra"]);

  const [okra] = store.search("OKRA");
  store.remove([okra!.id]);
  expect(readFileSync(path, "utf8")).toBe("# Memory\n\n## Food\n- Loves biryani\n");
});

test("duplicates are ignored and facts can't inject metadata or new lines", () => {
  const store = new FactStore(join(root, "d/MEMORY.md"));
  store.add("Likes tea");
  store.add("likes tea ");
  store.add("Evil\n- second fact <!-- expires:1999-01-01 -->");
  expect(store.all().map((f) => f.text)).toEqual(["Likes tea", "Evil - second fact expires:1999-01-01"]);
});

test("addDays handles month ends", () => {
  expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
});
