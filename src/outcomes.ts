import {
  isUnsupportedRpcValue,
  ThruputError,
  toBase58,
  type SubmissionEvidence,
  type TransactionFactsInput,
  type TransactionOutcome,
  type TransactionReason,
  type TransactionReceipt,
} from "@thruputchain/client";

declare module "@thruputchain/client" {
  interface ThruputErrorContext {
    /**
     * Testkit could not save run evidence or its report. When a transaction is
     * involved, `transaction` describes it. A receipt that was already observed
     * gives its outcome; a successful execution has reason `persistenceFailed`.
     */
    testkitPersistenceFailed: Record<string, never>;
  }
}

/**
 * Execution outcome of one recorded attempt: the client's `TransactionOutcome`.
 * An `unknown` outcome never permits a resend.
 */
export type RunOutcome = TransactionOutcome;

/** Mirrors the client's errors/transaction.ts. Known failed execution results, with the reason the client reports for each. */
const failedResults: Readonly<Record<string, TransactionReason>> = {
  abort: "aborted",
  fault: "faulted",
  nonDeterministicError: "executionFailed",
  failedGasSponsorship: "executionFailed",
  other: "executionFailed",
};

/**
 * Transaction facts from a committed receipt, as the client builds them.
 * A successful execution uses `successReason`: the error is about a later step.
 */
export function receiptFacts(
  receipt: TransactionReceipt,
  successReason: TransactionReason,
  submission?: SubmissionEvidence,
): TransactionFactsInput {
  const { execution } = receipt;
  const result = isUnsupportedRpcValue(execution)
    ? undefined
    : execution.result;
  // Only known results count as failed; any other value is an unsupported outcome.
  const failure =
    result !== undefined && Object.hasOwn(failedResults, result)
      ? failedResults[result]
      : undefined;
  const [outcome, reason]: [TransactionOutcome, TransactionReason] =
    result === "return"
      ? ["succeeded", successReason]
      : failure
        ? ["failed", failure]
        : ["unknown", "outcomeUnsupported"];
  return {
    hash: receipt.transactionHash,
    outcome,
    reason,
    receipt,
    ...(submission ? { submission } : {}),
  };
}

/** Testkit could not save evidence or its report. */
export function persistenceFailed(
  cause: unknown,
  transaction?: TransactionFactsInput,
): ThruputError<"testkitPersistenceFailed"> {
  return new ThruputError(
    "testkitPersistenceFailed",
    transaction
      ? `Could not save run evidence for transaction ${toBase58(transaction.hash)}`
      : "Could not save run evidence",
    { cause, ...(transaction ? { transaction } : {}) },
  );
}

/** The outcome that a committed receipt shows. */
export function receiptOutcome(receipt: TransactionReceipt): RunOutcome {
  return receiptFacts(receipt, "resultUnavailable").outcome;
}
