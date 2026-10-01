import { expect, test } from "bun:test";
import { Session } from "../src/agent/session.ts";

test("messages start with the system prompt", () => {
  const session = new Session("sys", 10);
  session.addTurn([{ role: "user", content: "hi" }]);
  expect(session.messages()).toEqual([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
});

test("old turns are dropped whole, newest turn is always kept", () => {
  const session = new Session("sys", 3);
  session.addTurn([{ role: "user", content: "q0" }, { role: "assistant", content: "a0" }]);
  session.addTurn([
    { role: "user", content: "q1" },
    { role: "assistant", content: "", toolCalls: [{ id: "c", name: "t", arguments: "{}" }] },
    { role: "tool", toolCallId: "c", content: "r" },
    { role: "assistant", content: "a1" },
  ]);
  expect(session.length).toBe(4);
  expect(session.messages()[1]).toEqual({ role: "user", content: "q1" });
});

test("a turn must start with a user message", () => {
  expect(() => new Session("sys", 3).addTurn([{ role: "assistant", content: "x" }])).toThrow();
});
