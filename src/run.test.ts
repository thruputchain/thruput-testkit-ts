import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPubkeyAccount,
  Ed25519Signer,
  localnet,
  MockTransport,
  gasAmount,
  isThruputError,
  toBase58,
  type Transport,
  type SubmissionEvidence,
  type TransactionReceipt,
} from "@thruputchain/client";
import { Counter } from "../tests/fixtures/counter.js";
import { createScenario, inspectRun, reconcileRun } from "./index.js";
import type { ActorFundOperations } from "./operations.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "run-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const account = createPubkeyAccount({
  signer: Ed25519Signer.fromSeed(new Uint8Array(32).fill(7)),
});
const call = Counter.v0_1.get.call({
  address: account.address,
  gasLimit: gasAmount(500_000n),
});
function config(transport: Transport = new MockTransport()) {
  return {
    network: { cluster: localnet(), transport },
    accounts: { alice: account },
    runDirectory: join(root, "run"),
  };
}

it("persists intent and restricted evidence before dispatch, with public snapshots", async () => {
  const mock = new MockTransport();
  const request = vi.spyOn(mock, "request");
  let evidence: SubmissionEvidence | undefined;
  const scenario = await createScenario({
    ...config(mock),
    onSigned: async (_, signed) => {
      evidence = signed;
      const report = await inspectRun(join(root, "run"));
      const attempt = report.attempts[0]!;
      expect(attempt.state).toBe("signed");
      expect(attempt.step).toBe("query");
      expect(
        request.mock.calls.some(([method]) => method === "sendTransaction"),
      ).toBe(false);
      expect(
        (await stat(join(root, "run", "evidence", `${attempt.id}.json`))).mode &
          0o777,
      ).toBe(0o600);
    },
  });
  try {
    const pending = await scenario.run.step("query", () =>
      scenario.actor("alice").submit([call]),
    );
    const observed = await scenario.observe(pending.submission);
    const report = await inspectRun(join(root, "run"));
    expect(report.steps).toEqual([{ name: "query", state: "completed" }]);
    expect(report.attempts[0]!.state).toBe("committed");
    expect(report.attempts[0]!.outcome).toBe("succeeded");
    expect(report.attempts[0]!.receipt).toMatchObject({
      blockHeight: observed.receipt.blockHeight.toString(),
    });
    expect(JSON.stringify(report)).not.toContain(
      Buffer.from(evidence!.signedTransaction).toString("hex"),
    );
    expect(JSON.stringify(report)).not.toContain("signers");
    const snapshot = scenario.run.report();
    snapshot.steps.length = 0;
    expect(scenario.run.report().steps).toHaveLength(1);
    await expect(scenario.run.step("query", async () => {})).rejects.toThrow(
      "duplicate",
    );
    await expect(createScenario(config())).rejects.toMatchObject({
      code: "EEXIST",
    });
  } finally {
    await scenario.close();
  }
});

it("reconciles a committed transaction whose response was lost without another send", async () => {
  const mock = new MockTransport();
  let sends = 0;
  const transport: Transport = {
    async request(method, params, control) {
      const value = await mock.request(method, params, control);
      if (method === "sendTransaction") {
        sends++;
        throw new Error("lost response");
      }
      return value as never;
    },
  };
  const scenario = await createScenario(config(transport));
  try {
    await expect(
      scenario.run.step("attempt", () =>
        scenario.actor("alice").submit([call]),
      ),
    ).rejects.toMatchObject({
      code: "transactionOutcomeUnknown",
      transaction: { outcome: "unknown" },
    });
    const before = await inspectRun(join(root, "run"));
    expect(before.steps[0]!.state).toBe("failed");
    expect(before.attempts[0]!.state).toBe("signed");
    expect(before.attempts[0]!.outcome).toBe("unknown");
    const result = await reconcileRun(join(root, "run"), scenario.client);
    expect(result.observations[0]!.receipt).not.toBeNull();
    expect(result.observations[0]!.outcome).toBe("succeeded");
    expect(sends).toBe(1);
    expect(await inspectRun(join(root, "run"))).toEqual(before);
    // Model interruption after the evidence rename but before the public update.
    delete before.attempts[0]!.transactionHash;
    before.attempts[0]!.state = "intent";
    await writeFile(join(root, "run", "report.json"), JSON.stringify(before));
    expect(
      (await reconcileRun(join(root, "run"), scenario.client)).observations[0]!
        .receipt,
    ).not.toBeNull();
    expect(sends).toBe(1);
  } finally {
    await scenario.close();
  }
});

