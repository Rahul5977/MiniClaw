import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Gateway } from "../gateway/gateway.ts";
import type { Runtime } from "../runtime.ts";
import { formatPermission, describePermission } from "../skills/permissions.ts";

export interface DashboardOptions {
  runtime: Runtime;
  /** Where the login token is kept (created on first start, readable only by you). */
  tokenFile: string;
  /** Present when running inside the gateway: enables live approvals and panic across chats. */
  gateway?: Gateway;
}

const COOKIE = "miniclaw_session";
const CSRF_HEADER = "x-miniclaw-csrf";
const PUBLIC_DIR = join(import.meta.dir, "public");
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
const MAX_FILE_EDIT = 100_000;

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

function loadToken(file: string): string {
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dirname(file), { recursive: true });
  const token = randomBytes(24).toString("hex");
  writeFileSync(file, token + "\n");
  chmodSync(file, 0o600);
  return token;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: SECURITY_HEADERS });
}

const error = (status: number, message: string) => json({ error: message }, status);

type Handler = (request: Request, params: string[]) => unknown | Promise<unknown>;

/**
 * The web dashboard's HTTP handler. Security, since it can approve actions and edit memory:
 * - localhost only (Host header checked, which also blocks DNS rebinding and tunnels like ngrok)
 * - a secret token: the printed link sets an HttpOnly, SameSite=Strict cookie
 * - every write needs a custom header, which other sites can't send (CSRF)
 * - strict CSP and no framing
 */
