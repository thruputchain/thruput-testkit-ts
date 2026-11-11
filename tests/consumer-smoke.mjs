import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createPubkeyAccount,
  Ed25519Signer,
  localnet,
  MockTransport,
} from "@thruputchain/client";
import * as esm from "@thruputchain/testkit";

const cjs = createRequire(import.meta.url)("@thruputchain/testkit");
for (const kit of [esm, cjs]) {
  assert.equal(typeof kit.createLocalScenario, "function");
  assert.equal(typeof kit.withLocalScenario, "function");
  assert.equal(typeof kit.loadArtifacts, "function");
  assert.equal(kit.SCENARIO_GAS.walletOverhead, 500_000n);
  assert.equal(kit.LOCAL_RUNTIME.cli, "0.44.0");
  let saved;
  const result = await kit.withScenario(
    {
      network: { cluster: localnet(), transport: new MockTransport() },
      accounts: {
        alice: createPubkeyAccount({
          signer: Ed25519Signer.fromSeed(new Uint8Array(32).fill(1)),
        }),
      },
    },
    async (scenario) => {
      saved = scenario;
      assert.equal(scenario.actor("alice").name, "alice");
      assert.equal(typeof scenario.actor("alice").call, "function");
      assert.equal(typeof scenario.actor("alice").submit, "function");
      assert.equal(typeof scenario.actor("alice").deploy, "function");
      assert.equal(typeof scenario.view, "function");
      assert.equal(typeof scenario.observe, "function");
      assert.equal(scenario.confirmedHeight, 0n);
      return (await scenario.client.getChainTip()).blockHeight;
    },
  );
  assert.equal(result, 0n);
  assert.ok(saved.signal.aborted);
  await assert.rejects(saved.client.getChainTip(), /Scenario is closed/);
}
