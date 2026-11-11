# Thruput testkit

Run application scenarios from Node.js tests and scripts using the public Thruput SDK.

Start an isolated local node or attach to an existing network. Each named actor exposes an ordinary SDK wallet. Generated bindings keep their existing argument and result types.

## Package and runtime

This standalone repository builds `@thruputchain/testkit`. Its runtime depends on the published `@thruputchain/client` 0.26.x package. No SDK checkout or workspace link is required.

Node.js 22.12 or later is required. Development uses Node 24. CI checks Node 22, 24, and 26, plus the exact runtime floor. This is a Node-focused package; browser applications should use the client directly.

The package is not published yet. From the repository root:

```sh
npm ci
npm run build
npm pack
```

Install that tarball in a consumer project alongside `@thruputchain/client@0.26.0`. The example below also imports `@thruputchain/protocol@0.20.0` for the native token address.

## Start a local scenario

Managed local nodes require Linux, `thruput` CLI 0.44.0 on PATH, and the native libraries required by devnode 0.1.32. Install the CLI with `cargo install thruput@0.44.0 --locked`. The CLI downloads devnode into each fixture's private cache, so startup requires download access. The testkit checks CLI 0.44.0 and wire format 14.4.0 before returning a scenario. `LOCAL_RUNTIME` exports these pins.

Process cleanup requires `ps` from procps. Real-node checks have passed on Linux x86-64 with Node 24 and the Node 22.12 runtime floor. The qualified devnode links to glibc, libstdc++, libgcc, libatomic, jemalloc, Snappy, zlib, bzip2, LZ4, Zstandard, OpenSSL 3, and Brotli. Install the corresponding runtime libraries for your distribution.

```ts
import { withLocalScenario } from "@thruputchain/testkit";

await withLocalScenario(
  {
    seed: "transfer-test-v1",
    accounts: {
      alice: { initialStorageTokens: 1_000_000_000n },
      bob: { initialStorageTokens: 1_000_000_000n },
    },
  },
  async (scenario) => {
    const alice = scenario.actor("alice");
    console.log(await alice.wallet.getBalance());
  },
);
```

The seed and actor name determine each Ed25519 account. Reordering actors or changing allocations does not change their addresses. These are public, repeatable test identities for disposable local nodes. Hosted workflows use supplied signers through `withScenario`.

`initialStorageTokens` is an explicit genesis allocation in raw native-token units, from `1n` through `9223372036854775807n`. Account storage consumes part of this allocation; the spendable balance can be lower. Choose enough funds for storage and the planned transactions. The testkit writes only public keys and allocations to disk. It does not request faucet funds automatically.

Each fixture owns a private directory, isolated CLI configuration and cache, and OS-assigned ports. Two fixtures can use the same seed without sharing chain state.

### Local options and lifetime

`createLocalScenario(options)` returns the same object without a callback. Close it in `finally`. Both local functions accept:

- `cli`: a CLI executable name or path. Defaults to `thruput`.
- `directory`: an existing parent directory for a unique fixture directory. Defaults to the OS temporary directory.
- `keepDirectory`: retain logs and node state after close or failed startup. Defaults to `false`. Startup errors include the last stderr output and retain the original error as `cause`.
- `startupTimeoutMs`: total startup budget, including installation and discovery. Defaults to 120,000 ms.
- `signal`: abort startup and close the owned node on cancellation. For a test deadline, pass the test runner's signal or `AbortSignal.timeout(...)`.
- `blockDriver`: `instant` (default) or `interval`. Manual blocks are not yet supported.
- `requiredMethods` and `onSigned`: the same discovery requirements and evidence hook used by attached scenarios.

`scenario.local` reports the RPC URL, directory, and supported controls. `manualBlocks` and `snapshots` are `false`; an unsupported block driver fails before startup. RPC capabilities remain available through the SDK client.

`close()` cancels RPC dispatch and waits for the CLI and its backend processes to stop. It is idempotent. Cleanup runs after callback failure, startup failure, timeout, cancellation, and SIGINT/SIGTERM. Signal handlers are installed only while fixtures are owned. Normal signal exit is restored if the application has no handler of its own. SIGKILL and abrupt host termination cannot run cleanup.

Cancellation stops owned processes even if user code is still running. It does not join arbitrary user tasks. Await `close()` to observe cleanup errors. Logs are removed by default; failed process cleanup retains them for diagnosis. Attached nodes remain owned by their callers.

## Attach to a network

The following TypeScript function accepts an existing local node URL and two SDK pubkey accounts. Both accounts must already be funded. It submits one transfer and reads Bob's balance from a snapshot that includes the transaction.

