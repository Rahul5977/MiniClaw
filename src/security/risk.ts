import dns from "node:dns/promises";
import { isIP } from "node:net";
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
  ["high", /(^|[\s=<>"'])(\/(?!dev\/null)|~)|(^|[^.\w])\.\.([^.\w]|$)/, "uses paths outside the workspace"],
  ["high", /\.env\b|id_rsa|id_ed25519|\.ssh\b|\.aws\b|\.gnupg\b|keychain|\.netrc\b/i, "touches files that usually hold secrets"],
  ["high", /\$\(|`|\beval\b|\bexec\b|\bsource\b/, "builds commands dynamically (hard to check)"],
  ["high", /\|\s*(sh|bash|zsh|dash|python3?|node|bun|perl|ruby|php)\b/, "pipes data into an interpreter (runs hidden code)"],
  ["high", /\.git\b/, "touches a .git directory"],
];

/**
 * The shell drops quotes and backslashes before running a word, so `s''udo` and `r\m` are
 * sudo and rm. Rules are checked against both the raw command and this unquoted form.
 */
const unquote = (command: string) => command.replace(/['"\\]/g, "");

/** Characters that make a command more than "one program with arguments". */
const COMPOUND = /[|;&<>`$(){}\n\\]/;

export function assessShellCommand(command: string): Risk {
  let level: RiskLevel = "medium";
  const reasons: string[] = [];
  const unquoted = unquote(command);
  for (const [ruleLevel, pattern, reason] of SHELL_RULES) {
    if (pattern.test(command) || pattern.test(unquoted)) {
      level = maxLevel(level, ruleLevel);
      reasons.push(reason);
    }
  }
  if (reasons.length === 0) reasons.push("runs a shell command in the workspace");

  const program = unquoted.trim().split(/\s+/)[0] ?? "";
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
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1?\]?|\[?f[cd][0-9a-f:]*\]?|\[?fe[89ab][0-9a-f:]*\]?)$/i;

/**
 * IPv4-mapped IPv6 as the IPv4 address it reaches: `[::ffff:7f00:1]` (how URL writes
 * ::ffff:127.0.0.1) or `::ffff:127.0.0.1` (how DNS lookups may return it).
 */
function unmapIpv6(host: string): string {
  const dotted = host.match(/^\[?::ffff:(\d+\.\d+\.\d+\.\d+)\]?$/i);
  if (dotted) return dotted[1]!;
  const mapped = host.match(/^\[?::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]?$/i);
  if (!mapped) return host;
  const [hi, lo] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

const isPrivateHost = (host: string) => PRIVATE_HOST.test(host) || PRIVATE_HOST.test(unmapIpv6(host));

/** Query values or path segments longer than this look like smuggled data. */
const LONG_VALUE = 48;
/** Path segments get more room: article slugs are often long. */
const LONG_SEGMENT = 64;
const LONG_TOTAL = 120;

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

  if (isPrivateHost(host)) {
    level = "high";
    reasons.push("reaches your computer or local network");
  }
  // Long query values or path segments are how injected instructions smuggle data out
  // ("?q=<your notes>" or "/<your notes in base64>").
  const values = [...url.searchParams.values()];
  const segments = url.pathname.split("/");
  if (
    url.search.length > LONG_TOTAL ||
    values.some((v) => v.length > LONG_VALUE) ||
    url.pathname.length > LONG_TOTAL ||
    segments.some((s) => s.length > LONG_SEGMENT)
  ) {
    level = "high";
    reasons.push("sends a lot of data in the URL (possible data leak)");
  }
  if (url.username || url.password) {
    level = "high";
    reasons.push("contains credentials in the URL");
  }
  return { level, reasons, scope: `web_fetch:${host}`, sessionApprovable: level === "medium" };
}

const LOOKUP_TIMEOUT_MS = 3_000;

/** Every address a host name resolves to; IP literals are returned as they are. */
export async function resolveHost(host: string): Promise<string[]> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return [bare];
  const lookup = dns.lookup(bare, { all: true, verbatim: true });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`looking up ${bare} took too long`)), LOOKUP_TIMEOUT_MS).unref(),
  );
  return (await Promise.race([lookup, timeout])).map((a) => a.address);
}

/**
 * The private address a public-looking host name resolves to, if any. Names like
 * 127.0.0.1.nip.io, or a DNS rebinding attack, would otherwise pass assessUrl's
 * name check and reach your computer or local network. Throws if the lookup fails.
 */
export async function privateAddressBehind(raw: string): Promise<string | null> {
  const host = new URL(raw).hostname;
  if (isPrivateHost(host)) return null; // already judged as local by assessUrl
  return (await resolveHost(host)).find(isPrivateHost) ?? null;
}

/** assessUrl plus a DNS lookup: blocks public names that lead to a private address. */
export async function assessUrlResolved(raw: string): Promise<Risk> {
  const risk = assessUrl(raw);
  if (risk.level === "blocked") return risk;
  let address: string | null;
  try {
    address = await privateAddressBehind(raw);
  } catch {
    return risk; // unresolvable now; web_fetch looks it up again before connecting
  }
  if (!address) return risk;
  return {
    ...risk,
    level: "blocked",
    reasons: [
      ...risk.reasons,
      `resolves to ${address} on your computer or local network (use that address or a .local name directly if you meant it)`,
    ],
    sessionApprovable: false,
  };
}
