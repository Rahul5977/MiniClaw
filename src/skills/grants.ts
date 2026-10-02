import type { Database } from "bun:sqlite";
import type { Skill } from "./loader.ts";
import { formatPermission } from "./permissions.ts";

/** Remembers which exact version (hash) of each skill the user approved. */
export class SkillGrants {
  constructor(private db: Database) {}

  isGranted(skill: Skill): boolean {
    return !!this.db.query("SELECT 1 FROM skill_grants WHERE name = ? AND hash = ?").get(skill.name, skill.hash);
  }

  /** True if an older version of this skill was approved (so the change can be pointed out). */
  wasGrantedBefore(skill: Skill): boolean {
    return !!this.db.query("SELECT 1 FROM skill_grants WHERE name = ? AND hash != ?").get(skill.name, skill.hash);
  }

  grant(skill: Skill): void {
    this.db
      .query("INSERT OR REPLACE INTO skill_grants (name, hash, permissions, granted_at) VALUES (?, ?, ?, ?)")
      .run(skill.name, skill.hash, JSON.stringify(skill.permissions.map(formatPermission)), Date.now());
  }

  revoke(name: string): void {
    this.db.query("DELETE FROM skill_grants WHERE name = ?").run(name);
  }
}
