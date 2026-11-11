# Thruput testkit

Build integration tests, seed local applications, and run deployment scripts with `@thruputchain/testkit`.

Testkit starts isolated local nodes or connects to existing networks. It provides named actors, typed contract operations, coordinated async agents, and durable transaction reports. It uses the public Thruput SDK for wallets, signing, generated bindings, and RPC.

Use the SDK directly for individual reads and transactions. Use testkit when your workflow needs repeatable setup, multiple actors, confirmed-state reads, or recovery after interruption.

## Getting started

Requires Node.js 22.12 or later. Development uses Node 24.

The package is not published yet. From this checkout:

```sh
npm ci
npm run build
npm run example:transfer
```

To use it in another project, run `npm pack` and install the resulting tarball alongside `@thruputchain/client@0.26.0`.

Managed local nodes require Linux, `ps` from procps, and Thruput CLI **0.44.0** on PATH:

```sh
cargo install thruput@0.44.0 --locked
```

The CLI downloads devnode **0.1.32**, so startup requires download access and the devnode's native runtime libraries. The tested Linux runtime includes glibc, libstdc++, libgcc, libatomic, jemalloc, Snappy, zlib, bzip2, LZ4, Zstandard, OpenSSL 3, and Brotli. Connecting to an existing network does not require a local CLI or devnode.

## A local scenario

This script creates two funded actors, transfers tokens, and checks the recipient's balance. The node closes when the callback finishes or throws.

```ts
import assert from "node:assert/strict";
import { gasAmount } from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import { withLocalScenario } from "@thruputchain/testkit";

await withLocalScenario(
  {
    seed: "transfer-example",
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

    await alice.call([
      ERC20.v0_1.transfer.call({
        address: NATIVE_TOKEN_ADDRESS,
        gasLimit: gasAmount(500_000n),
        args: { receiver: bob.account.address, amount: 1_000n },
      }),
    ]);

    const after = await scenario.view(balance);
    assert.equal(after.value, before.value + 1_000n);
  },
);
```

This example also needs `@thruputchain/protocol@0.20.0`, included in this checkout. Amounts are raw native-token units. Account storage consumes part of the initial allocation. Seeded accounts are repeatable test identities for disposable nodes.

Actors expose `deploy`, `call`, and `submit`, plus their ordinary SDK `wallet`. `scenario.view` waits for state that includes preceding confirmed helper operations. Generated bindings retain their argument and result types.

## Runnable examples

Build once with `npm run build`, then run any of the following from the repository root. The commands use the included `tsx` development dependency.

| Example                                               | Command                     | Demonstrates                                                  |
| ----------------------------------------------------- | --------------------------- | ------------------------------------------------------------- |
| [Local transfer](examples/01-local-transfer.ts)       | `npm run example:transfer`  | Fund actors, transfer tokens, and check balances.             |
| [Deploy counter](examples/02-deploy-counter.ts)       | `npm run example:counter`   | Deploy, initialize, call, decode events, and read state.      |
| [Concurrent agents](examples/03-concurrent-agents.ts) | `npm run example:agents`    | Coordinate users with messages, a barrier, and seeded inputs. |
| [Deployment run](examples/04-deployment-run.ts)       | `npm run example:deploy`    | Use a supplied signer and save a durable deployment report.   |
| [Reconcile run](examples/05-reconcile-run.ts)         | `npm run example:reconcile` | Inspect original transactions without submitting again.       |

The first three start and close their own nodes. The last two connect to an existing node and leave it running.

### Deployment and recovery

For example 4, supply an already-funded account and the expected network identity:

```sh
export THRUPUT_RPC_URL=http://127.0.0.1:9545
export THRUPUT_NETWORK_HASH=11111111111111111111111111111111
export THRUPUT_SIGNER_FILE=/absolute/path/to/signer.bin
export RUN_DIRECTORY=/absolute/path/to/new-run
npm run example:deploy
npm run example:reconcile
```

The hash above is the default local network identity. For another network, use its trusted expected hash. The signer file must contain a raw 32-byte Ed25519 seed; keep it private. `RUN_DIRECTORY` must be a new path inside an existing parent directory. The deployment script does not fund the account.

Example 5 needs only `THRUPUT_RPC_URL` and `RUN_DIRECTORY`. Keep the original chain available. It reads saved evidence, checks transaction status and receipts, and leaves the report unchanged.

### Important behavior

- **Funding is explicit.** Supply local allocations or fund attached accounts before their operations. Contract storage funding is separate from gas budgets.
- **Network identity is explicit.** Attached scenarios require an expected network hash and validate it before signing.
- **Node ownership is explicit.** `withLocalScenario` closes its node; `withScenario` leaves the external node running.
- **Writes are not retried.** A timeout can follow commitment. Retain the original signed evidence and use `scenario.observe` or `reconcileRun` to inspect it before deciding what to do next. Faucet requests have separate SDK evidence and are not captured by the wallet signing hook.

The counter artifact is an Apache-2.0 test fixture, not a release-qualified application artifact. Its [source and SHA-256](tests/fixtures/provenance.json) are recorded with the test fixtures. The matching TypeScript binding is generated; do not edit it by hand.

## Development

```sh
npm run format:check
npm run typecheck
npm test
npm run build
npm run test:package
```

`test:package` checks installed-package imports and example types. With the Linux runtime prerequisites installed, `npm run test:integration` also runs the examples and integration workflows against real nodes.
