import { expect, test } from "bun:test";
import { Session } from "../src/agent/session.ts";
import { openDatabase } from "../src/db/database.ts";
import { SessionStore } from "../src/db/sessions.ts";

const options = (historyLimit = 10) => ({ id: "s", systemPrompt: () => "sys", historyLimit });

test("messages start with the system prompt", () => {
  const session = new Session(options());
  session.addTurn([{ role: "user", content: "hi" }]);
  expect(session.messages()).toEqual([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
});

test("old turns are left out whole, newest turn is always kept", () => {
  const session = new Session(options(3));
  session.addTurn([{ role: "user", content: "q0" }, { role: "assistant", content: "a0" }]);
  session.addTurn([
    { role: "user", content: "q1" },
    { role: "assistant", content: "", toolCalls: [{ id: "c", name: "t", arguments: "{}" }] },
    { role: "tool", toolCallId: "c", content: "r" },
    { role: "assistant", content: "a1" },
  ]);
  const messages = session.messages();
  expect(messages).toHaveLength(5);
  expect(messages[1]).toEqual({ role: "user", content: "q1" });
});

test("a turn must start with a user message", () => {
  expect(() => new Session(options()).addTurn([{ role: "assistant", content: "x" }])).toThrow();
});

test("turns survive a restart through the store", () => {
  const store = new SessionStore(openDatabase(":memory:"));
  const id = store.create("cli");
  const turn = [
    { role: "user" as const, content: "save it" },
    { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: '{"path":"a"}' }] },
    { role: "tool" as const, toolCallId: "c1", content: "Wrote" },
    { role: "assistant" as const, content: "Saved." },
  ];
  new Session({ ...options(), id, store }).addTurn(turn);
  new Session({ ...options(), id, store }).addTurn([{ role: "user", content: "thanks" }, { role: "assistant", content: "np" }]);

  const reopened = new Session({ ...options(), id, store });
  expect(reopened.turnCount).toBe(2);
  expect(reopened.messages().slice(1, 5)).toEqual(turn);
  expect(store.latest("cli")).toMatchObject({ id, title: "save it" });
  expect(store.latest("telegram")).toBeNull();
});
