import { expect, it, vi } from "vitest";
import {
  createPubkeyAccount,
  Ed25519Signer,
  localnet,
  MockTransport,
  gasAmount,
  deserializeSignedTransaction,
  ExecutionDecodeError,
  TransactionExecutionError,
  TransactionObservationError,
  JsonRpcError,
  toBase58,
  ContractViewError,
  ContractDecodeError,
  type RpcParams,
  type TransportRequestOptions,
  type SubmissionEvidence,
  type Transport,
} from "@thruputchain/client";
import { Counter } from "../tests/fixtures/counter.js";
import { createScenario, withScenario, SCENARIO_GAS } from "./index.js";

function fixture() {
  const mock = new MockTransport();
  const state = {
    receipts: true,
    receiptData: "0x01012a",
    abort: false,
    stale: 0,
    viewFault: false,
    failSubmit: false,
    hangSubmit: false,
    viewData: "0x2a",
  };
  const request = vi.fn(
    async <T>(
      method: string,
      params?: RpcParams,
      control?: TransportRequestOptions,
    ): Promise<T> => {
      if (method === "simulateInvocations" && state.stale-- > 0) {
        throw new JsonRpcError(
          -32012,
          "snapshot behind",
          {
            kind: "stateHeightUnavailable",
            requestedStateBlockHeight: String(
              (params as Record<string, unknown>).minStateBlockHeight,
            ),
            observedStateBlockHeight: "0",
          },
          method,
        );
      }
      const result = await mock.request<Record<string, unknown> | null>(
        method,
        params,
        control,
      );
      if (method === "sendTransaction" && state.failSubmit)
        throw new Error("connection lost after dispatch");
      if (method === "sendTransaction" && state.hangSubmit) {
        return new Promise<T>((_, reject) => {
          const signal = control!.signal!;
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        });
      }
      if (method === "getTransactionReceipt" && result) {
        if (!state.receipts) return null as T;
        result.execution = state.abort
          ? { result: "abort", abortData: "0x00" }
          : { result: "return", returnData: state.receiptData };
      }
      if (method === "simulateInvocations" && result) {
        result.results = [
          {
            output: state.viewFault
              ? { result: "fault" }
              : { result: "return", returnData: state.viewData },
            gasUsed: "1",
            events: [],
          },
        ];
      }
      return result as T;
    },
  );
  const account = createPubkeyAccount({
    signer: Ed25519Signer.fromSeed(new Uint8Array(32).fill(1)),
  });
  const options = {
    network: {
      cluster: localnet(),
      transport: { request: request as Transport["request"] },
    },
    accounts: { alice: account, alias: account },
  };
  const call = Counter.v0_1.get.call({
    address: account.address,
    gasLimit: gasAmount(500_000n),
  });
  const view = Counter.v0_1.get.viewRequest({ address: account.address });
  const writes = () =>
    request.mock.calls.filter(([method]) => method === "sendTransaction");
  return { state, options, call, view, request, writes };
}

it("reserves distinct identities for parallel calls, including aliases of one account", async () => {
  const f = fixture();
  const evidence: SubmissionEvidence[] = [];
  await withScenario(
    {
      ...f.options,
      onSigned: (_, value) => {
        evidence.push(value);
      },
    },
    async (scenario) => {
      const results = await Promise.all([
        scenario.actor("alice").call([f.call]),
        scenario.actor("alice").call([f.call]),
        scenario.actor("alias").call([f.call]),
      ]);
      expect(results.map((result) => result.values)).toEqual([
        [42n],
        [42n],
        [42n],
      ]);
      expect(
        new Set(evidence.map((e) => toBase58(e.transactionHash))).size,
      ).toBe(3);
      const transactions = evidence.map((e) =>
        deserializeSignedTransaction(e.signedTransaction),
      );
      expect(new Set(transactions.map((t) => t.tx.uniquifier.nonce)).size).toBe(
        3,
      );
      expect(transactions[0]!.tx.invocation.gas_limit).toBe(
        500_000n + SCENARIO_GAS.walletOverhead,
      );
      expect(scenario.confirmedHeight).toBe(3n);
      await scenario.view(f.view);
      expect(f.request).toHaveBeenCalledWith(
        "simulateInvocations",
        expect.objectContaining({ minStateBlockHeight: "3" }),
        expect.anything(),
      );
    },
  );
});