export function createDashboard(options: DashboardOptions) {
  const { runtime, gateway } = options;
  const token = loadToken(options.tokenFile);
  const tokenBytes = Buffer.from(token);

  const validToken = (candidate: string | null | undefined) => {
    if (!candidate) return false;
    const given = Buffer.from(candidate);
    return given.length === tokenBytes.length && timingSafeEqual(given, tokenBytes);
  };
  const cookieToken = (request: Request) =>
    request.headers
      .get("cookie")
      ?.split(";")
      .map((c) => c.trim().split("="))
      .find(([name]) => name === COOKIE)?.[1];
  const authenticated = (request: Request) =>
    validToken(cookieToken(request)) || validToken(request.headers.get("authorization")?.replace(/^Bearer /, ""));

  const localHost = (request: Request) => {
    const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  };

  const routes: [method: string, pattern: RegExp, handler: Handler][] = [];
  const route = (method: string, path: string, handler: Handler) =>
    routes.push([method, new RegExp(`^${path.replace(/:\w+/g, "([^/]+)")}$`), handler]);

  // --- API -------------------------------------------------------------------------------
  route("GET", "/api/overview", () => {
    const startOfDay = new Date().setHours(0, 0, 0, 0);
    return {
      agent: runtime.config.agent.name,
      model: runtime.llm.model,
      workspace: runtime.workspace,
      paused: runtime.guard.pausedInfo(),
      budgets: runtime.guard.usage(),
      gateway: gateway ? { channels: gateway.channelNames } : null,
      counts: {
        facts: runtime.facts.all().length,
        inbox: runtime.inbox.pending().length,
        reminders: runtime.reminders.pending().length,
        skills: runtime.skills.length,
        runsToday: runtime.runs.list(1000).filter((r) => r.startedAt >= startOfDay).length,
        approvals: gateway?.pendingQuestions().length ?? 0,
      },
      recentRuns: runtime.runs.list(8),
    };
  });

  route("GET", "/api/runs", (request) => {
    const url = new URL(request.url);
    const before = Number(url.searchParams.get("before")) || undefined;
    return runtime.runs.list(Math.min(Number(url.searchParams.get("limit")) || 50, 200), before);
  });
  route("GET", "/api/runs/:id", (_, [id]) => runtime.runs.get(decodeURIComponent(id!)) ?? error(404, "No such run"));

  route("GET", "/api/sessions", () => runtime.sessions.list(100));
  route("GET", "/api/sessions/:id", (_, [id]) => runtime.sessions.load(decodeURIComponent(id!)));

  route("GET", "/api/audit", (request) => runtime.audit.recent(Math.min(Number(new URL(request.url).searchParams.get("limit")) || 100, 500)));

  route("GET", "/api/memory", () => ({
    facts: runtime.facts.all(),
    inbox: runtime.inbox.pending(),
    memoryFile: { path: runtime.facts.path, content: existsSync(runtime.facts.path) ? readFileSync(runtime.facts.path, "utf8") : "" },
    identityFile: { path: runtime.identityPath, content: existsSync(runtime.identityPath) ? readFileSync(runtime.identityPath, "utf8") : "" },
  }));
  route("PUT", "/api/memory/file", async (request) => saveFile(runtime.facts.path, request));
  route("PUT", "/api/identity", async (request) => saveFile(runtime.identityPath, request));
  route("DELETE", "/api/facts/:id", (_, [id]) => ({ removed: runtime.facts.remove([id!]).length }));
  route("POST", "/api/inbox/:id", async (request, [id]) => {
    const { decision } = (await request.json()) as { decision?: string };
    if (decision === "keep") return { ok: runtime.inbox.accept(Number(id)) !== null };
    if (decision === "discard") return { ok: runtime.inbox.reject(Number(id)) };
    return error(400, 'decision must be "keep" or "discard"');
  });

  route("GET", "/api/skills", () => ({
    skills: runtime.skills.map((s) => ({
      name: s.name,
      description: s.description,
      permissions: s.permissions.map((p) => ({ id: formatPermission(p), description: describePermission(p) })),
      status: runtime.grants.isGranted(s) ? "approved" : runtime.grants.wasGrantedBefore(s) ? "changed" : "not yet used",
    })),
    problems: runtime.skillProblems,
  }));
  route("POST", "/api/skills/:name/revoke", (_, [name]) => {
    runtime.grants.revoke(decodeURIComponent(name!));
    return { ok: true };
  });

  route("GET", "/api/reminders", () => runtime.reminders.pending());
  route("DELETE", "/api/reminders/:id", (_, [id]) => ({ ok: runtime.reminders.cancel(Number(id)) !== null }));

  route("POST", "/api/panic", () => {
    if (gateway) gateway.panic("the dashboard");
    else runtime.guard.pause("the dashboard");
    return { paused: runtime.guard.pausedInfo() };
  });
  route("POST", "/api/resume", () => {
    runtime.guard.resume();
    return { paused: null };
  });

  route("GET", "/api/approvals", () => ({ live: !!gateway, questions: gateway?.pendingQuestions() ?? [] }));
  route("POST", "/api/approvals/:key", async (request, [key]) => {
    if (!gateway) return error(409, "Live approvals need `miniclaw gateway`");
    const { choice } = (await request.json()) as { choice?: string };
    return gateway.answerQuestion(decodeURIComponent(key!), String(choice)) ? { ok: true } : error(409, "That question is no longer open");
  });

  async function saveFile(path: string, request: Request) {
    const { content } = (await request.json()) as { content?: unknown };
    if (typeof content !== "string") return error(400, "content must be a string");
    if (content.length > MAX_FILE_EDIT) return error(413, "File too large");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content.endsWith("\n") ? content : content + "\n");
    return { ok: true };
  }

  // --- Request handling ------------------------------------------------------------------
  async function handle(request: Request): Promise<Response> {
    if (!localHost(request)) return new Response("The dashboard is only available on localhost.", { status: 403 });
    const url = new URL(request.url);

    // Login link: ?token=… sets the cookie and redirects to a clean URL.
    const linkToken = url.searchParams.get("token");
    if (linkToken !== null) {
      if (!validToken(linkToken)) return new Response("Invalid token", { status: 401, headers: SECURITY_HEADERS });
      return new Response(null, {
        status: 303,
        headers: {
          ...SECURITY_HEADERS,
          location: "/",
          "set-cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
        },
      });
    }

    const file = STATIC[url.pathname];
    if (file && request.method === "GET") {
      // The stylesheet is harmless and also styles the login-needed page.
      const name = authenticated(request) || file === "style.css" ? file : file === "index.html" ? "locked.html" : null;
      if (!name) return error(401, "Not logged in");
      return new Response(Bun.file(join(PUBLIC_DIR, name)), {
        headers: { ...SECURITY_HEADERS, "content-type": TYPES[name.split(".").pop()!]! },
      });
    }

    if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    if (!authenticated(request)) return error(401, "Not logged in: open the link printed in the terminal");
    if (request.method !== "GET" && request.headers.get(CSRF_HEADER) !== "1") return error(403, "Missing CSRF header");

    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(url.pathname);
      if (match && method === request.method) {
        try {
          const result = await handler(request, match.slice(1));
          return result instanceof Response ? result : json(result);
        } catch (e) {
          return error(500, (e as Error).message);
        }
      }
    }
    return error(404, "Unknown API route");
  }

  return { handle, token };
}

/** The link that logs a browser in. */
export function dashboardLink(host: string, port: number, token: string): string {
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${shown}:${port}/?token=${token}`;
}
