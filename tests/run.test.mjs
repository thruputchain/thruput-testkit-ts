import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  HttpTransport,
  localnet,
  gasAmount,
  TransactionObservationError,
  toBase58,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import {
  withLocalScenario,
  createScenario,
  inspectRun,
} from "@thruputchain/testkit";

test(
  "a new process reconciles durable evidence after a lost live submit response",
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "testkit-report-"));
    try {
      await withLocalScenario(
        {
          seed: "run-report",
          cli: process.env.THRUPUT_CLI,
          accounts: {
            alice: { initialStorageTokens: 1_000_000_000n },
            bob: { initialStorageTokens: 1_000_000_000n },
          },
        },
        async (node) => {
          const http = new HttpTransport(node.local.rpcUrl);
          let sends = 0;
          const runDirectory = join(root, "run");
          const attached = await createScenario({
            network: {
              cluster: localnet({ rpcUrl: node.local.rpcUrl }),
              transport: {
                async request(method, params, control) {
                  const result = await http.request(method, params, control);
                  if (method === "sendTransaction") {
                    sends++;
                    throw new Error("response lost after dispatch");
                  }
                  return result;
                },
              },
            },
            accounts: { alice: node.actor("alice").account },
            runDirectory,
          });
          let failure;
          try {
            await attached.run.step("transfer", () =>
              attached.actor("alice").call([
                ERC20.v0_1.transfer.call({
                  address: NATIVE_TOKEN_ADDRESS,
                  gasLimit: gasAmount(500_000n),
                  args: {
                    receiver: node.actor("bob").account.address,
                    amount: 1000n,
                  },
                }),
              ]),
            );
          } catch (error) {
            assert.ok(error instanceof TransactionObservationError);
            failure = error;
          } finally {
            await attached.close();
          }
          await node.client.waitForTransactionReceipt(
            failure.submission.transactionHash,
            { timeoutMs: 30_000 },
          );
          assert.equal(
            (await inspectRun(runDirectory)).attempts[0].state,
            "signed",
          );
          const { stdout } = await promisify(execFile)(
            process.execPath,
            ["reconcile-script.mjs", runDirectory, node.local.rpcUrl],
            { timeout: 30_000 },
          );
          assert.deepEqual(JSON.parse(stdout), [
            { hash: toBase58(failure.transactionHash), committed: true },
          ]);
          assert.equal(sends, 1);
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
