// MiniClaw dashboard. Plain JavaScript, no build step.
// Everything shown here may contain untrusted text (web pages, files), so the page is
// built with DOM methods and textContent only — never innerHTML with data.

const main = document.getElementById("main");

// ---- helpers -------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-miniclaw-csrf": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    location.reload(); // shows the "open the login link" page
    throw new Error("Not logged in");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2500);
}

const fmtTime = (t) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtShortTime = (t) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const runDuration = (r) => (r.endedAt ? fmtMs(r.endedAt - r.startedAt) : "running…");
const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const STATUS_TAG = { done: "ok", running: "info", step_limit: "warn", stopped: "warn", error: "bad" };
const RISK_TAG = { low: "", medium: "warn", high: "bad", blocked: "bad" };
const VERDICT_TAG = { auto: "", session: "info", plan: "info", approved: "ok", denied: "warn", blocked: "bad", invalid: "bad" };
const tag = (text, kind = "") => h("span", { class: `tag ${kind}` }, text);

function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Width class (w0…w100) for a meter, in steps of 10%. */
const widthClass = (fraction) => `w${Math.min(100, Math.round(Math.max(0, fraction) * 10) * 10)}`;

function empty(text) {
  return h("div", { class: "empty" }, text);
}

// ---- top bar -------------------------------------------------------------------------

let paused = false;
async function refreshTopbar() {
  try {
    const o = await api("/api/overview");
    document.getElementById("agent-name").textContent = o.agent;
    document.getElementById("model").textContent = `${o.model}${o.gateway ? ` · ${o.gateway.channels.join(", ")}` : " · dashboard only"}`;
    paused = !!o.paused;
    const pill = document.getElementById("status-pill");
    pill.textContent = paused ? "⛔ Paused" : "▶ Running";
    pill.className = `pill ${paused ? "bad" : "ok"}`;
    pill.title = o.paused ?? "";
    const button = document.getElementById("panic-button");
    button.textContent = paused ? "Resume" : "Panic";
    button.className = paused ? "ok" : "danger";
    setBadge("approvals-badge", o.counts.approvals);
    setBadge("inbox-badge", o.counts.inbox);
  } catch {
    /* shown on next navigation */
  }
}

function setBadge(id, count) {
  const el = document.getElementById(id);
  el.textContent = String(count);
  el.classList.toggle("hidden", !count);
}

document.getElementById("panic-button").addEventListener("click", async () => {
  if (!paused && !confirm("Panic: stop all running work and block risky actions until you resume?")) return;
  await api(paused ? "/api/resume" : "/api/panic", { method: "POST" });
  toast(paused ? "Resumed" : "Paused: risky actions are blocked");
  await refreshTopbar();
  route();
});

// ---- pages ---------------------------------------------------------------------------

async function overviewPage() {
  const o = await api("/api/overview");
  const stat = (value, label, href) => h("a", { class: "stat", href }, h("div", { class: "value" }, value), h("div", { class: "label" }, label));
  return h(
    "div",
    {},
    h("h1", {}, "Overview"),
    o.paused && h("div", { class: "card" }, tag("Paused", "bad"), " ", o.paused, ". Risky actions are blocked; reading still works."),
    h(
      "div",
      { class: "cards" },
      stat(o.counts.runsToday, "runs today", "#/runs"),
      stat(o.counts.approvals, o.gateway ? "approvals waiting" : "approvals (needs gateway)", "#/approvals"),
      stat(o.counts.facts, "things remembered", "#/memory"),
      stat(o.counts.inbox, "memories to review", "#/memory"),
      stat(o.counts.reminders, "upcoming reminders", "#/reminders"),
      stat(o.counts.skills, "skills", "#/skills"),
    ),
    h("h2", {}, "Today's action budgets"),
    h(
      "div",
      { class: "card stack" },
      o.budgets.map((b) => {
        const fraction = b.limit ? b.used / b.limit : 1;
        return h(
          "div",
          { class: "row" },
          h("code", {}, b.tool.padEnd(10)),
          h("div", { class: "meter" }, h("div", { class: `${widthClass(fraction)} ${fraction >= 1 ? "bad" : fraction >= 0.7 ? "warn" : ""}` })),
          h("span", { class: "muted" }, `${b.used} / ${b.limit}`),
        );
      }),
    ),
    h("h2", {}, "Recent runs"),
    runsTable(o.recentRuns),
    h("p", { class: "muted" }, "Workspace: ", h("code", {}, o.workspace)),
  );
}

