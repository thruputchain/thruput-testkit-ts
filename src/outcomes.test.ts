import { expect, it } from "vitest";
import {
  isThruputError,
  UnsupportedRpcValue,
  type TransactionReceipt,
} from "@thruputchain/client";
import { persistenceFailed, receiptFacts, receiptOutcome } from "./outcomes.js";

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

it("classifies receipts as the client does, never by commitment alone", () => {
  expect(receiptFacts(receipt, "persistenceFailed", submission)).toEqual({
    hash: receipt.transactionHash,
    outcome: "succeeded",
    reason: "persistenceFailed",
    receipt,
    submission,
  });
  const failed = (execution: TransactionReceipt["execution"]) =>
    receiptFacts({ ...receipt, execution }, "persistenceFailed");
  expect(
    failed({ result: "abort", abortData: new Uint8Array([1]) }),
  ).toMatchObject({ outcome: "failed", reason: "aborted" });
  expect(failed({ result: "fault" } as never)).toMatchObject({
    outcome: "failed",
    reason: "faulted",
  });
  // An execution result the client does not support proves nothing.
  expect(failed(new UnsupportedRpcValue({ result: "future" }))).toMatchObject({
    outcome: "unknown",
    reason: "outcomeUnsupported",
  });
  expect(failed({ result: "future" } as never).outcome).toBe("unknown");
  expect(receiptOutcome(receipt)).toBe("succeeded");
});

it("reports persistence failures as ThruputErrors, with facts when known", () => {
  const cause = new Error("disk full");
  const plain = persistenceFailed(cause);
  expect(isThruputError(plain, "testkitPersistenceFailed")).toBe(true);
  expect(plain.cause).toBe(cause);
  expect(plain.transaction).toBeUndefined();
  const committed = persistenceFailed(
    cause,
    receiptFacts(receipt, "persistenceFailed", submission),
  );
  expect(committed.transaction).toMatchObject({
    outcome: "succeeded",
    reason: "persistenceFailed",
  });
});
