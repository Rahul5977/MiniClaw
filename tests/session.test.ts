import { expect, test } from "bun:test";
import { Session, type TurnMessage } from "../src/agent/session.ts";
import { messagesTokens } from "../src/agent/tokens.ts";
import { openDatabase } from "../src/db/database.ts";
import { SessionStore } from "../src/db/sessions.ts";

const options = { id: "s", systemPrompt: () => "sys" };
const BIG = 10_000;
const words = (n: number) => "word ".repeat(n);

test("context = system prompt + history + in-progress turn", () => {
  const session = new Session(options);
  session.addTurn([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
  expect(session.context([{ role: "user", content: "next" }], BIG)).toEqual([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "next" },
  ]);
});

test("oldest whole turns are left out when over budget", () => {
  const session = new Session(options);
  session.addTurn([{ role: "user", content: words(200) }, { role: "assistant", content: "old" }]);
  session.addTurn([
    { role: "user", content: "q1" },
    { role: "assistant", content: "", toolCalls: [{ id: "c", name: "t", arguments: "{}" }] },
    { role: "tool", toolCallId: "c", content: "r" },
    { role: "assistant", content: "a1" },
  ]);
  const context = session.context([{ role: "user", content: "now" }], 100);
  expect(context.map((m) => m.content)).toEqual(["sys", "q1", "", "r", "a1", "now"]);
  expect(messagesTokens(context)).toBeLessThanOrEqual(100);
});

test("an oversized in-progress turn has its older tool outputs shortened", () => {
  const pending: TurnMessage[] = [
    { role: "user", content: "read both" },
    { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read_file", arguments: "{}" }] },
    { role: "tool", toolCallId: "a", content: words(300) },
    { role: "assistant", content: "", toolCalls: [{ id: "b", name: "read_file", arguments: "{}" }] },
    { role: "tool", toolCallId: "b", content: words(300) },
  ];
  const context = new Session(options).context(pending, 600);
  expect(context[3]?.content).toContain("removed to fit");
  expect(context[5]?.content).toBe(words(300));
});

test("a turn must start with a user message", () => {
  expect(() => new Session(options).addTurn([{ role: "assistant", content: "x" }])).toThrow();
});

test("turns survive a restart through the store", () => {
  const store = new SessionStore(openDatabase(":memory:"));
  const id = store.create("cli");
  const turn: TurnMessage[] = [
    { role: "user", content: "save it" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: '{"path":"a"}' }] },
    { role: "tool", toolCallId: "c1", content: "Wrote" },
    { role: "assistant", content: "Saved." },
  ];
  new Session({ ...options, id, store }).addTurn(turn);
  new Session({ ...options, id, store }).addTurn([{ role: "user", content: "thanks" }, { role: "assistant", content: "np" }]);

  const reopened = new Session({ ...options, id, store });
  expect(reopened.turnCount).toBe(2);
  expect(reopened.context([], BIG).slice(1, 5)).toEqual(turn);
  expect(store.latest("cli")).toMatchObject({ id, title: "save it" });
  expect(store.latest("telegram")).toBeNull();
});

test("each chat has its own latest session, separate from the CLI", () => {
  const store = new SessionStore(openDatabase(":memory:"));
  const cli = store.create("cli");
  const alice = store.create("telegram", "111");
  const bob = store.create("telegram", "222");
  expect(store.latest("cli")?.id).toBe(cli);
  expect(store.latest("telegram", "111")?.id).toBe(alice);
  expect(store.latest("telegram", "222")?.id).toBe(bob);
  expect(store.latest("telegram")).toBeNull();
  expect(store.target(bob)).toEqual({ channel: "telegram", chatId: "222" });
  expect(store.target(cli)).toEqual({ channel: "cli", chatId: null });
});
