import { Command } from "commander";
import { client } from "./client.js";
import { startBot } from "../bot.js";
import { startWorker } from "../worker.js";
import { startHttp } from "../http.js";

type ButtonOpt = { label: string; id: string };

function parseButton(value: string, previous: ButtonOpt[] = []): ButtonOpt[] {
  // "label=Yes id=yes" or "label=Yes,id=yes"
  const parts = value.split(/[,\s]+/);
  const acc: Record<string, string> = {};
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (k && v) acc[k.trim()] = v.trim();
  }
  if (!acc.label || !acc.id) {
    throw new Error(`--button requires label and id, got: ${value}`);
  }
  return [...previous, { label: acc.label, id: acc.id }];
}

async function withErr<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

export function buildCli(): Command {
  const program = new Command("teams-cord")
    .description("Microsoft Teams harness for Claude Code")
    .version("0.1.0");

  program
    .command("start")
    .description("Run bot, worker, and HTTP API in one process")
    .action(async () => {
      await startBot();
      startWorker();
      await startHttp();
    });

  program
    .command("bot")
    .description("Run only the Bot Framework webhook listener")
    .action(async () => {
      await startBot();
    });

  program
    .command("worker")
    .description("Run only the BullMQ worker that spawns Claude")
    .action(() => {
      startWorker();
    });

  program
    .command("http")
    .description("Run only the local HTTP API (for the CLI)")
    .action(async () => {
      await startHttp();
    });

  program
    .command("send <conversation> <text>")
    .description("Post a message to a Teams conversation")
    .action(async (conversation: string, text: string) => {
      const { id } = await withErr(client.send(conversation, text));
      console.log(id);
    });

  program
    .command("embed <conversation> <text>")
    .option("--title <title>", "embed title")
    .option("--color <color>", "default | accent | good | warning | attention")
    .description("Post an adaptive-card embed")
    .action(async (conversation: string, text: string, opts: { title?: string; color?: string }) => {
      const { id } = await withErr(client.embed(conversation, text, opts));
      console.log(id);
    });

  program
    .command("file <conversation> <filePath>")
    .requiredOption("--target <path>", "Graph drive target path (e.g. /users/{id}/drive/root:/teams-cord:)")
    .option("--name <name>", "override the uploaded file name")
    .description("Upload a file to Graph and post a link to it")
    .action(async (conversation: string, filePath: string, opts: { target: string; name?: string }) => {
      const result = await withErr(client.file(conversation, filePath, opts.target, opts.name));
      console.log(result.id);
      if (result.upload.webUrl) console.log(result.upload.webUrl);
    });

  program
    .command("buttons <conversation> <text>")
    .description("Post a buttons card")
    .option(
      "--button <kv>",
      'label=<label> id=<id> (repeatable)',
      parseButton,
      [] as ButtonOpt[],
    )
    .action(async (conversation: string, text: string, opts: { button: ButtonOpt[] }) => {
      const { id } = await withErr(client.buttons(conversation, text, opts.button));
      console.log(id);
    });

  program
    .command("typing <conversation>")
    .description("Send a typing indicator")
    .action(async (conversation: string) => {
      await withErr(client.typing(conversation));
    });

  program
    .command("edit <conversation> <activityId> <text>")
    .description("Edit a previously sent message")
    .action(async (conversation: string, activityId: string, text: string) => {
      const { id } = await withErr(client.edit(conversation, activityId, text));
      console.log(id);
    });

  program
    .command("state <conversation> <activityId> <state>")
    .description("Mark a message as done | in-progress | error")
    .option("--text <text>", "message body to preserve while updating state")
    .action(
      async (
        conversation: string,
        activityId: string,
        state: string,
        opts: { text?: string },
      ) => {
        if (state !== "done" && state !== "in-progress" && state !== "error") {
          console.error(`invalid state: ${state}`);
          process.exit(2);
        }
        const { id } = await withErr(client.state(conversation, activityId, state, opts.text));
        console.log(id);
      },
    );

  program
    .command("config")
    .description("Per-conversation configuration")
    .addCommand(
      new Command("dir")
        .argument("<conversation>")
        .argument("[dir]")
        .description("Set or clear the working directory for a conversation")
        .action(async (conversation: string, dir?: string) => {
          await withErr(client.configDir(conversation, dir ?? null));
          console.log("ok");
        }),
    );

  program
    .command("health")
    .description("Check that the local HTTP API is reachable")
    .action(async () => {
      const out = await withErr(client.health());
      console.log(JSON.stringify(out));
    });

  return program;
}
