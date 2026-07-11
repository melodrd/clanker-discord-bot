import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const compiledEntry = fileURLToPath(
  new URL("../dist/discord/register-commands.js", import.meta.url),
);

let commandArgs;

if (existsSync(compiledEntry)) {
  commandArgs = [compiledEntry];
} else {
  const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
  const sourceEntry = fileURLToPath(
    new URL("../src/discord/register-commands.ts", import.meta.url),
  );
  commandArgs = [tsxCli, sourceEntry];
}

const result = spawnSync(process.execPath, commandArgs, { stdio: "inherit" });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