it("observes a stopped receipt wait again without another submission", async () => {
  const f = fixture();
  await withScenario(f.options, async (scenario) => {
    const pending = await scenario.actor("alice").submit([f.call]);
    f.state.receipts = false;
    await expect(
      pending.wait({ timeoutMs: 20, pollingIntervalMs: 1 }),
    ).rejects.toMatchObject({
      phase: "observation",
      submission: pending.submission,
    });
    expect(scenario.confirmedHeight).toBe(1n);
    f.state.receipts = true;
    expect((await pending.wait()).values).toEqual([42n]);
    expect(f.writes()).toHaveLength(1);
  });
});

it("retains uncertain submission evidence and reconciles only by reads", async () => {
  const f = fixture();
  await withScenario(f.options, async (scenario) => {
    f.state.failSubmit = true;
    let failure: TransactionObservationError | undefined;
    try {
      await scenario.actor("alice").call([f.call]);
    } catch (error) {
      expect(error).toBeInstanceOf(TransactionObservationError);
      failure = error as TransactionObservationError;
    }
    expect(failure!.phase).toBe("submission");
    expect(failure!.cause).toMatchObject({
      message: "connection lost after dispatch",
    });
    const observed = await scenario.observe(failure!.submission);
    expect(observed.transactionHash).toEqual(failure!.transactionHash);
    expect(f.writes()).toHaveLength(1);
  });
});

it("preserves failed execution and successful-execution decode errors with receipt evidence", async () => {
  const f = fixture();
  await withScenario(f.options, async (scenario) => {
    f.state.abort = true;
    await expect(scenario.actor("alice").call([f.call])).rejects.toBeInstanceOf(
      TransactionExecutionError,
    );
    expect(scenario.confirmedHeight).toBe(1n);
    f.state.abort = false;
    f.state.receiptData = "0x";
    await expect(scenario.actor("alice").call([f.call])).rejects.toMatchObject({
      receipt: { execution: { result: "return" } },
      submission: expect.anything(),
    });
    const pending = await scenario.actor("alice").submit([f.call]);
    await expect(pending.wait()).rejects.toBeInstanceOf(ExecutionDecodeError);
    expect(scenario.confirmedHeight).toBe(3n);
    expect(f.writes()).toHaveLength(3);
  });
});

it("waits for a fresh snapshot and does not retry contract failures", async () => {
  const f = fixture();
  await withScenario(f.options, async (scenario) => {
    await scenario.actor("alice").call([f.call]);
    f.state.stale = 2;
    expect((await scenario.view(f.view, { pollingIntervalMs: 1 })).value).toBe(
      42n,
    );
    expect(
      f.request.mock.calls.filter(
        ([method]) => method === "simulateInvocations",
      ),
    ).toHaveLength(3);
    f.state.viewFault = true;
    await expect(scenario.view(f.view)).rejects.toBeInstanceOf(
      ContractViewError,
    );
    expect(
      f.request.mock.calls.filter(
        ([method]) => method === "simulateInvocations",
      ),
    ).toHaveLength(4);
  });
});

