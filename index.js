#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("miniClaw")
  .description("My personal AI agent")
  .version("1.0.0");

program
  .command("chat")
  .description("Start chatting with the agent")
  .option("-m, --model <name>", "which model to use", "qwen2.5:7b")
  .action(() => {
    console.log(`Starting chat...`);
  });



await program.parseAsync(program.argv);