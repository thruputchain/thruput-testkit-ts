import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createPubkeyAccount,
  Ed25519Signer,
  gasAmount,
  localnet,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import { withScenario } from "@thruputchain/testkit";

/** A real transfer through the installed packages; shared by test and script. */
export async function transfer() {
  assert.ok(
    process.env.THRUPUT_RPC_URL,
    "Provide an existing local node RPC URL",
  );
  const accounts = Object.fromEntries(
    ["alice", "bob"].map((name) => [
      name,
      createPubkeyAccount({ signer: Ed25519Signer.fromSeed(randomBytes(32)) }),
    ]),
  );
  const signed = [];
  return withScenario(
    {
      network: {
        cluster: localnet({ rpcUrl: process.env.THRUPUT_RPC_URL }),
        signal: AbortSignal.timeout(60_000),
      },
      accounts,
      onSigned: (actor, evidence) => {
        signed.push({ actor, evidence });
      },
    },
    async (scenario) => {
      const alice = scenario.actor("alice");
      const bob = scenario.actor("bob");
      await alice.wallet.requestAirdrop({ timeoutMs: 30_000 });
      const funded = await bob.wallet.requestAirdrop({ timeoutMs: 30_000 });

      // GH-611 will add consistent-read helpers. Until then, use the generated
      // view and explicitly wait for the snapshot required by this workflow.
      async function balanceAt(minHeight) {
        const deadline = Date.now() + 10_000;
        while (true) {
          const result = await ERC20.v0_1.getBalanceOf.view({
            client: scenario.client,
            address: NATIVE_TOKEN_ADDRESS,
            args: { addr: bob.account.address },
            signal: scenario.signal,
          });
          if (result.stateBlockHeight >= minHeight) return result.value;
          assert.ok(
            Date.now() < deadline,
            "Balance snapshot did not reach the confirmed height",
          );
          await sleep(50, undefined, { signal: scenario.signal });
        }
      }
      const before = await balanceAt(funded.blockHeight);
      const result = await alice.wallet.executeCallsAndWait(
        {
          calls: [
            ERC20.v0_1.transfer.call({
              address: NATIVE_TOKEN_ADDRESS,
              gasLimit: gasAmount(500_000n),
              args: { receiver: bob.account.address, amount: 1_000n },
            }),
          ],
          gasLimit: gasAmount(1_000_000n),
        },
        { timeoutMs: 30_000, signal: scenario.signal },
      );
      assert.equal(result.values.length, 1);
      assert.equal(
        await balanceAt(result.receipt.blockHeight),
        before + 1_000n,
      );
      assert.equal(signed.length, 1);
      assert.equal(signed[0].actor, "alice");
      assert.deepEqual(
        signed[0].evidence.transactionHash,
        result.transactionHash,
      );
      return result.receipt.blockHeight;
    },
  );
}
