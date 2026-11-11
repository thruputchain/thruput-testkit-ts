import assert from "node:assert/strict";
import { test } from "node:test";
import { gasAmount } from "@thruputchain/client";
import { loadArtifacts, withLocalScenario } from "@thruputchain/testkit";
import { Counter } from "./generated/counter.js";

test(
  "agents coordinate live deployment and interaction through copied messages",
  { timeout: 120_000 },
  async () => {
    const artifacts = await loadArtifacts({
      counter: new URL("./fixtures/counter.rv32a", import.meta.url),
    });
    await withLocalScenario(
      {
        seed: "agents",
        cli: process.env.THRUPUT_CLI,
        accounts: {
          alice: { initialStorageTokens: 1_000_000_000n },
          bob: { initialStorageTokens: 1_000_000_000n },
        },
      },
      async (scenario) => {
        const gasLimit = gasAmount(500_000n);
        await scenario.agents(
          [
            {
              name: "alice",
              async run(ctx) {
                const deployment = artifacts.counter.prepare(
                  ctx.actor.account.address,
                );
                const result = await ctx.actor.deploy(deployment, {
                  amount: 50_000_000n,
                  initializer: Counter.v0_1.initialize.call({
                    address: deployment.address,
                    gasLimit,
                    args: { initialValue: 10n },
                  }),
                });
                ctx.send("bob", { address: result.address });
                await ctx.barrier("written");
                assert.equal(
                  (
                    await ctx.view(
                      Counter.v0_1.get.viewRequest({ address: result.address }),
                    )
                  ).value,
                  11n,
                );
                await ctx.barrier("done");
              },
            },
            {
              name: "bob",
              async run(ctx) {
                const {
                  value: { address },
                } = await ctx.receive();
                assert.equal(
                  (await ctx.view(Counter.v0_1.get.viewRequest({ address })))
                    .value,
                  10n,
                );
                await ctx.actor.call([
                  Counter.v0_1.increment.call({
                    address,
                    gasLimit,
                    args: { amount: 1n },
                  }),
                ]);
                await ctx.barrier("written");
                await ctx.barrier("done");
              },
            },
          ],
          { seed: "agent-streams", timeoutMs: 60_000 },
        );
        assert.equal(
          scenario.run
            .report()
            .attempts.filter((attempt) => attempt.state === "committed").length,
          2,
        );
      },
    );
  },
);
