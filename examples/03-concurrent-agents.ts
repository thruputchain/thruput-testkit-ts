// Run: npm run example:agents
// Requires Linux and the pinned CLI/runtime described in README.md.
import assert from "node:assert/strict";
import { gasAmount, toBase58, addressFromBase58 } from "@thruputchain/client";
import { loadArtifacts, withLocalScenario } from "@thruputchain/testkit";
import { Counter } from "./fixtures/counter.js";

const artifacts = await loadArtifacts({
  counter: new URL("./fixtures/counter.rv32a", import.meta.url),
});
type Message = { address: string; amount: bigint };

await withLocalScenario(
  {
    seed: "example-agents",
    accounts: {
      alice: { initialStorageTokens: 1_000_000_000n },
      bob: { initialStorageTokens: 1_000_000_000n },
    },
  },
  async (scenario) => {
    const gasLimit = gasAmount(500_000n);
    await scenario.agents<Message>(
      [
        {
          name: "alice",
          async run(ctx) {
            const deployment = artifacts.counter.prepare(
              ctx.actor.account.address,
            );
            await ctx.actor.deploy(deployment, {
              amount: 50_000_000n,
              initializer: Counter.v0_1.initialize.call({
                address: deployment.address,
                gasLimit,
                args: { initialValue: 0n },
              }),
            });
            const amount = BigInt(ctx.random.integer(10) + 1);
            ctx.send("bob", { address: toBase58(deployment.address), amount });

            // Bob reaches this barrier only after his write is confirmed.
            await ctx.barrier("incremented");
            const view = await ctx.view(
              Counter.v0_1.get.viewRequest({ address: deployment.address }),
            );
            assert.equal(view.value, amount);
            console.log("Counter after Bob's increment:", view.value);
          },
        },
        {
          name: "bob",
          async run(ctx) {
            const { value } = await ctx.receive(); // Receives a copy.
            await ctx.actor.call([
              Counter.v0_1.increment.call({
                address: addressFromBase58(value.address),
                gasLimit,
                args: { amount: value.amount },
              }),
            ]);
            await ctx.barrier("incremented");
          },
        },
      ],
      // Failure or deadline cancels peer waits and SDK requests.
      {
        seed: "repeatable-inputs",
        timeoutMs: 60_000,
        teardownTimeoutMs: 1_000,
      },
    );
    // Seeded inputs repeat; async scheduling and block placement need not.
  },
);
