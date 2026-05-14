import { buildCli } from "./cli/index.js";

const program = buildCli();
program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
