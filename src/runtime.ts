import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { Agent } from "./agent/agent.ts";
import { buildSystemPrompt } from "./agent/prompt.ts";
import { Session } from "./agent/session.ts";
import type { Config } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { SessionStore } from "./db/sessions.ts";
import type { LLMProvider } from "./llm/provider.ts";
import { FactStore } from "./memory/facts.ts";
import { loadIdentity } from "./memory/identity.ts";
import { MemoryInbox } from "./memory/inbox.ts";
import { DailyNotes } from "./memory/notes.ts";
import type { ApprovalPolicy, Approver } from "./security/approvals.ts";
import { AuditLog } from "./security/audit.ts";
import { Guard } from "./security/guard.ts";
import { ReminderStore } from "./scheduler/reminders.ts";
import { prepareWorkspace } from "./security/sandbox.ts";
import { SkillGrants } from "./skills/grants.ts";
import { loadSkills, type Skill, type SkillProblem } from "./skills/loader.ts";
import { listDirTool, readFileTool, writeFileTool } from "./tools/files.ts";
import { createRecallNotesTool, createRememberTool } from "./tools/memory.ts";
import { createReminderTools } from "./tools/reminders.ts";
import { runShellTool } from "./tools/shell.ts";
import { createSkillTool } from "./tools/skills.ts";
import { ToolRegistry } from "./tools/tool.ts";
import { webFetchTool } from "./tools/web.ts";
import { Checkpoints } from "./workspace/checkpoints.ts";

/**
 * Everything one MiniClaw process shares, whatever the channel: storage, memory,
 * skills and tools. Channels (CLI, Telegram, WhatsApp) only add a UI on top.
 */
export interface Runtime {
  config: Config;
  llm: LLMProvider;
  db: Database;
  workspace: string;
  checkpoints: Checkpoints;
  facts: FactStore;
  inbox: MemoryInbox;
  notes: DailyNotes;
  skills: Skill[];
  skillProblems: SkillProblem[];
  grants: SkillGrants;
  tools: ToolRegistry;
  sessions: SessionStore;
  audit: AuditLog;
  reminders: ReminderStore;
  guard: Guard;
  openSession(id: string): Session;
  /** Approval state is per conversation, so each chat gets its own policy and approver. */
  createAgent(options: { policy: ApprovalPolicy; approver: Approver }): Agent;
}

export async function createRuntime(config: Config, llm: LLMProvider): Promise<Runtime> {
  const db = openDatabase(join(config.paths.data, "miniclaw.db"));
  const workspace = prepareWorkspace(config.paths.workspace);
  const checkpoints = new Checkpoints(join(config.paths.data, "checkpoints.git"), workspace);
  await checkpoints.init();

  const memoryDir = join(config.paths.data, "memory");
  const facts = new FactStore(join(memoryDir, "MEMORY.md"));
  facts.removeExpired();
  const inbox = new MemoryInbox(db, facts);
  const identityPath = join(memoryDir, "IDENTITY.md");
  const notes = new DailyNotes(join(memoryDir, "notes"));
  const { skills, problems: skillProblems } = loadSkills(config.paths.skills);
  const grants = new SkillGrants(db);
  const reminders = new ReminderStore(db);
  const guard = new Guard(db, join(config.paths.data, "PAUSED"), config.agent.budgets);

  const tools = new ToolRegistry([
    readFileTool,
    listDirTool,
    writeFileTool,
    runShellTool,
    webFetchTool,
    createRememberTool(inbox),
    createRecallNotesTool(notes),
    ...Object.values(createReminderTools(reminders)),
  ]);
  // Each skill becomes a tool named after it. A skill whose name clashes with a tool is skipped.
  for (const skill of [...skills]) {
    try {
      tools.register(createSkillTool(skill, grants));
    } catch {
      skills.splice(skills.indexOf(skill), 1);
      skillProblems.push({ dir: skill.dir, error: `name "${skill.name}" clashes with a built-in tool` });
    }
  }

  const sessions = new SessionStore(db);
  const audit = new AuditLog(db);
  const systemPrompt = () =>
    buildSystemPrompt({
      identity: loadIdentity(identityPath, config.agent.name),
      facts: facts.all(),
      tools: tools.list(),
      skills,
    });

  return {
    config,
    llm,
    db,
    workspace,
    checkpoints,
    facts,
    inbox,
    notes,
    skills,
    skillProblems,
    grants,
    tools,
    sessions,
    audit,
    reminders,
    guard,
    openSession: (id) => new Session({ id, store: sessions, systemPrompt }),
    createAgent: ({ policy, approver }) =>
      new Agent({
        llm,
        tools,
        policy,
        approver,
        audit,
        checkpoints,
        notes,
        guard,
        workspace,
        maxSteps: config.agent.maxSteps,
        contextTokens: config.agent.contextTokens,
        replyTokens: config.agent.replyTokens,
      }),
  };
}
