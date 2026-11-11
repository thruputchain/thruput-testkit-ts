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
import { withScenario, createScenario } from "@thruputchain/testkit";

// Compiled against an installed tarball, never run. Negative cases protect the
// generated-binding and capability types across the package boundary.
async function checkTypes() {
  const alice = createPubkeyAccount({
    signer: Ed25519Signer.fromSeed(new Uint8Array(32).fill(1)),
  });
  const options = { network: { cluster: localnet() }, accounts: { alice } };
  const value: bigint = await withScenario(options, async (scenario) => {
    const actor = scenario.actor("alice");
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