```ts
import { gasAmount, localnet, type PubkeyAccount } from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import { withScenario } from "@thruputchain/testkit";

export async function transfer(
  rpcUrl: string,
  accounts: { alice: PubkeyAccount; bob: PubkeyAccount },
) {
  return withScenario(
    { network: { cluster: localnet({ rpcUrl }) }, accounts },
    async (scenario) => {
      const alice = scenario.actor("alice");
      const bob = scenario.actor("bob");
      const result = await alice.wallet.executeCallsAndWait(
        {
          calls: [
            ERC20.v0_1.transfer.call({
              address: NATIVE_TOKEN_ADDRESS,
              gasLimit: gasAmount(500_000n),
              args: { receiver: bob.account.address, amount: 1_000n },
            }),
          ],
          gasLimit: gasAmount(1_000_000n),
        },
        { timeoutMs: 30_000, signal: scenario.signal },
      );

      return ERC20.v0_1.getBalanceOf.view({
        client: scenario.client,
        address: NATIVE_TOKEN_ADDRESS,
        args: { addr: bob.account.address },
        minStateBlockHeight: result.receipt.blockHeight,
        signal: scenario.signal,
      });
    },
  );
}
```

Call `transfer` from a standalone script or await it inside `node:test` or Vitest. A real-node scenario is an integration test. The testkit does not execute contracts in process.

The SDK view rejects a stale snapshot; it does not wait for one. Keep write evidence before starting dependent reads. The runnable [local workflow](tests/live-workflow.mjs) demonstrates explicit SDK operations and faucet funding. Use the scenario helpers below to carry confirmed heights into dependent reads automatically.

## Typed operations

Actors provide `call`, `submit`, and `deploy` alongside their ordinary SDK `wallet`. Pass calls built by generated descriptors. Child gas budgets remain explicit. By default, `call` and `submit` use the sum of those budgets plus `SCENARIO_GAS.walletOverhead` (500,000 gas). Deployment uses `SCENARIO_GAS.deployment` (10,000,000 gas). Override the root budget with `gasLimit`. These are budgets, not estimates.

Load named artifacts once, then prepare a deployment for an actor:

```ts
import { gasAmount } from "@thruputchain/client";
import { loadArtifacts } from "@thruputchain/testkit";
import { Counter } from "./target/thruput/counter.js";

const artifacts = await loadArtifacts({
  counter: "./target/thruput/counter.rv32a",
});
// Inside a scenario callback:
const alice = scenario.actor("alice");
const bob = scenario.actor("bob");
const deployment = artifacts.counter.prepare(alice.account.address);
const address = deployment.address;
const gasLimit = gasAmount(500_000n);

await alice.deploy(deployment, {
  amount: 50_000_000n,
  initializer: Counter.v0_1.initialize.call({
    address,
    gasLimit,
    args: { initialValue: 42n },
  }),
});
const result = await bob.call([
  Counter.v0_1.increment.call({ address, gasLimit, args: { amount: 5n } }),
  Counter.v0_1.get.call({ address, gasLimit }),
]);
// result.values is typed as [void, bigint]. Events remain in result.receipt.
const current = await scenario.view(Counter.v0_1.get.viewRequest({ address }));
// current.value is 47n; its snapshot includes Bob's confirmed transaction.
```

Use bindings generated from the matching artifact. `loadArtifacts` retains the bytes in memory. `prepare` uses the SDK to predict an address without sending anything; an optional second argument sets the deployment nonce. `deploy` requires an explicit storage-funding `amount`, including zero to skip funding. Funding, deployment, and optional initialization form one atomic transaction. Initializer return data is discarded by the SDK wallet. Events stay in the receipt and can be decoded with generated event descriptors.

### Observation and read consistency

`submit` sends once and returns signed evidence with a read-only `wait` method:

```ts
const pending = await bob.submit([
  Counter.v0_1.get.call({ address, gasLimit }),
]);
const result = await pending.wait({ timeoutMs: 30_000 });
// If this wait stops, retain pending and call pending.wait(...) again.
```

`call` combines submission and observation. Its `timeoutMs` bounds submission after signing; `wait` supplies separate receipt options. `signal` cancels the operation. Cancellation during preparation or signing prevents later dispatch once that work returns. It cannot undo a broadcast. Deployment uses the SDK's default transaction expiry; calls can override `expiryBlocks`.

Each helper operation reserves a distinct transaction nonce before asynchronous preparation. Parallel calls, including aliases of one account, do not reuse a reservation within the scenario. Failed and uncertain operations consume their reservations. Reservations start from a random value in each scenario and are not a persistent account sequence. Application ordering remains explicit: await a write before starting work that depends on it. Direct `actor.wallet` operations keep ordinary SDK behavior and are outside this reservation scope.

`scenario.confirmedHeight` tracks the highest committed height learned by helpers across all actors, including commitment evidence from a stopped receipt wait. `scenario.view` requests at least that height, combined with an optional `minStateBlockHeight`. It retries only the SDK's typed stale-snapshot error, with a default 30-second timeout and 50 ms polling interval. Override these with `timeoutMs` and `pollingIntervalMs`. Reads capture the dependency height when they start; they do not wait for concurrent writes that have not been observed yet. For direct SDK writes or another scenario's receipts, pass the required height explicitly.

SDK execution errors retain their receipts. A decode failure after successful execution also retains its receipt and signed evidence; it is not permission to repeat the write. Both advance the confirmed-height requirement. A submission or observation failure raises `TransactionObservationError` with the original signed evidence and cause. Use `scenario.observe(error.submission)` to inspect that transaction without sending it again. The result is an SDK execution result; use `decodeExecution` with the original calls if typed values are needed. No helper retries writes.

