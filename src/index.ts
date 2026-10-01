#!/usr/bin/env bun
import { Command } from "commander";
import { startCliChat } from "./channels/cli.ts";
import { loadConfig } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { OpenAICompatibleProvider } from "./llm/openaiCompatible.ts";

const program = new Command();

program
  .name("miniclaw")
  .description("My personal AI agent")
  .version("1.0.0");

program
  .command("chat")
  .description("Start chatting with the agent")
  .option("-m, --model <name>", "which model to use (default: from config)")
  .action(async (options: { model?: string }) => {
    const config = loadConfig({ model: options.model });
    await startCliChat(config, new OpenAICompatibleProvider(config.llm));
  });

program
  .command("doctor")
  .description("Check that MiniClaw is set up correctly")
  .option("-m, --model <name>", "check this model instead of the configured one")
  .action(async (options: { model?: string }) => {
    const ok = await runDoctor({ model: options.model });
    process.exitCode = ok ? 0 : 1;
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
