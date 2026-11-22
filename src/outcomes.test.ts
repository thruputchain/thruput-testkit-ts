import { expect, it } from "vitest";
import {
  ExecutionDecodeError,
  ExecutionReturnUnavailableError,
  FundingObservationError,
  TransactionExecutionError,
  TransactionObservationError,
  TransactionReceiptTimeoutError,
  UnsupportedRpcValue,
  UnsupportedTransactionOutcomeError,
  type TransactionReceipt,
} from "@thruputchain/client";
import { errorOutcome, receiptOutcome } from "./outcomes.js";

const submission = {
  transactionHash: new Uint8Array(32).fill(1),
  networkHash: new Uint8Array(32),
  signedTransaction: new Uint8Array([1]),
};
const receipt: TransactionReceipt = {
  transactionHash: submission.transactionHash,
  blockHeight: 7n,
  execution: { result: "return", returnData: new Uint8Array() },
  events: [],
  gasUsed: 10n,
};
const aborted: TransactionReceipt = {
  ...receipt,
  execution: { result: "abort", abortData: new Uint8Array([1]) },
};
const future: TransactionReceipt = {
  ...receipt,
  execution: new UnsupportedRpcValue({ result: "future" }),
};

it("classifies receipts by execution result, not by commitment", () => {
  expect(receiptOutcome(receipt)).toBe("succeeded");
  expect(receiptOutcome(aborted)).toBe("failed");
  expect(receiptOutcome(future)).toBe("unknown");
});

it("keeps successful execution separate from return decoding failures", () => {
  for (const error of [
    new ExecutionDecodeError(receipt, new Error("private data")),
    new ExecutionReturnUnavailableError(receipt),
  ])
    expect(errorOutcome(error).outcome).toBe("succeeded");
  expect(
    errorOutcome(new TransactionExecutionError(aborted, submission)).outcome,
  ).toBe("failed");
  expect(
    errorOutcome(new UnsupportedTransactionOutcomeError(future, submission))
      .outcome,
  ).toBe("unknown");
});

it("reports notSubmitted only before dispatch", () => {
  for (const phase of [
    "beforeSubmission",
    "submission",
    "observation",
  ] as const) {
    const error = new TransactionObservationError(
      submission,
      new Error("stopped"),
      undefined,
      undefined,
      phase,
    );
    expect(errorOutcome(error)).toEqual({
      outcome: phase === "beforeSubmission" ? "notSubmitted" : "unknown",
      transactionHash: submission.transactionHash,
    });
  }
});

it("keeps the hash of a stopped receipt observation", () => {
  const error = new TransactionReceiptTimeoutError(
    submission.transactionHash,
    undefined,
    undefined,
  );
  expect(errorOutcome(error)).toEqual({
    outcome: "unknown",
    transactionHash: submission.transactionHash,
  });
});

it("returns unknown without a hash for unrelated errors", () => {
  expect(errorOutcome(new Error("timeout"))).toEqual({
    outcome: "unknown",
  });
});

it("keeps faucet hashes and nested execution evidence", () => {
  const request = {
    recipient: new Uint8Array(32),
    clientNonce: new Uint8Array(16),
    networkHash: submission.networkHash,
  };
  const response = {
    attemptStatus: "pending" as const,
    recipient: request.recipient,
    rawAmount: 1n,
    retryAfterSeconds: 1n,
    transactionHash: submission.transactionHash,
  };
  expect(
    errorOutcome(
      new FundingObservationError(request, response, new Error("timeout")),
    ),
  ).toEqual({
    outcome: "unknown",
    transactionHash: submission.transactionHash,
  });
  expect(
    errorOutcome(
      new FundingObservationError(
        request,
        response,
        new ExecutionDecodeError(receipt, new Error("decode")),
      ),
    ).outcome,
  ).toBe("succeeded");
});