it("retains signed-but-undispatched evidence and rejects corruption", async () => {
  const scenario = await createScenario({
    ...config(),
    onSigned: () => {
      throw new Error("secret must not reach report");
    },
  });
  try {
    await expect(scenario.actor("alice").submit([call])).rejects.toMatchObject({
      transaction: { outcome: "notSubmitted", reason: "persistenceFailed" },
    });
    const result = await reconcileRun(join(root, "run"), scenario.client);
    expect(result.observations[0]!.receipt).toBeNull();
    expect(result.observations[0]!.status).toEqual({ status: "unknown" });
    expect(result.observations[0]!.outcome).toBe("notSubmitted");
    expect(JSON.stringify(result.report)).not.toContain(
      "secret must not reach report",
    );
    const report = await inspectRun(join(root, "run"));
    await writeFile(
      join(root, "run", "evidence", `${report.attempts[0]!.id}.json`),
      "{}",
    );
    await expect(
      reconcileRun(join(root, "run"), scenario.client),
    ).rejects.toThrow("Invalid signed run evidence");
  } finally {
    await scenario.close();
  }
});

it("persists copied metadata before execution and isolates concurrent step context", async () => {
  const scenario = await createScenario(config());
  const metadata = { label: "Read counter", details: { amount: "125" } };
  try {
    await Promise.all(
      ["first", "second"].map((name) =>
        scenario.run.step(
          name,
          async () => {
            const saved = await inspectRun(join(root, "run"));
            expect(
              saved.steps.find((step) => step.name === name)?.metadata,
            ).toEqual(metadata);
            const pending = await scenario.actor("alice").submit([call]);
            await scenario.observe(pending.submission);
          },
          { metadata },
        ),
      ),
    );
    metadata.details.amount = "999";
    const report = scenario.run.report();
    expect(
      report.steps.every(
        (step) =>
          (step.metadata?.details as { amount: string }).amount === "125",
      ),
    ).toBe(true);
    expect(report.attempts.map((attempt) => attempt.step).sort()).toEqual([
      "first",
      "second",
    ]);
    expect(
      report.attempts.every((attempt) => attempt.outcome === "succeeded"),
    ).toBe(true);
  } finally {
    await scenario.close();
  }
});

it("rejects invalid metadata before invoking the action or reserving the step name", async () => {
  const scenario = await createScenario(config());
  const action = vi.fn(async () => {});
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  try {
    for (const value of [
      1n,
      undefined,
      NaN,
      new Uint8Array(32),
      new Date(),
      cyclic,
    ]) {
      await expect(
        scenario.run.step("invalid", action, {
          metadata: { value } as never,
        }),
      ).rejects.toThrow("JSON values");
    }
    expect(action).not.toHaveBeenCalled();
    expect(scenario.run.report().steps).toEqual([]);
    await scenario.run.step("invalid", action, {
      metadata: { value: "valid" },
    });
  } finally {
    await scenario.close();
  }
});

it("keeps successful transaction outcomes when the surrounding step fails", async () => {
  const scenario = await createScenario(config());
  try {
    await expect(
      scenario.run.step("check", async () => {
        const pending = await scenario.actor("alice").submit([call]);
        await scenario.observe(pending.submission);
        throw new Error("application assertion failed");
      }),
    ).rejects.toThrow("application assertion failed");
    const report = await inspectRun(join(root, "run"));
    expect(report.steps[0]!.state).toBe("failed");
    expect(report.attempts[0]!.outcome).toBe("succeeded");
    // Older v1 reports without summaries remain readable and reconcilable.
    delete report.attempts[0]!.outcome;
    await writeFile(join(root, "run", "report.json"), JSON.stringify(report));
    expect(
      (await reconcileRun(join(root, "run"), scenario.client)).observations[0]!
        .outcome,
    ).toBe("succeeded");
  } finally {
    await scenario.close();
  }
});

