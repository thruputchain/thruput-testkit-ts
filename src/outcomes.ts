import {
  ExecutionDecodeError,
  ExecutionReturnUnavailableError,
  FundingObservationError,
  TransactionExecutionError,
  TransactionObservationError,
  TransactionReceiptObservationError,
  UnsupportedRpcValue,
  type TransactionReceipt,
} from "@thruputchain/client";

/**
 * Execution outcome of one recorded attempt, separate from whether its step threw.
 *
 * - `succeeded`: a receipt shows successful execution.
 * - `failed`: a receipt shows failed execution.
 * - `notSubmitted`: the transaction was never dispatched.
 * - `unknown`: the evidence does not establish an outcome. Never resubmit; observe the hash.
 */
export type RunOutcome = "succeeded" | "failed" | "notSubmitted" | "unknown";

/** Internal. Replace with the client's `error.transaction` when it is released. */
export interface OutcomeSummary {
  readonly outcome: RunOutcome;
  readonly transactionHash?: Uint8Array;
}

/** Classify a receipt by its execution result. Commitment alone does not prove success. */
export function receiptOutcome(receipt: TransactionReceipt): RunOutcome {
  const { execution } = receipt;
  if (execution instanceof UnsupportedRpcValue) return "unknown";
  return execution.result === "return" ? "succeeded" : "failed";
}

/**
 * Classify an error from a client transaction or faucet operation.
 * Errors that carry a receipt use it. Error messages are never copied.
 */
export function errorOutcome(error: unknown): OutcomeSummary {
  if (
    error instanceof TransactionExecutionError ||
    error instanceof ExecutionDecodeError ||
    error instanceof ExecutionReturnUnavailableError
  )
    return {
      outcome: receiptOutcome(error.receipt),
      transactionHash: error.receipt.transactionHash,
    };
  if (error instanceof FundingObservationError) {
    // The cause can carry a receipt. The response and commitment carry the hash.
    const summary = errorOutcome(error.cause);
    const response = error.lastResponse;
    const transactionHash =
      error.knownCommitment?.transactionHash ??
      (response && !(response instanceof UnsupportedRpcValue)
        ? response.transactionHash
        : undefined) ??
      summary.transactionHash;
    return transactionHash ? { ...summary, transactionHash } : summary;
  }
  if (error instanceof TransactionObservationError)
    return {
      outcome: error.phase === "beforeSubmission" ? "notSubmitted" : "unknown",
      transactionHash: error.transactionHash,
    };
  if (error instanceof TransactionReceiptObservationError)
    return { outcome: "unknown", transactionHash: error.transactionHash };
  return { outcome: "unknown" };
}
