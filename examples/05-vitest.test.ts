// Run: npm run example:vitest
// Requires Linux and the CLI described in README.md.
// One managed node serves every test in this file, so tests share chain state.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gasAmount, type ContractAddress } from "@thruputchain/client";
import {
  createLocalScenario,
  loadArtifacts,
  type LocalScenario,
} from "@thruputchain/testkit";
import { Counter } from "./fixtures/counter.js";

const gasLimit = gasAmount(500_000n);

describe("Counter", () => {
  let scenario: LocalScenario<"alice" | "bob">;
  let address: ContractAddress;

  // Node startup takes a few seconds: allow more than Vitest's 5 s default.
  beforeAll(async () => {
    scenario = await createLocalScenario({
      seed: "example-vitest",
      accounts: {
        alice: { initialStorageTokens: 1_000_000_000n },
        bob: { initialStorageTokens: 1_000_000_000n },
      },
    });
    const { counter } = await loadArtifacts({
      counter: new URL("./fixtures/counter.rv32a", import.meta.url),
    });
    const alice = scenario.actor("alice");
    const deployment = counter.prepare(alice.account.address);
    address = deployment.address;
    await alice.deploy(deployment, {
      amount: 50_000_000n,
      initializer: Counter.v0_1.initialize.call({
        address,
        gasLimit,
        args: { initialValue: 10n },
      }),
    });
  }, 120_000);

  // Close in afterAll, so the node stops even when a test fails.
  afterAll(() => scenario?.close());

  it("lets another user increment the counter", async () => {
    await scenario.actor("bob").call([
      Counter.v0_1.increment.call({
        address,
        gasLimit,
        args: { amount: 5n },
      }),
    ]);
    // view waits for state that includes Bob's confirmed transaction.
    const { value } = await scenario.view(
      Counter.v0_1.get.viewRequest({ address }),
    );
    expect(value).toBe(15n);
  });

  it("records an expected contract failure in the run report", async () => {
    await expect(
      scenario.run.step("expected-failure", () =>
        scenario
          .actor("bob")
          .call([Counter.v0_1.error.call({ address, gasLimit })]),
      ),
    ).rejects.toThrow("execution failed");
    const report = scenario.run.report();
    const attempt = report.attempts.find(
      (entry) => entry.step === "expected-failure",
    );
    // The transaction committed, and its execution failed.
    expect(attempt).toMatchObject({ state: "committed", outcome: "failed" });
    expect(report.steps.at(-1)).toMatchObject({
      name: "expected-failure",
      state: "failed",
    });
  });
});