function runsTable(runs) {
  if (!runs.length) return empty("No runs yet. Chat with MiniClaw and they appear here.");
  return h(
    "table",
    {},
    h("thead", {}, h("tr", {}, ["Started", "Request", "Status", "Steps", "Tools", "Time"].map((t) => h("th", {}, t)))),
    h(
      "tbody",
      {},
      runs.map((r) =>
        h(
          "tr",
          { class: "clickable", onclick: () => (location.hash = `#/runs/${encodeURIComponent(r.id)}`) },
          h("td", {}, fmtShortTime(r.startedAt)),
          h("td", { class: "text", title: r.userText }, r.userText),
          h("td", {}, tag(r.status.replace("_", " "), STATUS_TAG[r.status])),
          h("td", {}, r.steps),
          h("td", {}, r.toolCalls),
          h("td", {}, runDuration(r)),
        ),
      ),
    ),
  );
}

async function runsPage() {
  const runs = await api("/api/runs?limit=50");
  const container = h("div", {}, runsTable(runs));
  let oldest = runs.at(-1)?.startedAt;
  const more = h("button", {
    class: runs.length < 50 ? "hidden" : "",
    onclick: async () => {
      const next = await api(`/api/runs?limit=50&before=${oldest}`);
      oldest = next.at(-1)?.startedAt;
      container.append(runsTable(next));
      if (next.length < 50) more.classList.add("hidden");
    },
  }, "Load more");
  return h(
    "div",
    {},
    h("h1", {}, "Flight recorder"),
    h("p", { class: "muted" }, "Every agent run is recorded: what the model was asked, what it answered, and every tool call. Click a run to step through it."),
    container,
    h("p", {}, more),
  );
}

async function runPage(id) {
  const run = await api(`/api/runs/${encodeURIComponent(id)}`);
  const system = run.context.find((m) => m.role === "system");
  const history = run.context.filter((m) => m.role !== "system");
  return h(
    "div",
    {},
    h("p", {}, h("a", { href: "#/runs" }, "← All runs")),
    h("h1", {}, short(run.userText, 120)),
    h(
      "div",
      { class: "row" },
      tag(run.status.replace("_", " "), STATUS_TAG[run.status]),
      tag(run.model, "info"),
      h("span", { class: "muted" }, `${fmtTime(run.startedAt)} · ${runDuration(run)} · ${run.steps} model steps · ${run.toolCalls} tool calls · ~${run.promptTokens.toLocaleString()} prompt tokens`),
    ),
    run.error && h("pre", {}, run.error),
    h(
      "details",
      { class: "card" },
      h("summary", {}, `Starting context: system prompt + ${history.length} messages, ${run.tools.length} tools`),
      h("h2", {}, "System prompt"),
      h("pre", {}, system?.content ?? ""),
      h("h2", {}, "Conversation so far"),
      history.map((m) => h("pre", {}, `${m.role}: ${m.content}${m.toolCalls ? `\n→ ${m.toolCalls.map((c) => `${c.name}(${c.arguments})`).join(", ")}` : ""}`)),
      h("h2", {}, "Tools offered"),
      h("p", {}, run.tools.map((t) => h("code", {}, t.name)).flatMap((c) => [c, " "])),
    ),
    h("h2", {}, "Timeline"),
    run.events.length ? h("div", { class: "timeline" }, run.events.map(eventView)) : empty("No events recorded."),
    h("h2", {}, "Replay"),
    h(
      "div",
      { class: "card" },
      h("p", {}, "Re-run this exact situation with another model, without executing any tools (recorded results are fed back):"),
      h("pre", {}, `bun src/index.ts replay ${run.id} --model llama3.1:8b --times 5`),
    ),
  );
}

