import { expect, it } from "vitest";
import {
  ExecutionDecodeError,
  ExecutionReturnUnavailableError,
  FundingObservationError,
  TransactionExecutionError,
  TransactionObservationError,
  UnsupportedRpcValue,
  toBase58,
  type TransactionReceipt,
} from "@thruputchain/client";
import { RunPersistenceError, summarizeTransaction } from "./index.js";

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

it("separates successful execution from decoding and persistence failures", () => {
  for (const error of [
    new ExecutionDecodeError(receipt, new Error("private data")),
    new ExecutionReturnUnavailableError(receipt),
    new RunPersistenceError(new Error("disk full"), submission, receipt),
  ]) {
    expect(summarizeTransaction({ error })).toEqual({
      outcome: "succeeded",
      transactionHash: toBase58(receipt.transactionHash),
    });
  }
});

it("requires known execution evidence, not just commitment or a thrown error", () => {
  const aborted: TransactionReceipt = {
    ...receipt,
    execution: { result: "abort", abortData: new Uint8Array([1]) },
  };
  expect(
    summarizeTransaction({
      error: new TransactionExecutionError(aborted, submission),
    }).outcome,
  ).toBe("failed");
  expect(summarizeTransaction({ error: new Error("timeout") })).toEqual({
    outcome: "unknown",
  });
  expect(
    summarizeTransaction({
      receipt: {
        ...receipt,
        execution: new UnsupportedRpcValue({ result: "future" }),
      },
    }).outcome,
  ).toBe("unknown");
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
    expect(summarizeTransaction({ error }).outcome).toBe(
      phase === "beforeSubmission" ? "not-submitted" : "unknown",
    );
    expect(summarizeTransaction({ receipt, error }).outcome).toBe("succeeded");
  }
});

it("retains faucet hashes and nested execution evidence without calling the faucet", () => {
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
    summarizeTransaction({
      error: new FundingObservationError(
        request,
        response,
        new Error("timeout"),
      ),
    }),
  ).toEqual({
    outcome: "unknown",
    transactionHash: toBase58(submission.transactionHash),
  });
  expect(
    summarizeTransaction({
      error: new FundingObservationError(
        request,
        response,
        new ExecutionDecodeError(receipt, new Error("decode")),
      ),
    }).outcome,
  ).toBe("succeeded");
});
