import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parsePermission, type Permission } from "./permissions.ts";

export interface Skill {
  name: string;
  description: string;
  permissions: Permission[];
  /** The Markdown body: instructions the agent follows once the skill is loaded. */
  instructions: string;
  dir: string;
  /** Hash of SKILL.md. Consent is asked again if the file changes. */
  hash: string;
}

export interface SkillProblem {
  dir: string;
  error: string;
}

/** Instructions are sent to the model, so they must fit a small context window. */
export const MAX_INSTRUCTION_CHARS = 4000;

const FrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits and dashes only"),
  description: z.string().min(10).max(300),
  permissions: z.array(z.string()).default([]),
});

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkill(dir: string, folderName: string, source: string): Skill {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error("SKILL.md must start with a --- frontmatter block ---");

  let data: unknown;
  try {
    data = Bun.YAML.parse(match[1]!);
  } catch (error) {
    throw new Error(`invalid YAML frontmatter: ${(error as Error).message}`);
  }
  const parsed = FrontmatterSchema.safeParse(data);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error).replaceAll("\n", " "));

  const { name, description, permissions } = parsed.data;
  if (name !== folderName) throw new Error(`name "${name}" must match its folder "${folderName}"`);

  const instructions = match[2]!.trim();
  if (!instructions) throw new Error("SKILL.md has no instructions after the frontmatter");
  if (instructions.length > MAX_INSTRUCTION_CHARS) {
    throw new Error(`instructions are ${instructions.length} characters; keep them under ${MAX_INSTRUCTION_CHARS}`);
  }

  return {
    name,
    description: description.replace(/\s+/g, " ").trim(),
    permissions: permissions.map(parsePermission),
    instructions,
    dir,
    hash: Bun.hash(source).toString(36),
  };
}

/** Loads every skills/<name>/SKILL.md. Broken skills are reported, not fatal. */
export function loadSkills(root: string): { skills: Skill[]; problems: SkillProblem[] } {
  const skills: Skill[] = [];
  const problems: SkillProblem[] = [];
  if (!existsSync(root)) return { skills, problems };

  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(root, entry.name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) {
      problems.push({ dir, error: "missing SKILL.md" });
      continue;
    }
    try {
      skills.push(parseSkill(dir, entry.name, readFileSync(file, "utf8")));
    } catch (error) {
      problems.push({ dir, error: (error as Error).message });
    }
  }
  return { skills, problems };
}
