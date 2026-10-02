/**
 * I-6: Skill permission manifests. A skill declares what it needs in its SKILL.md
 * frontmatter, like an Android app. Permissions only *restrict*: a call inside them
 * still goes through the normal approval policy; a call outside them is escalated.
 *
 *   fs:read          read files and folders in the workspace
 *   fs:write         create or change files in the workspace (implies fs:read)
 *   net:<host>       fetch from a host; "*.example.com" for subdomains, "*" for any
 *   shell:<program>  run a simple command with this program; "*" for any command
 *   memory           propose memories and read the daily notes
 */
export type Permission =
  | { kind: "fs"; access: "read" | "write" }
  | { kind: "net"; host: string }
  | { kind: "shell"; program: string }
  | { kind: "memory" };

const HOST = /^(\*|(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+|localhost)$/i;
const PROGRAM = /^(\*|[a-z0-9._-]+)$/i;

export function parsePermission(raw: string): Permission {
  const text = raw.trim();
  if (text === "fs:read" || text === "fs:write") return { kind: "fs", access: text.slice(3) as "read" | "write" };
  if (text === "memory") return { kind: "memory" };
  if (text.startsWith("net:") && HOST.test(text.slice(4))) return { kind: "net", host: text.slice(4).toLowerCase() };
  if (text.startsWith("shell:") && PROGRAM.test(text.slice(6))) return { kind: "shell", program: text.slice(6) };
  throw new Error(`unknown permission "${raw}" (use fs:read, fs:write, net:<host>, shell:<program> or memory)`);
}

export function formatPermission(p: Permission): string {
  switch (p.kind) {
    case "fs":
      return `fs:${p.access}`;
    case "net":
      return `net:${p.host}`;
    case "shell":
      return `shell:${p.program}`;
    case "memory":
      return "memory";
  }
}

/** Plain-language description for the consent prompt. */
export function describePermission(p: Permission): string {
  switch (p.kind) {
    case "fs":
      return p.access === "read" ? "read files in your workspace" : "create and change files in your workspace";
    case "net":
      return p.host === "*" ? "connect to ANY website" : `connect to ${p.host}`;
    case "shell":
      return p.program === "*" ? "run ANY shell command" : `run the \`${p.program}\` command`;
    case "memory":
      return "propose memories and read your daily notes";
  }
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) || host === pattern.slice(2);
  return host === pattern;
}

/**
 * Whether a tool call, identified by its risk scope ("tool:target"), is covered.
 * Scopes come from the tools' own assess(), e.g. "web_fetch:wttr.in", "run_shell:ls".
 */
export function permits(permissions: Permission[], tool: string, scope: string): boolean {
  // Calling another skill's tool only returns instructions; it is always allowed.
  if (scope.startsWith("skill:")) return true;
  const target = scope.slice(scope.indexOf(":") + 1).toLowerCase();
  return permissions.some((p) => {
    switch (tool) {
      case "read_file":
      case "list_dir":
        return p.kind === "fs";
      case "write_file":
        return p.kind === "fs" && p.access === "write";
      case "web_fetch":
        return p.kind === "net" && hostMatches(p.host, target);
      case "run_shell":
        // A simple command's scope is just its program; compound commands need shell:*.
        return p.kind === "shell" && (p.program === "*" || (!target.includes(" ") && p.program.toLowerCase() === target));
      case "remember":
      case "recall_notes":
        return p.kind === "memory";
      default:
        return false;
    }
  });
}