it("reports a report write that fails after commit as a succeeded transaction", async () => {
  const mock = new MockTransport();
  const transport: Transport = {
    async request(method, params, control) {
      // Replace the report with a directory, so the receipt cannot be saved.
      if (method === "getTransactionReceipt") {
        await rm(join(root, "run", "report.json"));
        await mkdir(join(root, "run", "report.json"));
      }
      return (await mock.request(method, params, control)) as never;
    },
  };
  const scenario = await createScenario(config(transport));
  try {
    const failure = await scenario
      .actor("alice")
      .call([call])
      .catch((error: unknown) => error);
    // The report stays broken, so the final report write fails too.
    expect(failure).toBeInstanceOf(AggregateError);
    const [operation] = (failure as AggregateError).errors;
    expect(isThruputError(operation, "testkitPersistenceFailed")).toBe(true);
    // The transaction committed; only the report write failed.
    expect(operation).toMatchObject({
      transaction: {
        outcome: "succeeded",
        reason: "persistenceFailed",
        receipt: expect.anything(),
        submission: expect.anything(),
      },
    });
    expect(scenario.run.report().attempts[0]!.outcome).toBe("succeeded");
  } finally {
    await scenario.close();
  }
});

it("records faucet funding with its hash and reconciles it without another request", async () => {
  const mock = new MockTransport();
  const request = vi.spyOn(mock, "request");
  const scenario = await createScenario(config(mock));
  try {
    const result = await scenario.run.step("fund-alice", () =>
      scenario.actor("alice").fund(),
    );
    // Later reads must include the funding transaction.
    expect(scenario.confirmedHeight).toBe(result.blockHeight);
    const report = await inspectRun(join(root, "run"));
    expect(report.attempts).toEqual([
      expect.objectContaining({
        actor: "alice",
        operation: "fund",
        step: "fund-alice",
        intent: { recipient: report.actors.alice },
        state: "committed",
        outcome: "succeeded",
        transactionHash: toBase58(result.transactionHash),
      }),
    ]);
    const faucetCalls = () =>
      request.mock.calls.filter(
        ([method]) => method === "faucet_requestAirdrop",
      ).length;
    expect(faucetCalls()).toBe(1);
    const reconciled = await reconcileRun(join(root, "run"), scenario.client);
    expect(reconciled.observations[0]).toMatchObject({
      transactionHash: toBase58(result.transactionHash),
      outcome: "succeeded",
    });
    // Reconciliation reads the original hash; it never calls the faucet again.
    expect(
      request.mock.calls.some(
        ([method, params]) =>
          method === "getTransactionStatus" &&
          JSON.stringify(params).includes(toBase58(result.transactionHash)),
      ),
    ).toBe(true);
    expect(faucetCalls()).toBe(1);
  } finally {
    await scenario.close();
  }
});

it("keeps the hash of an uncertain faucet request", async () => {
  const mock = new MockTransport();
  const transport: Transport = {
    async request(method, params, control) {
      const value = await mock.request(method, params, control);
      // The faucet accepts the request, but its receipt cannot be observed.
      if (method === "faucet_requestAirdrop") {
        const { recipient, rawAmount, transactionHash } = value as Record<
          string,
          string
        >;
        return {
          attemptStatus: "pending",
          recipient,
          rawAmount,
          retryAfterSeconds: "1",
          transactionHash,
        } as never;
      }
      if (method === "getTransactionReceipt") throw new Error("lost receipt");
      return value as never;
    },
  };
  const scenario = await createScenario(config(transport));
  try {
    await expect(
      scenario.run.step("fund-alice", () =>
        scenario.actor("alice").fund({ timeoutMs: 1_000 }),
      ),
    ).rejects.toMatchObject({
      code: "fundingStopped",
      transaction: { outcome: "unknown" },
    });
    const attempt = (await inspectRun(join(root, "run"))).attempts[0]!;
    expect(attempt).toMatchObject({
      operation: "fund",
      stopped: true,
      outcome: "unknown",
    });
    expect(attempt.transactionHash).toBeTruthy();
  } finally {
    await scenario.close();
  }
});

it("rejects funding on a network without a faucet", async () => {
  const cluster = { ...localnet(), capabilities: [] as const };
  const scenario = await createScenario({
    ...config(),
    network: { cluster, transport: new MockTransport() },
  });
  try {
    // The type hides fund here; a widened cluster still reaches the runtime check.
    const actor = scenario.actor("alice") as unknown as ActorFundOperations;
    await expect(actor.fund()).rejects.toThrow("no faucet");
  } finally {
    await scenario.close();
  }
});
