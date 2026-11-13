import {
  ExecutionDecodeError,
  ExecutionReturnUnavailableError,
  FundingObservationError,
  TransactionExecutionError,
  TransactionObservationError,
  TransactionReceiptObservationError,
  UnsupportedRpcValue,
  toBase58,
  type TransactionReceipt,
  type SubmissionEvidence,
} from "@thruputchain/client";

/** Execution outcome, separate from whether the surrounding script threw. */
export type TransactionOutcome =
  | "succeeded"
  | "failed"
  | "not-submitted"
  | "unknown";

/** Public facts only. An unknown outcome never authorizes resubmission. */
export interface TransactionSummary {
  outcome: TransactionOutcome;
  transactionHash?: string;
}

/** A persistence failure can follow commitment. Inspect the retained evidence. */
export class RunPersistenceError extends Error {
  constructor(
    cause: unknown,
    readonly submission?: SubmissionEvidence,
    readonly receipt?: TransactionReceipt,
  ) {
    super("Could not persist run evidence", { cause });
    this.name = "RunPersistenceError";
  }
}

/**
 * Summarize a receipt or an SDK error without throwing away the original evidence.
 * A receipt takes precedence over an error. Commitment alone does not prove success.
 * Error messages are not copied: they can contain private application data.
 */
export function summarizeTransaction(input: {
  receipt?: TransactionReceipt | null;
  error?: unknown;
}): TransactionSummary {
  const { error } = input;
  const receipt =
    input.receipt ??
    (error instanceof TransactionExecutionError ||
    error instanceof ExecutionDecodeError ||
    error instanceof ExecutionReturnUnavailableError ||
    error instanceof RunPersistenceError
      ? error.receipt
      : undefined);
  if (receipt) {
    const execution = receipt.execution;
    return {
      transactionHash: toBase58(receipt.transactionHash),
      outcome:
        execution instanceof UnsupportedRpcValue
          ? "unknown"
          : execution.result === "return"
            ? "succeeded"
            : "failed",
    };
  }
  if (error instanceof FundingObservationError) {
    const summary = summarizeTransaction({ error: error.cause });
    const response = error.lastResponse;
    const hash =
      error.knownCommitment?.transactionHash ??
      (response && !(response instanceof UnsupportedRpcValue)
        ? response.transactionHash
        : undefined);
    return { ...summary, ...(hash ? { transactionHash: toBase58(hash) } : {}) };
  }
  if (error instanceof TransactionObservationError) {
    return {
      outcome: error.phase === "beforeSubmission" ? "not-submitted" : "unknown",
      transactionHash: toBase58(error.transactionHash),
    };
  }
  if (error instanceof TransactionReceiptObservationError) {
    return {
      outcome: "unknown",
      transactionHash: toBase58(error.transactionHash),
    };
  }
  if (error instanceof RunPersistenceError && error.submission) {
    return {
      outcome: "unknown",
      transactionHash: toBase58(error.submission.transactionHash),
    };
  }
  return { outcome: "unknown" };
}
