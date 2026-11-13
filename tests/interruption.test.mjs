import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(
    `packed fixture cleans up on ${signal} during startup`,
    { skip: process.platform !== "linux", timeout: 20_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "testkit-interrupt-"));
      const cli = join(root, "cli");
      const pidFile = join(root, "pids.json");
      let child;
      let pids = [];
      try {
        await writeFile(
          cli,
          `#!/usr/bin/env node
const {writeFileSync} = require('node:fs');
const {spawn} = require('node:child_process');
if (process.argv.includes('--version')) { console.log('thruput 0.45.0'); process.exit(0); }
if (process.argv.includes('install')) process.exit(0);
const backend = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, backend.pid]));
setInterval(()=>{},1000);
`,
          { mode: 0o700 },
        );
        child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import {createLocalScenario} from '@thruputchain/testkit';
await createLocalScenario(${JSON.stringify({ cli, directory: root, seed: "signal", accounts: {} })}).catch(()=>{});`,
          ],
          { stdio: "ignore" },
        );
        const exited = once(child, "exit");
        const deadline = Date.now() + 5000;
        while (pids.length === 0) {
          pids = await readFile(pidFile, "utf8").then(JSON.parse, () => []);
          assert.ok(Date.now() < deadline, "fixture did not start");
          await sleep(25);
        }
        child.kill(signal);
        const [code, exitSignal] = await exited;
        assert.equal(code, null);
        assert.equal(exitSignal, signal);
        for (const pid of pids) {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(
            () => "",
          );
          assert.ok(stat === "" || stat.split(") ")[1]?.startsWith("Z "));
        }
      } finally {
        if (child?.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
