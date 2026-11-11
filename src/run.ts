import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  bytesEqual,
  createSubmissionEvidence,
  fixedFromBase58,
  toBase58,
  type Cluster,
  type ConnectedThruputClient,
  type SubmissionEvidence,
  type TransactionReceipt,
  type TransactionStatus,
} from "@thruputchain/client";
import type { ActorOperations } from "./operations.js";

export type ReportValue =
  | null
  | boolean
  | number
  | string
  | ReportValue[]
  | { [key: string]: ReportValue };
/** Public JSON encoding: bigint decimal strings and bytes as 0x-prefixed hex. */
export function reportValue(value: unknown): ReportValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array)
    return `0x${Buffer.from(value).toString("hex")}`;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(reportValue);
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, reportValue(entry)]),
    );
  throw new TypeError("Value cannot be encoded in a run report");
}
export interface RunAttempt {
  id: string;
  actor: string;
  operation: string;
  step?: string;
  intent: ReportValue;
  /** Signed is unresolved: it does not prove dispatch, admission, or execution. */
  state: "intent" | "signed" | "committed";
  transactionHash?: string;
  receipt?: ReportValue;
  stopped?: boolean;
}
export interface RunReport {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  networkHash: string;
  actors: Record<string, string>;
  steps: { name: string; state: "running" | "completed" | "failed" }[];
  attempts: RunAttempt[];
}
export interface ScenarioRun {
  readonly id: string;
  readonly directory?: string;
  /** Public snapshot. Contains no signer objects or signed transaction bytes. */
  report(): RunReport;
  /** Names are unique within a run. Results pass through without being persisted. */
  step<T>(name: string, action: () => Promise<T>): Promise<T>;
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

async function atomicJson(
  directory: string,
  filename: string,
  value: unknown,
  mode: number,
): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", mode);
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, filename));
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Internal recorder. All writes are ordered within one exclusively created run. */
export async function createRun(
  networkHash: Uint8Array,
  actors: Record<string, string>,
  requestedDirectory?: string,
) {
  if (requestedDirectory !== undefined && process.platform !== "linux")
    throw new Error("Durable run directories currently require Linux");
  const directory =
    requestedDirectory === undefined ? undefined : resolve(requestedDirectory);
  const report: RunReport = {
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    networkHash: toBase58(networkHash),
    actors,
    steps: [],
    attempts: [],
  };
  if (directory) {
    await mkdir(directory, { mode: 0o700 });
    await mkdir(join(directory, "evidence"), { mode: 0o700 });
  }
  let writes: Promise<void> = Promise.resolve();
  const context = new AsyncLocalStorage<{
    step?: string;
    attempt?: RunAttempt;
  }>();
  const hashes = new Map<string, RunAttempt>();
  function persist(): Promise<void> {
    if (!directory) return Promise.resolve();
    const snapshot = structuredClone(report);
    const next = writes.then(() =>
      atomicJson(directory, "report.json", snapshot, 0o644),
    );
    // Preserve ordering after an error, while each caller still sees its own failure.
    writes = next.catch(() => {});
    return next;
  }
  await persist();
  async function begin(
    actor: string,
    operation: string,
    intent: ReportValue,
  ): Promise<RunAttempt> {
    const attempt: RunAttempt = {
      id: randomUUID(),
      actor,
      operation,
      intent,
      state: "intent",
      ...(context.getStore()?.step ? { step: context.getStore()!.step } : {}),
    };
    report.attempts.push(attempt);
    await persist();
    return attempt;
  }
  async function capture<T>(
    actor: string,
    operation: string,
    intent: ReportValue,
    action: () => Promise<T>,
  ): Promise<T> {
    const attempt = await begin(actor, operation, intent);
    return context.run({ ...context.getStore(), attempt }, async () => {
      try {
        return await action();
      } catch (error) {
        attempt.stopped = true;
        try {
          await persist();
        } catch (failure) {
          throw new AggregateError(
            [error, failure],
            "Operation and report persistence failed",
          );
        }
        throw error;
      }
    });
  }
  async function signed(
    actor: string,
    submission: SubmissionEvidence,
  ): Promise<void> {
    const active = context.getStore()?.attempt;
    const attempt =
      active?.state === "intent" ? active : await begin(actor, "wallet", null);
    try {
      if (directory)
        await atomicJson(
          join(directory, "evidence"),
          `${attempt.id}.json`,
          {
            runId: report.id,
            attemptId: attempt.id,
            networkHash: toBase58(submission.networkHash),
            transactionHash: toBase58(submission.transactionHash),
            signedTransaction: Buffer.from(
              submission.signedTransaction,
            ).toString("hex"),
          },
          0o600,
        );
      attempt.transactionHash = toBase58(submission.transactionHash);
      attempt.state = "signed";
      hashes.set(attempt.transactionHash, attempt);
      await persist();
    } catch (error) {
      throw new RunPersistenceError(error, submission);
    }
  }
  async function receipt(
    receipt: TransactionReceipt,
    submission: SubmissionEvidence,
  ): Promise<void> {
    const attempt = hashes.get(toBase58(submission.transactionHash));
    if (!attempt) return;
    attempt.state = "committed";
    attempt.receipt = reportValue(receipt);
    try {
      await persist();
    } catch (error) {
      throw new RunPersistenceError(error, submission, receipt);
    }
  }
  const run: ScenarioRun = Object.freeze({
    id: report.id,
    ...(directory ? { directory } : {}),
    report: () => structuredClone(report),
    async step<T>(name: string, action: () => Promise<T>) {
      if (
        !name ||
        name.trim() !== name ||
        report.steps.some((step) => step.name === name)
      )
        throw new Error(`Invalid or duplicate run step: ${name}`);
      const step: RunReport["steps"][number] = { name, state: "running" };
      report.steps.push(step);
      await persist();
      return context.run({ step: name }, async () => {
        let result: T;
        try {
          result = await action();
        } catch (error) {
          step.state = "failed";
          try {
            await persist();
          } catch (failure) {
            throw new AggregateError(
              [error, failure],
              "Step and report persistence failed",
            );
          }
          throw error;
        }
        step.state = "completed";
        await persist();
        return result;
      });
    },
  });
  function track(actor: string, operations: ActorOperations): ActorOperations {
    return {
      submit(calls, options) {
        return capture(
          actor,
          "submit",
          reportValue(
            calls.map((call) => ({
              method: call.method.name,
              address: toBase58(call.invocation.invoked_address),
            })),
          ),
          () => operations.submit(calls, options),
        );
      },
      call(calls, options) {
        return capture(
          actor,
          "call",
          reportValue(
            calls.map((call) => ({
              method: call.method.name,
              address: toBase58(call.invocation.invoked_address),
            })),
          ),
          () => operations.call(calls, options),
        );
      },
      deploy(deployment, options) {
        return capture(
          actor,
          "deploy",
          {
            address: toBase58(deployment.address),
            contractHash: toBase58(deployment.contractHash),
            deploymentNonce: toBase58(deployment.deploymentNonce),
            amount: reportValue(options.amount),
          },
          () => operations.deploy(deployment, options),
        );
      },
    };
  }
  return { run, signed, receipt, track, flush: () => writes };
}

