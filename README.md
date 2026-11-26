# Thruput testkit

Build integration tests, seed local applications, and run deployment scripts with `@thruputchain/testkit`.

Testkit is a Node.js harness for scripting and testing Thruput applications. It starts isolated local nodes or connects to existing networks, then provides named actors with funding, typed contract operations, durable transaction reports with signed evidence, and reconciliation. It loads contract artifacts from disk.

Use `@thruputchain/client` for everything an application does with the chain. Use testkit for the parts that need Node.js: processes, the filesystem, and resumable multi-step runs.

Use the SDK directly for individual reads and transactions. Use testkit when your workflow needs repeatable setup, multiple actors, confirmed-state reads, or recovery after interruption.

## Getting started

Requires Node.js 22.12 or later. Development uses Node 24.

The package is not published yet. From this checkout:

```sh
npm ci
npm run build
npm run example:transfer
```

To use it in another project, run `npm pack` and install the resulting tarball. `@thruputchain/client` 0.29 is a peer dependency: testkit uses your project's client, so your app and testkit share one SDK copy.

Managed local nodes require Linux, `ps` from procps, and Thruput CLI **0.48.0** or newer on PATH:

```sh
cargo install thruput@0.48.0 --locked
```

Testkit is qualified with CLI 0.48.0, devnode 0.1.37, and wire format 14.7. Each CLI runs only its own compatible devnode, so testkit uses the devnode that your CLI selects. A newer CLI, or another devnode, runs with a Node.js warning (`THRUPUT_TESTKIT_UNQUALIFIED_CLI`). An older CLI, or a node with another wire-format major version, is rejected. `scenario.local.runtime` reports the versions in use.

The CLI downloads its devnode once into its normal toolchain cache, so the first startup requires download access. Each node otherwise uses its own private configuration and data directory. The devnode needs native runtime libraries. The tested Linux runtime includes glibc, libstdc++, libgcc, libatomic, jemalloc, Snappy, zlib, bzip2, LZ4, Zstandard, OpenSSL 3, and Brotli. Connecting to an existing network does not require a local CLI or devnode.

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

Actors expose `deploy`, `call`, and `submit`, plus their ordinary SDK `wallet`. On networks with a faucet, `fund` requests funds once and records the request in the run report. `scenario.view` waits for state that includes preceding confirmed helper operations, including funding. Generated bindings retain their argument and result types.

## Scripts against an existing network

Setup and seeding scripts need accounts that outlive the script. Save each key before the account is funded or used, so a failed run can be recovered:

```ts
import { join } from "node:path";
import { devnet } from "@thruputchain/client";
import {
  createKeyFile,
  createOutputDirectory,
  withScenario,
} from "@thruputchain/testkit";

const directory = await createOutputDirectory(".local/setup");
const deployer = await createKeyFile(join(directory, "key.json"));

await withScenario(
  {
    network: { cluster: devnet({ networkHash: expectedNetworkHash }) },
    accounts: { deployer: deployer.account },
    runDirectory: join(directory, "transactions"),
  },
  async (scenario) => {
    const actor = scenario.actor("deployer");
    await scenario.run.step("fund-deployer", () => actor.fund());
    // Deploy and verify here.
  },
);
```

Key files use mode 0600 and are never replaced. `loadKeyFile` restores the account and checks that the saved address matches the seed. The report holds public addresses and hashes; it never contains seeds.

## Runnable examples

Build once with `npm run build`, then run any of the following from the repository root. The commands use the included `tsx` development dependency.

| Example                                         | Command                     | Demonstrates                                                      |
| ----------------------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| [Local transfer](examples/01-local-transfer.ts) | `npm run example:transfer`  | Fund actors, transfer tokens, and check balances.                 |
| [Deploy counter](examples/02-deploy-counter.ts) | `npm run example:counter`   | Deploy, initialize, call, decode events, and read state.          |
| [Deployment run](examples/03-deployment-run.ts) | `npm run example:deploy`    | Use a supplied signer and save a durable deployment report.       |
| [Reconcile run](examples/04-reconcile-run.ts)   | `npm run example:reconcile` | Inspect original transactions without submitting again.           |
| [Vitest](examples/05-vitest.test.ts)            | `npm run example:vitest`    | Share one node across Vitest tests and check an expected failure. |

