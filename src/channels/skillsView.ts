import type { SkillGrants } from "../skills/grants.ts";
import type { Skill, SkillProblem } from "../skills/loader.ts";
import { describePermission, formatPermission } from "../skills/permissions.ts";

const color = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const dim = color(2);
const red = color(31);
const green = color(32);
const yellow = color(33);
const bold = color(1);

/** Human-readable list of installed skills, their permissions and consent status. */
export function formatSkills(skills: Skill[], problems: SkillProblem[], grants: SkillGrants, root: string): string {
  const lines: string[] = [];
  if (skills.length === 0 && problems.length === 0) {
    lines.push(dim(`No skills installed. Add one as ${root}/<name>/SKILL.md`));
  }
  for (const skill of skills) {
    const status = grants.isGranted(skill)
      ? green("approved")
      : grants.wasGrantedBefore(skill)
        ? yellow("changed — will ask again")
        : yellow("asks on first use");
    lines.push(`${bold(skill.name)} ${dim("—")} ${skill.description} ${dim("[")}${status}${dim("]")}`);
    if (skill.permissions.length === 0) lines.push(dim("    permissions: none"));
    for (const p of skill.permissions) {
      const broad = (p.kind === "net" && p.host === "*") || (p.kind === "shell" && p.program === "*");
      lines.push(`    ${(broad ? red : dim)(`${formatPermission(p)}`)} ${dim("·")} ${describePermission(p)}`);
    }
  }
  for (const problem of problems) lines.push(red(`✖ ${problem.dir}: ${problem.error}`));
  return lines.join("\n");
}
