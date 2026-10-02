import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "../src/skills/loader.ts";

const root = mkdtempSync(join(tmpdir(), "miniclaw-skills-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function skill(folder: string, content: string) {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "SKILL.md"), content);
}

skill(
  "weather",
  `---
name: weather
description: Get the current weather for a city.
permissions:
  - net:wttr.in
---
# Weather
Call web_fetch with https://wttr.in/<city>?format=3
`,
);
skill("bad-yaml", "---\nname: [oops\n---\nbody");
skill("wrong-name", "---\nname: other\ndescription: A skill with the wrong name.\n---\nbody");
skill("bad-perm", "---\nname: bad-perm\ndescription: Wants something unknown.\npermissions: [root:everything]\n---\nbody");
skill("empty", "---\nname: empty\ndescription: Has no instructions at all.\n---\n");
skill("too-long", `---\nname: too-long\ndescription: Instructions far too long.\n---\n${"x".repeat(5000)}`);
mkdirSync(join(root, "no-file"));

const { skills, problems } = loadSkills(root);

test("valid skills are loaded with parsed permissions", () => {
  expect(skills).toHaveLength(1);
  expect(skills[0]).toMatchObject({
    name: "weather",
    description: "Get the current weather for a city.",
    permissions: [{ kind: "net", host: "wttr.in" }],
    instructions: "# Weather\nCall web_fetch with https://wttr.in/<city>?format=3",
  });
});

test("broken skills are reported with a reason", () => {
  const byFolder = Object.fromEntries(problems.map((p) => [p.dir.split("/").at(-1), p.error]));
  expect(byFolder["bad-yaml"]).toContain("invalid YAML");
  expect(byFolder["wrong-name"]).toContain('must match its folder "wrong-name"');
  expect(byFolder["bad-perm"]).toContain("unknown permission");
  expect(byFolder["empty"]).toContain("no instructions");
  expect(byFolder["too-long"]).toContain("keep them under");
  expect(byFolder["no-file"]).toBe("missing SKILL.md");
});

test("a missing skills folder is fine", () => {
  expect(loadSkills(join(root, "nope"))).toEqual({ skills: [], problems: [] });
});