Examples 1, 2, and 5 start and close their own nodes. Examples 3 and 4 connect to an existing node and leave it running. Testkit works with any test runner; example 5 shows Vitest, and the test suite in `tests/` uses `node:test`.

### Deployment and recovery

For example 3, supply an already-funded account and the expected network identity:

```sh
export THRUPUT_RPC_URL=http://127.0.0.1:9545
export THRUPUT_NETWORK_HASH=11111111111111111111111111111111
export THRUPUT_SIGNER_FILE=/absolute/path/to/signer.bin
export RUN_DIRECTORY=/absolute/path/to/new-run
npm run example:deploy
npm run example:reconcile
```

The hash above is the default local network identity. For another network, use its trusted expected hash. The signer file must contain a raw 32-byte Ed25519 seed; keep it private. `RUN_DIRECTORY` must be a new path inside an existing parent directory. The deployment script does not fund the account.

Example 4 needs only `THRUPUT_RPC_URL` and `RUN_DIRECTORY`. Keep the original chain available. It reads saved evidence, checks transaction status and receipts, and leaves the report unchanged.

Steps accept optional public JSON metadata:

```ts
await scenario.run.step(
  "deploy-counter",
  () => alice.deploy(deployment, options),
  {
    metadata: { label: "Deploy counter", environment: "local" },
  },
);
```

Metadata is copied and saved before the callback.

### Run reports

A durable run directory contains:

- `report.json`: the public record. Share this file.
- `evidence/<attempt id>.json`: signed transaction bytes, saved before dispatch. Owner-only (mode 0600). Do not share.

`report.json` has these fields:

- `actors`: actor names mapped to addresses.
- `steps`: each named step, with `running`, `completed`, or `failed`, and its metadata.
- `attempts`: each transaction, with its actor, step, `operation` (`deploy`, `call`, `submit`, `fund`, or `wallet`), hash, receipt, and `outcome`.

An `outcome` is `succeeded`, `failed`, `notSubmitted`, or `unknown`. A failed step can contain a successful transaction. An unknown outcome never permits another submission. Faucet requests from `actor.fund` have a hash and an outcome, but no receipt or evidence file, because the run does not sign them.

`reconcileRun` observes every attempt again, by its signed evidence or, for faucet requests, by hash. It returns the latest outcomes and does not change the report. Within `schemaVersion` 1, fields are only added, never renamed or removed. The API reference for `RunReport` and `RunAttempt` documents each field.

### Important behavior

- **Funding is explicit.** Supply local allocations, or call `actor.fund` on a network with a faucet. Contract storage funding is separate from gas budgets.
- **Network identity is explicit.** Attached scenarios require an expected network hash and validate it before signing.
- **Node ownership is explicit.** `withLocalScenario` closes its node; `withScenario` leaves the external node running.
- **Errors are client `ThruputError`s.** After signing, `error.transaction` gives the hash, outcome, reason, and signed evidence, as in the client. If testkit cannot save the signed evidence, the code is `transactionNotSubmitted` with reason `persistenceFailed`. If it cannot save the report after a send, the code is `testkitPersistenceFailed`, and the transaction can still have committed. If the report also cannot record the failure, the error is an `AggregateError` whose first entry is the original error.
- **Writes are not retried.** A timeout can follow commitment. Retain the original signed evidence and use `scenario.observe` or `reconcileRun` to inspect it before deciding what to do next. Faucet requests from `actor.fund` are recorded by hash and reconciled by hash; the run does not sign them.

The counter artifact is an Apache-2.0 test fixture, not a release-qualified application artifact. Its [source and SHA-256](tests/fixtures/provenance.json) are recorded with the test fixtures. The matching TypeScript binding is generated; do not edit it by hand.

## Development

Generate the API reference from source comments with `npm run docs`, then open `docs/api/index.html`. Generated files are not committed. `npm run docs:check` validates the reference without writing files.

```sh
npm run format:check
npm run typecheck
npm run docs:check
npm test
npm run build
npm run test:package
```

`test:package` checks installed-package imports and example types. With the Linux runtime prerequisites installed, `npm run test:integration` also runs the examples and integration workflows against real nodes.
