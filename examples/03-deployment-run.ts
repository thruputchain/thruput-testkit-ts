// Run: npm run example:deploy
// Set THRUPUT_RPC_URL, THRUPUT_NETWORK_HASH, THRUPUT_SIGNER_FILE, RUN_DIRECTORY.
// The signer file contains a 32-byte Ed25519 seed. Its account must be funded.
import { readFile } from "node:fs/promises";
import {
  createPubkeyAccount,
  Ed25519Signer,
  hashFromBase58,
  gasAmount,
  localnet,
  networkHash,
  toBase58,
} from "@thruputchain/client";
import { loadArtifacts, withScenario } from "@thruputchain/testkit";
import { Counter } from "./fixtures/counter.js";

const {
  THRUPUT_RPC_URL,
  THRUPUT_NETWORK_HASH,
  THRUPUT_SIGNER_FILE,
  RUN_DIRECTORY,
} = process.env;
if (
  !THRUPUT_RPC_URL ||
  !THRUPUT_NETWORK_HASH ||
  !THRUPUT_SIGNER_FILE ||
  !RUN_DIRECTORY
) {
  throw new Error(
    "Set THRUPUT_RPC_URL, THRUPUT_NETWORK_HASH, THRUPUT_SIGNER_FILE, and RUN_DIRECTORY (see README.md).",
  );
}
const seed = await readFile(THRUPUT_SIGNER_FILE);
if (seed.length !== 32)
  throw new Error("The signer file must contain exactly 32 bytes.");
const deployer = createPubkeyAccount({ signer: Ed25519Signer.fromSeed(seed) });
const artifacts = await loadArtifacts({
  counter: new URL("./fixtures/counter.rv32a", import.meta.url),
});

// Supply the expected identity from trusted configuration, not RPC discovery.
await withScenario(
  {
    network: {
      cluster: localnet({
        rpcUrl: THRUPUT_RPC_URL,
        networkHash: networkHash(hashFromBase58(THRUPUT_NETWORK_HASH)),
      }),
      signal: AbortSignal.timeout(60_000),
    },
    accounts: { deployer },
    runDirectory: RUN_DIRECTORY, // A new path inside an existing parent.
  },
  async (scenario) => {
    const actor = scenario.actor("deployer");
    const deployment = artifacts.counter.prepare(actor.account.address);
    console.log("Run report:", scenario.run.directory);

    const result = await scenario.run.step("deploy-counter", () =>
      actor.deploy(deployment, {
        amount: 50_000_000n,
        initializer: Counter.v0_1.initialize.call({
          address: deployment.address,
          gasLimit: gasAmount(500_000n),
          args: { initialValue: 42n },
        }),
      }),
    );
    console.log("Deployed counter:", toBase58(result.address));
    console.log("Confirmed block:", result.receipt.blockHeight);
  },
);
// The external node stays running. On failure, inspect this run with example 05.
// Do not rerun an unresolved deployment: a lost response can follow commitment.
