// Run: npm run example:transfer
// Requires Linux and the pinned CLI/runtime described in README.md.
import assert from "node:assert/strict";
import { gasAmount } from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import { withLocalScenario } from "@thruputchain/testkit";

await withLocalScenario(
  {
    seed: "example-transfer",
    accounts: {
      alice: { initialStorageTokens: 1_000_000_000n },
      bob: { initialStorageTokens: 1_000_000_000n },
    },
  },
  async (scenario) => {
    const alice = scenario.actor("alice");
    const bob = scenario.actor("bob");
    const balance = ERC20.v0_1.getBalanceOf.viewRequest({
      address: NATIVE_TOKEN_ADDRESS,
      args: { addr: bob.account.address },
    });
    const before = await scenario.view(balance);
    const amount = 1_000n; // Raw native-token units.

    const transfer = await alice.call([
      ERC20.v0_1.transfer.call({
        address: NATIVE_TOKEN_ADDRESS,
        gasLimit: gasAmount(500_000n),
        args: { receiver: bob.account.address, amount },
      }),
    ]);

    // Scenario reads wait for the height confirmed by preceding helper calls.
    const after = await scenario.view(balance);
    assert.equal(after.value, before.value + amount);
    console.log(
      "Bob received",
      amount,
      "at block",
      transfer.receipt.blockHeight,
    );
  },
);
// withLocalScenario closes its node on success or failure.
