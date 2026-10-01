import { APIConnectionError } from "openai";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { defaultSystemPrompt, Session } from "../agent/session.ts";
import type { Config } from "../config.ts";
import type { LLMProvider } from "../llm/provider.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const HELP = `Commands:
  /new    start a new conversation
  /help   show this help
  /exit   quit (or press Ctrl+D)
While the agent is replying, press Ctrl+C to stop it.`;

export async function startCliChat(config: Config, llm: LLMProvider): Promise<void> {
  const session = new Session(defaultSystemPrompt(config.agent.name), config.agent.historyLimit);
  const rl = createInterface({ input, output, prompt: cyan("you › ") });

  // Ctrl+C stops the current reply if one is streaming, otherwise quits.
  let current: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (current) current.abort();
    else rl.close();
  });

  console.log(cyan(`🦀 ${config.agent.name}`) + dim(` · model ${llm.model} · ${config.llm.baseURL}`));
  console.log(dim("Type /help for commands.\n"));

  // Iterating (instead of rl.question) buffers lines, so pasted or piped input isn't lost.
  // The loop ends when readline closes (Ctrl+D, or Ctrl+C at the prompt).
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      continue;
    }

    if (line.startsWith("/")) {
      const command = line.slice(1).toLowerCase();
      if (command === "exit" || command === "quit") break;
      if (command === "new") {
        session.reset();
        console.log(dim("Started a new conversation.\n"));
      } else if (command === "help") {
        console.log(HELP + "\n");
      } else {
        console.log(red(`Unknown command: ${line}`) + dim(" (try /help)\n"));
      }
      rl.prompt();
      continue;
    }

    session.add({ role: "user", content: line });
    current = new AbortController();
    let reply = "";
    output.write(cyan(`${config.agent.name.toLowerCase()} › `));
    try {
      for await (const event of llm.stream(session.messages(), { signal: current.signal })) {
        if (event.type !== "text") continue;
        reply += event.delta;
        output.write(event.delta);
      }
      output.write("\n\n");
    } catch (error) {
      if (current.signal.aborted) {
        output.write(dim(" [stopped]") + "\n\n");
      } else {
        output.write("\n");
        console.error(red(`Error: ${describeError(error)}`));
        console.error(dim("Run `miniclaw doctor` to check your setup.\n"));
      }
    } finally {
      current = null;
    }

    if (reply) session.add({ role: "assistant", content: reply });
    else session.popUser();
    rl.prompt();
  }

  rl.close();
  console.log(dim("Bye! 👋"));
}

function describeError(error: unknown): string {
  if (error instanceof APIConnectionError) {
    return "cannot reach the LLM server. Is Ollama running? (`ollama serve`)";
  }
  return error instanceof Error ? error.message : String(error);
}
