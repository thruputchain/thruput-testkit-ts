// Run: npm run example:counter
// Requires Linux and the pinned CLI/runtime described in README.md.
import assert from "node:assert/strict";
import { gasAmount, toBase58 } from "@thruputchain/client";
import { loadArtifacts, withLocalScenario } from "@thruputchain/testkit";
import { Counter, counter } from "./fixtures/counter.js";

const artifacts = await loadArtifacts({
  counter: new URL("./fixtures/counter.rv32a", import.meta.url),
});

await withLocalScenario(
  {
    seed: "example-counter",
    accounts: { alice: { initialStorageTokens: 1_000_000_000n } },
  },
  async (scenario) => {
    const alice = scenario.actor("alice");
    const deployment = artifacts.counter.prepare(alice.account.address);
    const address = deployment.address;
    const gasLimit = gasAmount(500_000n);

    // Prepare the address first; deployment and initialization are atomic.
    await alice.deploy(deployment, {
      amount: 50_000_000n, // Explicit contract storage funding.
      initializer: Counter.v0_1.initialize.call({
        address,
        gasLimit,
        args: { initialValue: 10n },
      }),
    });

    const result = await alice.call([
      Counter.v0_1.increment.call({ address, gasLimit, args: { amount: 5n } }),
      Counter.v0_1.ping.call({ address, gasLimit, args: { tag: 123n } }),
      Counter.v0_1.get.call({ address, gasLimit }),
    ]);
    assert.equal(result.values[2], 15n);

    const event = counter.v0_1.implementation.PingEvent.singleFromReceipt(
      result.receipt,
      { address },
    );
    assert.equal(event.topics.tag, 123n);

    const view = await scenario.view(Counter.v0_1.get.viewRequest({ address }));
    assert.equal(view.value, 15n);
    assert.ok(view.stateBlockHeight >= result.receipt.blockHeight);
    console.log("Counter", toBase58(address), "has value", view.value);
  },
);
