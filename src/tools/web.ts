import { z } from "zod";
import { assessUrl, maxLevel } from "../security/risk.ts";
import { truncate, untrusted } from "./format.ts";
import { defineTool } from "./tool.ts";

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 8_000;
const MAX_REDIRECTS = 5;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Good-enough HTML → readable text, without a DOM library. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (match, code: string) => {
      if (code[0] === "#") {
        const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : match;
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

export const webFetchTool = defineTool({
  name: "web_fetch",
  description: "Download a web page (http/https) and return its readable text.",
  schema: z.object({
    url: z.string().describe("Full URL starting with http:// or https://"),
  }),
  changesWorkspace: false,
  assess: (args) => assessUrl(args.url),
  summarize: (args) => `fetch ${args.url}`,
  async run(args, ctx) {
    const approved = assessUrl(args.url);
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(ctx.signal ? [ctx.signal] : [])]);
    let url = args.url;
    let response: Response;

    // Follow redirects by hand so each hop is re-checked: an approved public page
    // must not be able to bounce us to localhost or a more dangerous URL.
    for (let hop = 0; ; hop++) {
      response = await fetch(url, { redirect: "manual", signal, headers: { "user-agent": "MiniClaw/1.0" } });
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) break;
      if (hop >= MAX_REDIRECTS) return `Stopped after ${MAX_REDIRECTS} redirects.`;
      const next = new URL(location, url).toString();
      const risk = assessUrl(next);
      if (risk.level === "blocked" || maxLevel(risk.level, approved.level) !== approved.level) {
        return `Refused to follow redirect to ${next}: it ${risk.reasons.at(-1)}. Ask the user to approve that URL directly.`;
      }
      url = next;
    }

    const type = response.headers.get("content-type") ?? "";
    if (!/text|html|json|xml/.test(type) && type) {
      return `${url} returned ${type}, which is not text (status ${response.status}).`;
    }
    const raw = await readCapped(response);
    const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
    const text = type.includes("html") || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw;
    const header = `Status: ${response.status}${title ? `\nTitle: ${htmlToText(title)}` : ""}`;
    return untrusted(`web:${url}`, `${header}\n\n${truncate(text, MAX_TEXT_CHARS)}`);
  },
});
