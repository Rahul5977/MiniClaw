import type { Risk, RiskLevel } from "../tools/tool.ts";

/**
 * I-4: Rule-based, explainable risk scoring. No model is involved, so a prompt
 * injection cannot talk its way past these rules. Every rule carries a reason
 * that is shown to the user in the approval prompt.
 */

const ORDER: RiskLevel[] = ["low", "medium", "high", "blocked"];

export function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

export function makeRisk(level: RiskLevel, scope: string, reasons: string[] = []): Risk {
  return { level, scope, reasons, sessionApprovable: level === "low" || level === "medium" };
}

type Rule = [level: RiskLevel, pattern: RegExp, reason: string];

const SHELL_RULES: Rule[] = [
  ["blocked", /\b(sudo|doas)\b|(^|[;&|]\s*)su(\s|$)/, "runs as administrator"],
  ["blocked", /\brm\s+(-\S+\s+)*("|')?(\/|~\/?|\$HOME\/?)("|')?(\s|\*|$)/, "deletes the root or home directory"],
  ["blocked", /\bmkfs\b|\bdd\b[^|]*\bof=\/dev\/|>\s*\/dev\/(sd|disk|nvme|hd)/, "writes directly to a disk"],
  ["blocked", /:\(\)\s*\{.*\};\s*:/, "is a fork bomb"],
  ["blocked", /\b(shutdown|reboot|halt|poweroff)\b/, "shuts down the computer"],
  ["blocked", /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|bun)\b/, "runs code downloaded from the internet"],
  ["high", /\brm\b|\bunlink\b|\bfind\b.*\s-delete\b/, "deletes files"],
  ["high", /\b(curl|wget|nc|ncat|ssh|scp|sftp|rsync|ftp|telnet)\b/, "uses the network (could send data out)"],
  ["high", /\b(chmod|chown)\b/, "changes file permissions"],
  ["high", /\b(kill|pkill|killall)\b/, "stops running programs"],
  ["high", /\b(npm|pnpm|yarn|bun|pip3?|brew|apt(-get)?|cargo|gem)\s+(i|install|add|remove|uninstall)\b/, "installs or removes software"],
  ["high", /\bgit\s+(push|reset|clean|remote)\b/, "changes a git repository"],
  ["high", /(^|[\s=<>"'])(\/(?!dev\/null)|~)|\.\.\//, "uses paths outside the workspace"],
  ["high", /\.env\b|id_rsa|id_ed25519|\.ssh\b|\.aws\b|\.gnupg\b|keychain|\.netrc\b/i, "touches files that usually hold secrets"],
  ["high", /\$\(|`|\beval\b|\bexec\b|\bsource\b/, "builds commands dynamically (hard to check)"],
  ["high", /\.git\b/, "touches a .git directory"],
];

/** Characters that make a command more than "one program with arguments". */
const COMPOUND = /[|;&<>`$(){}\n\\]/;

export function assessShellCommand(command: string): Risk {
  let level: RiskLevel = "medium";
  const reasons: string[] = [];
  for (const [ruleLevel, pattern, reason] of SHELL_RULES) {
    if (pattern.test(command)) {
      level = maxLevel(level, ruleLevel);
      reasons.push(reason);
    }
  }
  if (reasons.length === 0) reasons.push("runs a shell command in the workspace");

  const program = command.trim().split(/\s+/)[0] ?? "";
  const simple = !COMPOUND.test(command);
  return {
    level,
    reasons,
    // A simple command can be session-approved per program ("always allow `ls`").
    scope: simple ? `run_shell:${program}` : `run_shell:${command.trim()}`,
    sessionApprovable: simple && level === "medium",
  };
}

const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f:]*\]?)$/i;

export function assessUrl(raw: string): Risk {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return makeRisk("blocked", `web_fetch:${raw}`, ["is not a valid URL"]);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return makeRisk("blocked", `web_fetch:${raw}`, [`uses the ${url.protocol} scheme (only http/https allowed)`]);
  }

  const host = url.hostname;
  let level: RiskLevel = "medium";
  const reasons: string[] = [`downloads content from ${host} (treated as untrusted)`];

  if (PRIVATE_HOST.test(host)) {
    level = "high";
    reasons.push("reaches your computer or local network");
  }
  // Long query values are how injected instructions smuggle data out ("?q=<your notes>").
  const values = [...url.searchParams.values()];
  if (url.search.length > 120 || values.some((v) => v.length > 48)) {
    level = "high";
    reasons.push("sends a lot of data in the URL (possible data leak)");
  }
  if (url.username || url.password) {
    level = "high";
    reasons.push("contains credentials in the URL");
  }
  return { level, reasons, scope: `web_fetch:${host}`, sessionApprovable: level === "medium" };
}
