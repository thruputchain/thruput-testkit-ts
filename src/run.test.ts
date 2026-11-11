import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPubkeyAccount,
  Ed25519Signer,
  localnet,
  MockTransport,
  gasAmount,
  type Transport,
  type SubmissionEvidence,
} from "@thruputchain/client";
import { Counter } from "../tests/fixtures/counter.js";
import { createScenario, inspectRun, reconcileRun } from "./index.js";

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
    ).rejects.toMatchObject({ phase: "submission" });
    const before = await inspectRun(join(root, "run"));
    expect(before.steps[0]!.state).toBe("failed");
    expect(before.attempts[0]!.state).toBe("signed");
    const result = await reconcileRun(join(root, "run"), scenario.client);
    expect(result.observations[0]!.receipt).not.toBeNull();
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

it("keeps unsigned intent and signed-but-undispatched attempts unresolved", async () => {
  const scenario = await createScenario({
    ...config(),
    onSigned: () => {
      throw new Error("secret must not reach report");
    },
  });
  try {
    await expect(scenario.actor("alice").submit([call])).rejects.toMatchObject({
      phase: "beforeSubmission",
    });
    const result = await reconcileRun(join(root, "run"), scenario.client);
    expect(result.observations[0]!.receipt).toBeNull();
    expect(result.observations[0]!.status).toEqual({ status: "unknown" });
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
