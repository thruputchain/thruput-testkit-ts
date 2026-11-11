import assert from "node:assert/strict";
import {
  gasAmount,
  TransactionExecutionError,
  TransactionObservationError,
} from "@thruputchain/client";
import { loadArtifacts, withLocalScenario } from "@thruputchain/testkit";
import { Counter, counter } from "./generated/counter.js";

/** Shared real-node scenario for node:test and a standalone consumer script. */
export async function deploymentWorkflow() {
  const artifacts = await loadArtifacts({
    counter: new URL("./fixtures/counter.rv32a", import.meta.url),
  });
  const signed = [];
  return withLocalScenario(
    {
      seed: "typed-operations-v1",
      cli: process.env.THRUPUT_CLI,
      accounts: {
        alice: { initialStorageTokens: 1_000_000_000n },
        bob: { initialStorageTokens: 1_000_000_000n },
      },
      onSigned: (actor, evidence) => signed.push({ actor, evidence }),
    },
    async (scenario) => {
      const alice = scenario.actor("alice");
      const bob = scenario.actor("bob");
      const deployment = artifacts.counter.prepare(alice.account.address);
      const address = deployment.address;
      const gasLimit = gasAmount(500_000n);
      const deployed = await alice.deploy(deployment, {
        amount: 50_000_000n,
        initializer: Counter.v0_1.initialize.call({
          address,
          gasLimit,
          args: { initialValue: 42n },
        }),
      });
      assert.deepEqual(deployed.address, address);
      assert.equal(scenario.confirmedHeight, deployed.receipt.blockHeight);
      const before = await scenario.view(
        Counter.v0_1.get.viewRequest({ address }),
      );
      assert.equal(before.value, 42n);
      assert.ok(before.stateBlockHeight >= deployed.receipt.blockHeight);
      const result = await bob.call([
        Counter.v0_1.increment.call({
          address,
          gasLimit,
          args: { amount: 5n },
        }),
        Counter.v0_1.ping.call({ address, gasLimit, args: { tag: 123n } }),
        Counter.v0_1.get.call({ address, gasLimit }),
      ]);
      assert.deepEqual(result.values, [undefined, undefined, 47n]);
      const ping = counter.v0_1.implementation.PingEvent.singleFromReceipt(
        result.receipt,
        { address },
      );
      assert.equal(ping.topics.tag, 123n);
      const after = await scenario.view(
        Counter.v0_1.get.viewRequest({ address }),
      );
      assert.equal(after.value, 47n);
      assert.ok(after.stateBlockHeight >= result.receipt.blockHeight);

      const pending = await bob.submit([
        Counter.v0_1.get.call({ address, gasLimit }),
      ]);
      const count = signed.length;
      await assert.rejects(
        pending.wait({ signal: AbortSignal.abort(new Error("stop waiting")) }),
        TransactionObservationError,
      );
      assert.equal((await pending.wait()).values[0], 47n);
      assert.equal(signed.length, count);
      await assert.rejects(
        bob.call([Counter.v0_1.error.call({ address, gasLimit })]),
        TransactionExecutionError,
      );
      assert.equal(
        (await scenario.view(Counter.v0_1.get.viewRequest({ address }))).value,
        47n,
      );
      assert.equal(signed[0].actor, "alice");
      assert.equal(signed[1].actor, "bob");
      return scenario.confirmedHeight;
    },
  );
}
