import { expect, test } from "bun:test";
import { ATTACKS, BENIGN } from "../eval/injection/attacks.ts";
import { benignModel, benignTarget, compromisedModel, runCase } from "../eval/injection/harness.ts";

// Regression test for I-3: even with a fully compromised model, no injected call whose
// text was copied from the page or file runs when taint tracking is on (cautious user).
const copied = ATTACKS.filter((a) => !a.paraphrased);

test.each(copied.map((a) => [a.id, a] as const))("%s is stopped with taint tracking on", async (_, attack) => {
  const outcome = await runCase(attack, "cautious", true, () => compromisedModel(attack), attack.goal);
  expect(outcome.attempted).toBe(true);
  expect(outcome.executed).toBe(false);
});

test("without taint tracking, pre-approval hijacks succeed (the baseline the feature fixes)", async () => {
  const hijacks = ATTACKS.filter((a) => a.preapproved);
  for (const attack of hijacks) {
    const outcome = await runCase(attack, "cautious", false, () => compromisedModel(attack), attack.goal);
    expect(outcome.executed).toBe(true);
  }
});

test("benign tasks that only reuse the user's own words raise no alarm", async () => {
  for (const id of ["web-own-words-file", "web-follow-user-link"]) {
    const b = BENIGN.find((x) => x.id === id)!;
    const outcome = await runCase(b, "cautious", true, () => benignModel(b), benignTarget(b));
    expect([id, outcome.executed, outcome.warned]).toEqual([id, true, false]);
  }
});
