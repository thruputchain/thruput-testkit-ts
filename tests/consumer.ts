import {
  createPubkeyAccount,
  Ed25519Signer,
  gasAmount,
  localnet,
  mainnet,
  type ContractCall,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import {
  withScenario,
  createScenario,
  withLocalScenario,
  loadArtifacts,
  type LocalScenarioOptions,
  inspectRun,
  reconcileRun,
} from "@thruputchain/testkit";
import { Counter } from "./fixtures/counter.js";

// Compiled against an installed tarball, never run. Negative cases protect the
// generated-binding and capability types across the package boundary.
async function checkTypes() {
  const alice = createPubkeyAccount({
    signer: Ed25519Signer.fromSeed(new Uint8Array(32).fill(1)),
  });
  const options = { network: { cluster: localnet() }, accounts: { alice } };
  const value: bigint = await withScenario(options, async (scenario) => {
    const actor = scenario.actor("alice");
    const stepValue: number = await scenario.run.step(
      "typed-step",
      async () => 42,
    );
    const report = scenario.run.report();
    const runId: string = report.id;
    const previous = await inspectRun("prior-run");
    const reconciled = await reconcileRun("prior-run", scenario.client);
    const network: string = reconciled.report.networkHash;
    // @ts-expect-error Actor names come from the configured account mapping.
    scenario.actor("bob");
    await actor.wallet.requestAirdrop();
    const call = ERC20.v0_1.getBalanceOf.call({
      address: NATIVE_TOKEN_ADDRESS,
      gasLimit: gasAmount(500_000n),
      args: { addr: actor.account.address },
    });
    const typedCall: ContractCall<bigint> = call;
    const result = await actor.wallet.executeCallsAndWait({
      calls: [typedCall] as const,
      gasLimit: gasAmount(1_000_000n),
    });
    const returned: bigint = result.values[0];
    const submitted = await actor.submit([
      typedCall,
      ERC20.v0_1.transfer.call({
        address: NATIVE_TOKEN_ADDRESS,
        gasLimit: gasAmount(500_000n),
        args: { receiver: actor.account.address, amount: 1n },
      }),
    ]);
    const typedResults = await submitted.wait();
    const first: bigint = typedResults.values[0];
    const second: void = typedResults.values[1];
    // @ts-expect-error A void return cannot become a bigint.
    const invalidResult: bigint = typedResults.values[1];
    const consistent = await scenario.view(
      ERC20.v0_1.getBalanceOf.viewRequest({
        address: NATIVE_TOKEN_ADDRESS,
        args: { addr: actor.account.address },
      }),
    );
    const balance: bigint = consistent.value;
    // @ts-expect-error A typed contract result cannot become a string.
    const wrong: string = result.values[0];
    const view = await ERC20.v0_1.getBalanceOf.view({
      client: scenario.client,
      address: NATIVE_TOKEN_ADDRESS,
      args: { addr: actor.account.address },
      minStateBlockHeight: result.receipt.blockHeight,
    });
    ERC20.v0_1.getBalanceOf.call({
      address: NATIVE_TOKEN_ADDRESS,
      gasLimit: gasAmount(1n),
      // @ts-expect-error Generated argument names remain checked.
      args: { receiver: actor.account.address },
    });
    ERC20.v0_1.transfer.call({
      address: NATIVE_TOKEN_ADDRESS,
      gasLimit: gasAmount(1n),
      // @ts-expect-error Contract integers use bigint, not number.
      args: { receiver: actor.account.address, amount: 1 },
    });
    return view.value + returned;
  });
  const noFaucet = await createScenario({
    network: { cluster: mainnet({ networkHash: localnet().networkHash! }) },
    accounts: { alice },
  });
  // @ts-expect-error An actor cannot acquire an undeclared faucet capability.
  await noFaucet.actor("alice").wallet.requestAirdrop();
  await noFaucet.close();
  return value;
}

void checkTypes;

const localOptions = {
  seed: "consumer",
  accounts: { alice: { initialStorageTokens: 100n } },
} satisfies LocalScenarioOptions;
void withLocalScenario(localOptions, async (scenario) => {
  scenario.actor("alice").wallet;
  // @ts-expect-error actor names are inferred from fixture declarations
  scenario.actor("unknown");
  const manual: false = scenario.local.capabilities.manualBlocks;
  const artifacts = await loadArtifacts({ counter: "counter.rv32a" });
  // @ts-expect-error Artifact names come from the supplied mapping.
  artifacts.unknown;
  const actor = scenario.actor("alice");
  const deployment = artifacts.counter.prepare(actor.account.address);
  const deployed = await actor.deploy(deployment, {
    amount: 50_000_000n,
    initializer: Counter.v0_1.initialize.call({
      address: deployment.address,
      gasLimit: gasAmount(500_000n),
      args: { initialValue: 42n },
    }),
  });
  // @ts-expect-error Storage funding must be explicit, including zero.
  await actor.deploy(deployment, {});
  const result = await actor.call([
    Counter.v0_1.get.call({
      address: deployed.address,
      gasLimit: gasAmount(500_000n),
    }),
  ]);
  const count: bigint = result.values[0];
  return manual;
});
