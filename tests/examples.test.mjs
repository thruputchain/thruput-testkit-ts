import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify, stripVTControlCharacters } from "node:util";
import {
  createPubkeyAccount,
  Ed25519Signer,
  localnet,
  toBase58,
} from "@thruputchain/client";
import {
  inspectRun,
  withLocalScenario,
  withScenario,
} from "@thruputchain/testkit";

const exec = promisify(execFile);
function example(filename, env = {}) {
  return exec(
    process.execPath,
    ["--import", "tsx", `examples/${filename}.ts`],
    {
      env: { ...process.env, ...env },
      timeout: 150_000,
      maxBuffer: 1024 * 1024,
    },
  );
}

test(
  "standalone local examples run against the installed package",
  { timeout: 450_000 },
  async () => {
    for (const name of ["01-local-transfer", "02-deploy-counter"]) {
      const { stdout } = await example(name);
      assert.ok(stdout.trim(), `${name} reports its result`);
    }
    // The Vitest example runs under Vitest, against the same installed package.
    const vitest = await exec(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "examples/vitest.config.ts",
      ],
      { timeout: 150_000, maxBuffer: 1024 * 1024 },
    );
    // CI forces color output, so remove terminal codes before matching.
    assert.match(stripVTControlCharacters(vitest.stdout), /Tests\s+2 passed/);
  },
);

test(
  "deployment and reconciliation examples retain original evidence across processes",
  { timeout: 150_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "testkit-examples-"));
    try {
      await withLocalScenario(
        { seed: "example-qualification", accounts: {} },
        async (node) => {
          const seed = randomBytes(32);
          const signerFile = join(directory, "signer.bin");
          await writeFile(signerFile, seed, { mode: 0o600 });
          const account = createPubkeyAccount({
            signer: Ed25519Signer.fromSeed(seed),
          });
          // Funding belongs to this test setup, not the deployment example.
          await withScenario(
            {
              network: { cluster: localnet({ rpcUrl: node.local.rpcUrl }) },
              accounts: { deployer: account },
            },
            async (scenario) => {
              await scenario.actor("deployer").wallet.requestAirdrop();
            },
          );
          const env = {
            THRUPUT_RPC_URL: node.local.rpcUrl,
            THRUPUT_NETWORK_HASH: toBase58(node.client.network.networkHash),
            THRUPUT_SIGNER_FILE: signerFile,
            RUN_DIRECTORY: join(directory, "success"),
          };
          await example("03-deployment-run", env);
          const report = await inspectRun(env.RUN_DIRECTORY);
          assert.equal(report.attempts[0].state, "committed");
          assert.equal(report.steps[0].state, "completed");
          const before = await readFile(
            join(env.RUN_DIRECTORY, "report.json"),
            "utf8",
          );
          await example("04-reconcile-run", {
            ...env,
            THRUPUT_SIGNER_FILE: "",
          });
          assert.equal(
            await readFile(join(env.RUN_DIRECTORY, "report.json"), "utf8"),
            before,
          );
          await assert.rejects(example("03-deployment-run", env), /EEXIST/);

          // Forward the write, then lose its response. The example must not
          // resend: it observes the receipt instead. This address is already
          // deployed, so the receipt shows a failed execution.
          let sends = 0;
          const proxy = createServer(async (request, response) => {
            try {
              const chunks = [];
              for await (const chunk of request) chunks.push(chunk);
              const body = Buffer.concat(chunks).toString();
              const upstream = await fetch(node.local.rpcUrl, {
                method: "POST",
                body,
                headers: { "content-type": "application/json" },
              });
              const result = await upstream.text();
              if (JSON.parse(body).method === "sendTransaction") {
                sends++;
                response.destroy();
              } else {
                response.writeHead(upstream.status, {
                  "content-type": "application/json",
                });
                response.end(result);
              }
            } catch (error) {
              response.destroy(error);
            }
          });
          await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
          try {
            const runDirectory = join(directory, "lost-response");
            await assert.rejects(
              example("03-deployment-run", {
                ...env,
                RUN_DIRECTORY: runDirectory,
                THRUPUT_RPC_URL: `http://127.0.0.1:${proxy.address().port}`,
              }),
            );
            assert.equal(sends, 1);
            const observed = await inspectRun(runDirectory);
            assert.equal(observed.attempts[0].state, "committed");
            assert.equal(observed.attempts[0].outcome, "failed");
            const { stdout } = await example("04-reconcile-run", {
              ...env,
              RUN_DIRECTORY: runDirectory,
              THRUPUT_SIGNER_FILE: "",
            });
            assert.match(stdout, /committed/);
            assert.match(stdout, /receipt: \{/);
            assert.deepEqual(await inspectRun(runDirectory), observed);
            assert.equal(sends, 1);
          } finally {
            proxy.closeAllConnections();
            await new Promise((resolve, reject) =>
              proxy.close((error) => (error ? reject(error) : resolve())),
            );
          }
          await node.client.getChainTip(); // Attached scripts leave the node running.
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