## API

### `withScenario(options, run)`

Connect, run an async callback, and close after it succeeds or throws. The callback's return type and errors pass through unchanged.

Options:

- `network`: the SDK's cluster connection options, including optional transport, required RPC methods, and cancellation signal. The cluster must contain an expected `networkHash`. `localnet()` supplies the default local identity. For another network, pass its expected identity explicitly.
- `accounts`: a mapping from actor names to supplied `PubkeyAccount` objects. Names must be nonempty and have no surrounding whitespace. Funding is explicit.
- `onSigned(actorName, evidence)`: an optional SDK hook awaited before broadcast. Use it to save signed transaction evidence. A rejected hook prevents submission. The hook receives signing evidence, not private signer keys.

The SDK validates the network and required capabilities before actors become available. A cluster without the faucet capability does not gain faucet methods through its actors.

### `createScenario(options)`

Connect and return a scenario for explicit lifetime management:

```ts
const scenario = await createScenario(options);
try {
  await run(scenario);
} finally {
  await scenario.close();
}
```

A scenario exposes:

- `client`: the connected SDK client. Its cluster and discovery metadata describe the network and RPC capabilities.
- `actor(name)`: the actor's name, supplied account, and signer-bound SDK wallet. Unknown names throw. Each configured name returns the same actor.
- `signal`: canceled by `close()` or the supplied network signal. Pass it to SDK observation helpers and your own waits.
- `close()`: idempotently cancels scenario RPC requests and prevents new dispatch through saved client or wallet references. It leaves the attached node running.

Await your workflow before closing. Closing does not join arbitrary user tasks, revoke supplied signers, or destroy a caller-owned transport. A custom transport must honor per-request abort signals. Local encoding and signing methods remain ordinary SDK methods.

Cancellation does not undo a submitted transaction. Retain its original evidence and inspect it with another connected client. The testkit does not retry writes or change SDK failure semantics.

## Rust testkit feature map

| Rust concept                       | TypeScript direction                            | Current slice                           |
| ---------------------------------- | ----------------------------------------------- | --------------------------------------- |
| Existing network                   | Pinned SDK cluster connection                   | Included                                |
| Scenario and caller                | Async scope, named actors, SDK wallets          | Included; supplied pubkey accounts      |
| Typed remote methods               | Existing generated descriptors and wallet calls | Included; typed actor helpers           |
| Local node and fixture allocations | Managed network adapter                         | Included; Linux CLI-backed nodes        |
| Deployment and consistent reads    | Small helpers over SDK operations               | Included                                |
| Retained submission evidence       | SDK evidence hook and errors                    | Included; durable run reports in GH-612 |
| Concurrent agents, mailbox, RNG    | Async functions and explicit coordination       | GH-610                                  |
| Manual block production            | Supported local supervisor controls             | GH-615                                  |
| Offline mode and virtual clock     | Add when a concrete consumer needs them         | Deferred                                |
| Calls by name                      | Existing generated bindings first               | Deferred                                |

Seeded inputs do not guarantee deterministic network scheduling. Agent time and chain time are separate. Manual block controls remain a separate work item.

## Verify

Run from the repository root:

```sh
npm run typecheck
npm test
npm run build
npm run test:package
npm run test:integration
```

The package check installs the testkit tarball outside the checkout with the published SDK, checks strict consumer types, loads ESM and CommonJS exports, and tests signal cleanup in child processes. Unit tests cover lifecycle failures and deterministic accounts. Managed-process tests run on Linux; other platforms reject managed startup clearly. Attached scenarios use the SDK on supported Node.js platforms.

The integration command runs transfer and typed-deployment workflows as `node:test` tests and standalone scripts. It also checks concurrent managed fixtures, genesis funding, network mismatch rejection, isolation, and attached-node ownership. The deployment workflow checks cross-actor writes, fresh reads, events, contract aborts, and repeat observation. The counter artifact and CLI-generated binding are checked-in test fixtures; their source and hash are recorded in `tests/fixtures/provenance.json`. To run only packed managed-node checks, use `npm run test:package -- --managed` after building.

Live tests require Linux, the CLI version in `scripts/integration-versions.json`, and the native libraries required by that version's devnode. Install the pinned CLI with `cargo install thruput@<version> --locked`, or provide an installed matching CLI through `THRUPUT_CLI`. The harness acquires the pinned devnode in a temporary cache, validates the serving CLI and wire version, and cleans up its processes. It preserves logs after failure. Set `THRUPUT_INTEGRATION_LOG_DIR` to keep diagnostics at a chosen path.

The internal qualification harness was adapted from the SDK's integration harness. It checks the pinned serving identity independently of the public managed-node API.

Live CI is an opt-in workflow dispatch. It requires access to the configured `namespace-profile-hogd-linux-2604` runner; ordinary checks run on GitHub-hosted runners.

For a node that you already started:

```sh
THRUPUT_RPC_URL=http://127.0.0.1:9545 npm run test:package -- --live
```

This local smoke uses fresh disposable accounts and explicitly requests faucet funds. Hosted deployment examples and Futurenet qualification belong to GH-614.
