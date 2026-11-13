// Run: npm run example:reconcile
// Set RUN_DIRECTORY and THRUPUT_RPC_URL. No signer or funding is needed.
import {
  createThruputClient,
  hashFromBase58,
  localnet,
  networkHash,
} from "@thruputchain/client";
import { inspectRun, reconcileRun } from "@thruputchain/testkit";

const { RUN_DIRECTORY, THRUPUT_RPC_URL } = process.env;
if (!RUN_DIRECTORY || !THRUPUT_RPC_URL) {
  throw new Error("Set RUN_DIRECTORY and THRUPUT_RPC_URL (see README.md).");
}

const report = await inspectRun(RUN_DIRECTORY);
console.log("Run:", report.id);
console.log("Recorded steps:", report.steps);

// Use the original run's expected identity; reject a different network.
const client = await createThruputClient({
  cluster: localnet({
    rpcUrl: THRUPUT_RPC_URL,
    networkHash: networkHash(hashFromBase58(report.networkHash)),
  }),
  signal: AbortSignal.timeout(30_000),
});
const { observations } = await reconcileRun(RUN_DIRECTORY, client);
for (const observation of observations) {
  console.log({
    attempt: observation.attemptId,
    transaction: observation.transactionHash,
    status: observation.status,
    receipt: observation.receipt,
    error: observation.error,
  });
}
// Reconciliation sends no transactions and does not change the saved report.
// A missing receipt or read error leaves the outcome unresolved. Do not resend.