function eventView(event) {
  const when = h("div", { class: "when" }, `+${fmtMs(event.at)}`);
  if (event.type === "llm") {
    const d = event.data;
    return h(
      "div",
      { class: "event llm" },
      when,
      h(
        "div",
        { class: "card" },
        h("div", { class: "spread" }, h("span", { class: "title" }, `Model step ${d.step + 1}`), h("span", { class: "muted" }, `${fmtMs(d.durationMs)} · ~${d.promptTokens} tokens in`)),
        d.nudge && h("p", {}, tag("nudged", "warn"), " ", h("span", { class: "muted" }, d.nudge)),
        d.text ? h("pre", {}, d.text) : h("p", { class: "muted" }, d.toolCalls.length ? "(no text)" : "(empty reply)"),
        d.toolCalls.length > 0 && h("div", { class: "chips" }, d.toolCalls.map((c) => tag(`→ ${c.name}`, "info"))),
      ),
    );
  }
  if (event.type === "tool") {
    const d = event.data;
    const bad = !d.ok;
    return h(
      "div",
      { class: `event tool ${bad ? "bad" : ""}` },
      when,
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "spread" },
          h("span", { class: "title" }, d.summary ?? d.name),
          h("span", { class: "row" }, d.risk && tag(d.risk, RISK_TAG[d.risk]), tag(d.verdict, VERDICT_TAG[d.verdict]), h("span", { class: "muted" }, fmtMs(d.durationMs))),
        ),
        d.reasons?.length > 0 && h("ul", {}, d.reasons.map((r) => h("li", { class: "muted" }, r))),
        d.changes?.length > 0 && h("div", { class: "chips" }, d.changes.map((c) => tag(c.replace("\t", " "), "ok"))),
        h("details", {}, h("summary", {}, "Arguments"), h("pre", {}, prettyJson(d.arguments))),
        h("details", {}, h("summary", {}, `Result${d.ok ? "" : " (failed)"}`), h("pre", {}, d.output)),
      ),
    );
  }
  return h("div", { class: "event notice" }, when, h("div", { class: "card" }, "⚠ ", event.data.message));
}

async function approvalsPage() {
  const { live, questions } = await api("/api/approvals");
  if (!live) {
    return h("div", {}, h("h1", {}, "Approvals"), empty("Live approvals work while MiniClaw runs as `bun run gateway`. The dashboard opened by `miniclaw dashboard` alone can't see chats."));
  }
  return h(
    "div",
    {},
    h("h1", {}, "Approvals"),
    h("p", { class: "muted" }, "Questions waiting for an answer in your chats. Answer here or in the chat app. This page refreshes itself."),
    questions.length === 0
      ? empty("Nothing is waiting for you.")
      : questions.map((q) =>
          h(
            "div",
            { class: "card" },
            h("div", { class: "row" }, tag(q.channel, "info"), h("span", { class: "muted" }, q.chatId)),
            h("p", { class: "question" }, q.text),
            h(
              "div",
              { class: "row" },
              q.choices.map((c) =>
                h(
                  "button",
                  {
                    class: c.id === "yes" || c.id === "keep" ? "ok" : c.id === "no" || c.id === "discard" ? "danger" : "",
                    onclick: async () => {
                      await api(`/api/approvals/${encodeURIComponent(q.key)}`, { method: "POST", body: { choice: c.id } });
                      toast(`Answered: ${c.label}`);
                      route();
                    },
                  },
                  c.label,
                ),
              ),
            ),
          ),
        ),
  );
}

async function sessionsPage() {
  const sessions = await api("/api/sessions");
  if (!sessions.length) return h("div", {}, h("h1", {}, "Conversations"), empty("No conversations yet."));
  return h(
    "div",
    {},
    h("h1", {}, "Conversations"),
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, ["Last active", "Channel", "Started with", "Messages"].map((t) => h("th", {}, t)))),
      h(
        "tbody",
        {},
        sessions.map((s) =>
          h(
            "tr",
            { class: "clickable", onclick: () => (location.hash = `#/sessions/${encodeURIComponent(s.id)}`) },
            h("td", {}, fmtShortTime(s.updatedAt)),
            h("td", {}, tag(s.channel, "info"), s.chatId ? h("span", { class: "muted" }, ` ${s.chatId}`) : null),
            h("td", { class: "text" }, s.title ?? h("span", { class: "muted" }, "(empty)")),
            h("td", {}, s.turns),
          ),
        ),
      ),
    ),
  );
}

