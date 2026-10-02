import { z } from "zod";
import type { SkillGrants } from "../skills/grants.ts";
import type { Skill } from "../skills/loader.ts";
import { describePermission, formatPermission } from "../skills/permissions.ts";
import { defineTool, type Risk } from "./tool.ts";

/** Risk scopes of skill tools start with this, so permission checks can recognize them. */
export const SKILL_SCOPE = "skill:";

/**
 * Each skill is exposed as its own no-argument tool named after the skill. Small models
 * reliably call `weather()` but not `load_skill({"name": "weather"})` — and Ollama silently
 * drops calls to tools that don't exist, so matching the model's instinct matters.
 * Calling the tool asks for consent on first use and returns the skill's instructions.
 */
export function createSkillTool(skill: Skill, grants: SkillGrants) {
  const assessSkill = (): Risk => {
    const scope = `${SKILL_SCOPE}${skill.name}`;
    if (grants.isGranted(skill)) {
      return { level: "low", scope, reasons: [`loads the "${skill.name}" skill you approved`], sessionApprovable: true };
    }
    const intro = grants.wasGrantedBefore(skill)
      ? `skill "${skill.name}" CHANGED since you approved it — review its permissions again`
      : `first use of skill "${skill.name}": ${skill.description}`;
    const asks = skill.permissions.length
      ? skill.permissions.map((p) => `it may ${describePermission(p)} (${formatPermission(p)})`)
      : ["it asks for no permissions (it can only give instructions)"];
    return { level: "high", scope, reasons: [intro, ...asks], sessionApprovable: false };
  };

  return defineTool({
    name: skill.name,
    description: `Skill: ${skill.description} Call this first (no arguments); it returns the instructions to follow.`,
    schema: z.object({}),
    changesWorkspace: false,
    targetHint: "nothing (leave empty)",
    assess: assessSkill,
    assessTarget: assessSkill,
    summarize: () => `use skill ${skill.name}`,
    async run(_args, ctx) {
      // Small models often call the skill again instead of taking the next step.
      if (ctx.activeSkills?.has(skill.name)) {
        return `Skill "${skill.name}" is already active and its instructions are above. Do the next step now by calling the tool they name (not "${skill.name}" again).`;
      }
      // Reaching run() means the user approved (or had approved this exact version).
      if (!grants.isGranted(skill)) grants.grant(skill);
      ctx.activeSkills?.set(skill.name, skill.permissions);

      const allowed = skill.permissions.length
        ? skill.permissions.map(describePermission).join("; ")
        : "nothing beyond giving instructions";
      return [
        `Skill "${skill.name}" is active. Now complete the user's request by following these instructions:`,
        `<skill name="${skill.name}">`,
        skill.instructions,
        "</skill>",
        `While this skill is active it is only allowed to: ${allowed}. Anything else needs the user's explicit approval.`,
      ].join("\n");
    },
  });
}
