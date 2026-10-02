import { z } from "zod";
import { makeRisk } from "../security/risk.ts";
import type { SkillGrants } from "../skills/grants.ts";
import type { Skill } from "../skills/loader.ts";
import { describePermission, formatPermission } from "../skills/permissions.ts";
import { defineTool, type Risk } from "./tool.ts";

export function createLoadSkillTool(skills: Skill[], grants: SkillGrants) {
  const find = (name: string) => skills.find((s) => s.name === name.trim().toLowerCase());

  /** First use (or a changed SKILL.md) needs the user's consent, like installing an app. */
  const assessName = (name: string): Risk => {
    const skill = find(name);
    if (!skill) return makeRisk("low", `load_skill:${name}`, ["unknown skill"]);
    if (grants.isGranted(skill)) return makeRisk("low", `load_skill:${skill.name}`, [`loads the "${skill.name}" skill you approved`]);

    const intro = grants.wasGrantedBefore(skill)
      ? `skill "${skill.name}" CHANGED since you approved it — review its permissions again`
      : `first use of skill "${skill.name}": ${skill.description}`;
    const asks = skill.permissions.length
      ? skill.permissions.map((p) => `it may ${describePermission(p)} (${formatPermission(p)})`)
      : ["it asks for no permissions (it can only give instructions)"];
    return { level: "high", scope: `load_skill:${skill.name}`, reasons: [intro, ...asks], sessionApprovable: false };
  };

  return defineTool({
    name: "load_skill",
    description: "Load a skill's instructions before doing a task that the skill covers.",
    schema: z.object({ name: z.string().describe("Skill name from the list of skills") }),
    changesWorkspace: false,
    targetHint: "skill name",
    assess: (args) => assessName(args.name),
    assessTarget: assessName,
    summarize: (args) => `load skill ${args.name}`,
    async run(args, ctx) {
      const skill = find(args.name);
      if (!skill) {
        return `Unknown skill "${args.name}". Available skills: ${skills.map((s) => s.name).join(", ") || "none"}.`;
      }
      // Reaching run() means the user approved (or had approved this exact version).
      if (!grants.isGranted(skill)) grants.grant(skill);
      ctx.activeSkills?.set(skill.name, skill.permissions);

      const allowed = skill.permissions.length
        ? skill.permissions.map(describePermission).join("; ")
        : "nothing beyond giving instructions";
      return [
        `Skill "${skill.name}" loaded. Follow these instructions for this task:`,
        `<skill name="${skill.name}">`,
        skill.instructions,
        "</skill>",
        `While this skill is active it is only allowed to: ${allowed}. Anything else needs the user's explicit approval.`,
      ].join("\n");
    },
  });
}