async function sessionPage(id) {
  const turns = await api(`/api/sessions/${encodeURIComponent(id)}`);
  return h(
    "div",
    {},
    h("p", {}, h("a", { href: "#/sessions" }, "← All conversations")),
    h("h1", {}, "Conversation"),
    turns.length === 0
      ? empty("No messages.")
      : turns.map((turn) =>
          h(
            "div",
            { class: "turn" },
            turn.map((m) => {
              if (m.role === "user") return h("div", { class: "bubble user" }, m.content);
              if (m.role === "tool") return h("details", {}, h("summary", {}, "Tool result"), h("pre", {}, m.content));
              return h(
                "div",
                {},
                m.content && h("div", { class: "bubble assistant" }, m.content),
                m.toolCalls?.length > 0 && h("div", { class: "chips" }, m.toolCalls.map((c) => tag(`⚙ ${c.name}`, "info"))),
              );
            }),
          ),
        ),
  );
}

async function memoryPage() {
  const m = await api("/api/memory");
  const editor = (title, file, endpoint, hint) => {
    const area = h("textarea", { spellcheck: "false" });
    area.value = file.content;
    return h(
      "div",
      { class: "card" },
      h("div", { class: "spread" }, h("strong", {}, title), h("code", { class: "muted" }, file.path)),
      h("p", { class: "muted" }, hint),
      area,
      h("p", {}, h("button", { class: "primary", onclick: async () => {
        await api(endpoint, { method: "PUT", body: { content: area.value } });
        toast(`${title} saved`);
        route();
      } }, "Save")),
    );
  };
  return h(
    "div",
    {},
    h("h1", {}, "Memory"),
    h("h2", {}, `Waiting for review (${m.inbox.length})`),
    m.inbox.length === 0
      ? h("p", { class: "muted" }, "No proposed memories. The agent can only propose facts; nothing is saved until you keep it.")
      : m.inbox.map((p) =>
          h(
            "div",
            { class: "card" },
            h("p", {}, `“${p.fact}”`, p.expires ? h("span", { class: "muted" }, ` until ${p.expires}`) : null),
            p.untrustedSources.length > 0 && h("p", {}, tag("possible prompt injection", "bad"), " ", h("span", { class: "muted" }, `proposed after reading ${p.untrustedSources.join(", ")}`)),
            h(
              "div",
              { class: "row" },
              h("button", { class: "ok", onclick: async () => { await api(`/api/inbox/${p.id}`, { method: "POST", body: { decision: "keep" } }); route(); } }, "Keep"),
              h("button", { onclick: async () => { await api(`/api/inbox/${p.id}`, { method: "POST", body: { decision: "discard" } }); route(); } }, "Discard"),
            ),
          ),
        ),
    h("h2", {}, `What MiniClaw knows about you (${m.facts.length})`),
    m.facts.length === 0
      ? h("p", { class: "muted" }, "Nothing yet.")
      : h(
          "div",
          { class: "card stack" },
          m.facts.map((f) =>
            h(
              "div",
              { class: "spread" },
              h("span", {}, f.text, f.expires ? h("span", { class: "muted" }, ` (until ${f.expires})`) : null),
              h("button", { class: "small", onclick: async () => {
                if (!confirm(`Forget "${f.text}"?`)) return;
                await api(`/api/facts/${encodeURIComponent(f.id)}`, { method: "DELETE" });
                route();
              } }, "Forget"),
            ),
          ),
        ),
    h("h2", {}, "Edit by hand"),
    editor("MEMORY.md", m.memoryFile, "/api/memory/file", "One fact per line, starting with “- ”. The hidden <!-- --> part holds the date added and expiry."),
    editor("IDENTITY.md", m.identityFile, "/api/identity", "MiniClaw's personality and rules. Sent with every message, so keep it short."),
  );
}

async function skillsPage() {
  const { skills, problems } = await api("/api/skills");
  return h(
    "div",
    {},
    h("h1", {}, "Skills"),
    h("p", { class: "muted" }, "Each skill declares what it may do. Anything outside those permissions needs your approval while the skill is active."),
    skills.length === 0 && empty("No skills installed. Add one as skills/<name>/SKILL.md."),
    skills.map((s) =>
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "spread" },
          h("strong", {}, s.name),
          h("span", { class: "row" }, tag(s.status, s.status === "approved" ? "ok" : s.status === "changed" ? "warn" : ""),
            s.status !== "not yet used" && h("button", { class: "small", onclick: async () => {
              await api(`/api/skills/${encodeURIComponent(s.name)}/revoke`, { method: "POST" });
              toast(`${s.name} will ask for consent again`);
              route();
            } }, "Revoke")),
        ),
        h("p", {}, s.description),
        s.permissions.length === 0
          ? h("p", { class: "muted" }, "No permissions: instructions only.")
          : h("ul", {}, s.permissions.map((p) => h("li", {}, h("code", {}, p.id), " ", h("span", { class: "muted" }, p.description)))),
      ),
    ),
    problems.length > 0 && h("h2", {}, "Skipped skills"),
    problems.map((p) => h("div", { class: "card" }, tag("error", "bad"), " ", h("code", {}, p.dir), " ", p.error)),
  );
}

