import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
      await alice.fund({ timeoutMs: 30_000 });
      await bob.fund({ timeoutMs: 30_000 });
      // Reads wait for state that includes the scenario's confirmed funding.
      // A direct wallet write is outside the scenario, so pass its height.
      const balance = async (minStateBlockHeight = 0n) =>
        (
          await scenario.view(
            ERC20.v0_1.getBalanceOf.viewRequest({
              address: NATIVE_TOKEN_ADDRESS,
              args: { addr: bob.account.address },
            }),
            { minStateBlockHeight },
          )
        ).value;
      const before = await balance();
      // The actor's SDK wallet still saves evidence through the scenario hook.
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
      assert.equal(await balance(result.receipt.blockHeight), before + 1_000n);
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
