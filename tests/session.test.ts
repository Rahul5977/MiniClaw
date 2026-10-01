import { expect, test } from "bun:test";
import { Session } from "../src/agent/session.ts";

test("messages start with the system prompt", () => {
  const session = new Session("sys", 10);
  session.add({ role: "user", content: "hi" });
  expect(session.messages()).toEqual([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
});

test("history is trimmed and never starts with an assistant turn", () => {
  const session = new Session("sys", 3);
  for (let i = 0; i < 3; i++) {
    session.add({ role: "user", content: `q${i}` });
    session.add({ role: "assistant", content: `a${i}` });
  }
  const [, first] = session.messages();
  expect(session.length).toBeLessThanOrEqual(3);
  expect(first?.role).toBe("user");
  expect(first?.content).toBe("q2");
});

test("popUser removes a dangling user message", () => {
  const session = new Session("sys", 10);
  session.add({ role: "user", content: "hi" });
  session.popUser();
  expect(session.length).toBe(0);
});