async function remindersPage() {
  const reminders = await api("/api/reminders");
  return h(
    "div",
    {},
    h("h1", {}, "Reminders"),
    h("p", { class: "muted" }, "Delivered by the gateway to the chat they were set in."),
    reminders.length === 0
      ? empty("No upcoming reminders. Try: “remind me to stretch every day at 11:00”.")
      : h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["#", "When", "Repeats", "Reminder", ""].map((t) => h("th", {}, t)))),
          h(
            "tbody",
            {},
            reminders.map((r) =>
              h(
                "tr",
                {},
                h("td", {}, r.id),
                h("td", {}, fmtShortTime(r.dueAt)),
                h("td", {}, r.repeat ?? "–"),
                h("td", {}, r.text),
                h("td", {}, h("button", { class: "small", onclick: async () => { await api(`/api/reminders/${r.id}`, { method: "DELETE" }); route(); } }, "Cancel")),
              ),
            ),
          ),
        ),
  );
}

async function auditPage() {
  const entries = await api("/api/audit?limit=300");
  const search = h("input", { type: "search", placeholder: "Filter by tool, verdict or text…" });
  const body = h("tbody");
  const render = () => {
    const q = search.value.toLowerCase();
    body.replaceChildren(
      ...entries
        .filter((e) => !q || `${e.tool} ${e.verdict} ${e.risk} ${e.summary}`.toLowerCase().includes(q))
        .map((e) =>
          h(
            "tr",
            {},
            h("td", {}, fmtTime(e.time)),
            h("td", {}, h("code", {}, e.tool)),
            h("td", { class: "text", title: e.summary }, e.summary),
            h("td", {}, tag(e.risk, RISK_TAG[e.risk])),
            h("td", {}, tag(e.verdict, VERDICT_TAG[e.verdict])),
            h("td", {}, e.ok ? "✔" : "✖"),
            h("td", { class: "muted" }, e.session),
          ),
        ),
    );
  };
  search.addEventListener("input", render);
  render();
  return h(
    "div",
    {},
    h("div", { class: "spread" }, h("h1", {}, "Audit log"), search),
    h("p", { class: "muted" }, "Every tool call, with its risk level and who allowed it. Secrets are redacted."),
    entries.length === 0
      ? empty("No tool calls yet.")
      : h("table", {}, h("thead", {}, h("tr", {}, ["Time", "Tool", "What", "Risk", "Verdict", "OK", "Session"].map((t) => h("th", {}, t)))), body),
  );
}

// ---- router --------------------------------------------------------------------------

const PAGES = {
  overview: overviewPage,
  approvals: approvalsPage,
  runs: runsPage,
  sessions: sessionsPage,
  memory: memoryPage,
  skills: skillsPage,
  reminders: remindersPage,
  audit: auditPage,
};
const DETAIL = { runs: runPage, sessions: sessionPage };
/** Pages that refresh themselves while open. */
const LIVE = new Set(["overview", "approvals"]);

let renderId = 0;
async function route() {
  const [page = "overview", id] = location.hash.replace(/^#\/?/, "").split("/");
  const name = PAGES[page] ? page : "overview";
  for (const a of document.querySelectorAll(".sidebar a")) a.classList.toggle("active", a.dataset.page === name);
  const id_ = ++renderId;
  try {
    const view = id && DETAIL[name] ? await DETAIL[name](decodeURIComponent(id)) : await PAGES[name]();
    if (id_ === renderId) main.replaceChildren(view);
  } catch (error) {
    if (id_ === renderId) main.replaceChildren(h("div", { class: "card" }, tag("error", "bad"), " ", error.message));
  }
}

window.addEventListener("hashchange", () => {
  route();
  main.focus();
});

setInterval(() => {
  if (document.hidden) return;
  refreshTopbar();
  const [page = "overview", id] = location.hash.replace(/^#\/?/, "").split("/");
  if (LIVE.has(page) && !id) route();
}, 4000);

refreshTopbar();
route();
