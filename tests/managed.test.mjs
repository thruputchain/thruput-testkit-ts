import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  localnet,
  networkHash,
  sha256Hash,
  gasAmount,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import { createLocalScenario, createScenario } from "@thruputchain/testkit";

test(
  "packed managed fixtures fund accounts, isolate nodes, and preserve attached ownership",
  { timeout: 120_000 },
  async () => {
    const options = {
      seed: "managed-integration-v1",
      accounts: {
        alice: { initialStorageTokens: 1_000_000_000n },
        bob: { initialStorageTokens: 2_000_000_000n },
      },
      cli: process.env.THRUPUT_CLI,
    };
    const results = await Promise.allSettled([
      createLocalScenario(options),
      createLocalScenario(options),
    ]);
    const fixtures = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);
    let initialBalance;
    try {
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
      const [first, second] = fixtures;
      assert.notEqual(first.local.directory, second.local.directory);
      assert.notEqual(first.local.rpcUrl, second.local.rpcUrl);
      assert.deepEqual(
        first.actor("alice").account.address,
        second.actor("alice").account.address,
      );
      assert.deepEqual(first.local.capabilities, {
        genesisAccounts: true,
        blockDriver: "instant",
        manualBlocks: false,
        snapshots: false,
      });
      for (const scenario of fixtures) {
        const report = JSON.parse(
          (
            await readFile(
              `${scenario.local.directory}/node.stdout.log`,
              "utf8",
            )
          ).split("\n")[0],
        );
        assert.equal(report.data.bootstrapAccounts.length, 3);
        const balance = await ERC20.v0_1.getBalanceOf.view({
          client: scenario.client,
          address: NATIVE_TOKEN_ADDRESS,
          args: { addr: scenario.actor("bob").account.address },
        });
        assert.ok(balance.value > 0n && balance.value <= 2_000_000_000n);
        if (initialBalance !== undefined)
          assert.equal(balance.value, initialBalance);
        initialBalance = balance.value;
      }
      const alice = first.actor("alice");
      await assert.rejects(
        createScenario({
          network: {
            cluster: localnet({
              rpcUrl: first.local.rpcUrl,
              networkHash: networkHash(sha256Hash(new Uint8Array(32).fill(9))),
            }),
          },
          accounts: { alice: alice.account },
        }),
        /network/i,
      );
      const attached = await createScenario({
        network: { cluster: localnet({ rpcUrl: first.local.rpcUrl }) },
        accounts: { alice: alice.account },
      });
      await attached.close();
      await first.client.getChainTip();
      const result = await alice.wallet.executeCallsAndWait(
        {
          calls: [
            ERC20.v0_1.transfer.call({
              address: NATIVE_TOKEN_ADDRESS,
              gasLimit: gasAmount(500_000n),
              args: {
                receiver: first.actor("bob").account.address,
                amount: 1_000n,
              },
            }),
          ],
          gasLimit: gasAmount(1_000_000n),
        },
        { timeoutMs: 30_000 },
      );
      assert.equal(result.values.length, 1);
      // A signed transfer confirms that the derived private seed matches genesis.
      const untouched = await ERC20.v0_1.getBalanceOf.view({
        client: second.client,
        address: NATIVE_TOKEN_ADDRESS,
        args: { addr: second.actor("bob").account.address },
      });
      assert.equal(untouched.value, initialBalance);
    } finally {
      await Promise.all(fixtures.map((fixture) => fixture.close()));
    }
    for (const fixture of fixtures) {
      await assert.rejects(access(fixture.local.directory), { code: "ENOENT" });
      await assert.rejects(
        fetch(fixture.local.rpcUrl, { signal: AbortSignal.timeout(1000) }),
      );
    }
  },
);