it("bounds stale reads and honors per-operation cancellation", async () => {
  const f = fixture();
  await withScenario(f.options, async (scenario) => {
    f.state.stale = 100;
    await expect(
      scenario.view(f.view, {
        minStateBlockHeight: 1n,
        timeoutMs: 20,
        pollingIntervalMs: 1,
      }),
    ).rejects.toThrow("View did not reach confirmed height 1");
    const reason = new Error("cancel this call");
    await expect(
      scenario
        .actor("alice")
        .submit([f.call], { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(f.writes()).toHaveLength(0);
    expect(scenario.signal.aborted).toBe(false);
  });
});

it("awaits the evidence hook before dispatch and consumes the failed reservation", async () => {
  const f = fixture();
  const evidence: SubmissionEvidence[] = [];
  const failure = new Error("persistence failed");
  await withScenario(
    {
      ...f.options,
      onSigned: (_, value) => {
        evidence.push(value);
        if (evidence.length === 1) throw failure;
      },
    },
    async (scenario) => {
      await expect(
        scenario.actor("alice").call([f.call]),
      ).rejects.toMatchObject({ cause: failure, phase: "beforeSubmission" });
      expect(f.writes()).toHaveLength(0);
      await scenario.actor("alice").call([f.call]);
      expect(evidence[0]!.transactionHash).not.toEqual(
        evidence[1]!.transactionHash,
      );
      expect(f.writes()).toHaveLength(1);
    },
  );
});

it("prevents dispatch through saved actor helpers after close", async () => {
  const f = fixture();
  const scenario = await createScenario(f.options);
  const actor = scenario.actor("alice");
  await scenario.close();
  await expect(actor.call([f.call])).rejects.toThrow("closed");
  expect(f.writes()).toHaveLength(0);
});

it("validates wait controls before signing and honors an explicit root gas budget", async () => {
  const f = fixture();
  const signed: SubmissionEvidence[] = [];
  await withScenario(
    {
      ...f.options,
      onSigned: (_, value) => {
        signed.push(value);
      },
    },
    async (scenario) => {
      const actor = scenario.actor("alice");
      await expect(
        actor.call([f.call], { wait: { timeoutMs: 0 } }),
      ).rejects.toThrow("wait.timeoutMs");
      const stopped = new Error("receipt wait already stopped");
      await expect(
        actor.call([f.call], { wait: { signal: AbortSignal.abort(stopped) } }),
      ).rejects.toBe(stopped);
      expect(signed).toHaveLength(0);
      await actor.call([f.call], { gasLimit: gasAmount(2_000_000n) });
      expect(
        deserializeSignedTransaction(signed[0]!.signedTransaction).tx.invocation
          .gas_limit,
      ).toBe(2_000_000n);
    },
  );
});

it("cancellation during the persistence hook prevents broadcast", async () => {
  const f = fixture();
  const controller = new AbortController();
  await withScenario(
    {
      ...f.options,
      onSigned: () => {
        controller.abort(new Error("stop before dispatch"));
      },
    },
    async (scenario) => {
      await expect(
        scenario
          .actor("alice")
          .call([f.call], { wait: { signal: controller.signal } }),
      ).rejects.toMatchObject({ phase: "beforeSubmission" });
      expect(f.writes()).toHaveLength(0);
    },
  );
});

it("times out a dispatched submission without replacing its transaction", async () => {
  const f = fixture();
  await withScenario(f.options, async (scenario) => {
    f.state.hangSubmit = true;
    let failure: TransactionObservationError | undefined;
    try {
      await scenario.actor("alice").submit([f.call], { timeoutMs: 10 });
    } catch (error) {
      expect(error).toBeInstanceOf(TransactionObservationError);
      failure = error as TransactionObservationError;
    }
    expect(failure!.phase).toBe("submission");
    expect(failure!.cause).toMatchObject({
      message: "Submission timed out after 10ms",
    });
    await scenario.observe(failure!.submission);
    expect(f.writes()).toHaveLength(1);
  });
});

it("does not retry a generated view decoder failure", async () => {
  const f = fixture();
  await withScenario(f.options, async (scenario) => {
    f.state.viewData = "0x";
    await expect(scenario.view(f.view)).rejects.toBeInstanceOf(
      ContractDecodeError,
    );
    expect(
      f.request.mock.calls.filter(
        ([method]) => method === "simulateInvocations",
      ),
    ).toHaveLength(1);
  });
});
