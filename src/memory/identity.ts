import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function defaultIdentity(name: string): string {
  return `# Identity

<!-- Edit this file to change ${name}'s personality and rules.
     Keep it short: it is sent with every message. Comments like this one are not sent. -->

You are ${name}, a helpful personal AI assistant running locally on the user's computer.
Be concise and friendly. If you are not sure about something, say so instead of guessing.
`;
}

/** Reads IDENTITY.md (creating it on first run), without HTML comments or the title. */
export function loadIdentity(path: string, name: string): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, defaultIdentity(name));
  }
  return readFileSync(path, "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^# .*\n/, "")
    .trim();
}