/** Inspect the public report. This does not connect, resume, or submit a run. */
export async function inspectRun(directory: string): Promise<RunReport> {
  const value = JSON.parse(
    await readFile(join(directory, "report.json"), "utf8"),
  ) as RunReport;
  if (
    value?.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.networkHash !== "string" ||
    !Array.isArray(value.attempts) ||
    !Array.isArray(value.steps)
  )
    throw new Error("Invalid run report");
  fixedFromBase58(value.networkHash, 32);
  const ids = new Set<string>();
  for (const attempt of value.attempts) {
    if (
      !/^[0-9a-f-]{36}$/.test(attempt.id) ||
      ids.has(attempt.id) ||
      !["intent", "signed", "committed"].includes(attempt.state)
    )
      throw new Error("Invalid run attempt");
    ids.add(attempt.id);
  }
  return value;
}
export interface RunObservation {
  readonly attemptId: string;
  readonly transactionHash?: string;
  readonly status: TransactionStatus | null;
  readonly receipt: TransactionReceipt | null;
  /** An observation error never proves transaction failure. */
  readonly error?: unknown;
}
/** Query original attempts once, without writing files or submitting transactions. */
export async function reconcileRun(
  directory: string,
  client: Pick<
    ConnectedThruputClient<Cluster>,
    "getNetworkInfo" | "getTransactionStatus" | "getTransactionReceipt"
  >,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ report: RunReport; observations: RunObservation[] }> {
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647)
    throw new RangeError("timeoutMs must be a positive timer duration");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Run reconciliation timed out")),
    timeout,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    const report = await inspectRun(directory);
    const expected = fixedFromBase58(report.networkHash, 32);
    const network = await client.getNetworkInfo({}, { signal });
    if (!bytesEqual(expected, network.networkHash))
      throw new Error("Run network does not match the connected network");
    const observations: RunObservation[] = [];
    for (const attempt of report.attempts) {
      signal.throwIfAborted();
      let raw: string;
      try {
        raw = await readFile(
          join(directory, "evidence", `${attempt.id}.json`),
          "utf8",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        observations.push({
          attemptId: attempt.id,
          status: null,
          receipt: null,
          ...(attempt.state === "intent"
            ? {}
            : { error: new Error("Signed evidence is missing") }),
        });
        continue;
      }
      const saved = JSON.parse(raw);
      if (
        saved.runId !== report.id ||
        saved.attemptId !== attempt.id ||
        saved.networkHash !== report.networkHash ||
        typeof saved.signedTransaction !== "string" ||
        !/^(?:[a-f0-9]{2})+$/.test(saved.signedTransaction)
      )
        throw new Error("Invalid signed run evidence");
      const evidence = createSubmissionEvidence(
        Uint8Array.from(Buffer.from(saved.signedTransaction, "hex")),
        expected,
      );
      const hash = toBase58(evidence.transactionHash);
      if (
        hash !== saved.transactionHash ||
        (attempt.transactionHash !== undefined &&
          hash !== attempt.transactionHash)
      )
        throw new Error(
          "Run evidence hash does not match the recorded attempt",
        );
      // Evidence may be durable even if interruption prevented the public update.
      let status: TransactionStatus | null = null;
      let receipt: TransactionReceipt | null = null;
      try {
        status = await client.getTransactionStatus(
          { transactionHash: evidence.transactionHash },
          { signal },
        );
        receipt = await client.getTransactionReceipt(
          { transactionHash: evidence.transactionHash },
          { signal },
        );
        observations.push({
          attemptId: attempt.id,
          transactionHash: hash,
          status,
          receipt,
        });
      } catch (error) {
        observations.push({
          attemptId: attempt.id,
          transactionHash: hash,
          status,
          receipt,
          error,
        });
      }
    }
    return { report, observations };
  } finally {
    clearTimeout(timer);
  }
}
