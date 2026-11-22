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
import type { ActorFundOperations, ActorOperations } from "./operations.js";
import {
  errorOutcome,
  receiptOutcome,
  type OutcomeSummary,
  type RunOutcome,
} from "./outcomes.js";

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

/** Client errors, plus testkit's persistence error, which can follow commitment. */
export function summarizeError(error: unknown): OutcomeSummary {
  if (!(error instanceof RunPersistenceError)) return errorOutcome(error);
  if (error.receipt)
    return {
      outcome: receiptOutcome(error.receipt),
      transactionHash: error.receipt.transactionHash,
    };
  return error.submission
    ? { outcome: "unknown", transactionHash: error.submission.transactionHash }
    : { outcome: "unknown" };
}

/** JSON report value. Bigints use decimal strings; receipt bytes use 0x-prefixed hex. */
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
/** One recorded operation. Commitment does not by itself imply successful execution. */
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
  /** The operation threw. Its transaction can still have committed. */
  stopped?: boolean;
  /** Execution summary. Absent in reports written by earlier versions. */
  outcome?: RunOutcome;
}

/** Optional caller-supplied public context. Never include signing material. */
export interface RunStepOptions {
  metadata?: { [key: string]: ReportValue };
}
/** Public run snapshot, with base58 identities and no signer secrets or signed bytes. */
export interface RunReport {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  networkHash: string;
  actors: Record<string, string>;
  steps: {
    name: string;
    state: "running" | "completed" | "failed";
    metadata?: { [key: string]: ReportValue };
  }[];
  attempts: RunAttempt[];
}
/**
 * Named workflow steps and public reports.
 *
 * A durable run writes intent and restricted signed evidence before dispatch.
 * Its directory uses mode 0700 and evidence files use 0600. Share the public
 * report rather than the whole directory. `actor.fund` records faucet requests
 * with their transaction hash. The run does not sign them, so they have no
 * signed evidence, and reconciliation observes them by hash.
 */
export interface ScenarioRun {
  readonly id: string;
  readonly directory?: string;
  /** Public snapshot. Contains no signer objects or signed transaction bytes. */
  report(): RunReport;
  /**
   * Names are unique within a run. Results pass through without being persisted.
   * Await all work in the callback. A failed step does not prove transaction failure.
   * Optional metadata is copied and saved before the callback. Use plain JSON
   * values; metadata is public and must not contain secrets. A step can contain
   * zero, one, or several transaction attempts, each with its own outcome.
   *
   * @example
   * ```ts
   * const result = await scenario.run.step("deploy-counter",
   *   () => alice.deploy(deployment, { amount: 50_000_000n }),
   *   { metadata: { label: "Deploy counter", environment: "local" } },
   * );
   * console.log(result.address);
   * ```
   */
  step<T>(
    name: string,
    action: () => Promise<T>,
    options?: RunStepOptions,
  ): Promise<T>;
}
function copyMetadata(metadata: NonNullable<RunStepOptions["metadata"]>) {
  const ancestors = new Set<object>();
  function validate(value: unknown): void {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (
      typeof value !== "object" ||
      value === null ||
      ancestors.has(value) ||
      (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    ) {
      throw new TypeError("Step metadata must contain only JSON values");
    }
    ancestors.add(value);
    for (const entry of Object.values(value)) validate(entry);
    ancestors.delete(value);
  }
  validate(metadata);
  return structuredClone(metadata);
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
      outcome: "unknown",
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
        const summary = summarizeError(error);
        if (attempt.outcome === "unknown") attempt.outcome = summary.outcome;
        if (summary.transactionHash)
          attempt.transactionHash = toBase58(summary.transactionHash);
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
  async function funded(transactionHash: Uint8Array): Promise<void> {
    const attempt = context.getStore()?.attempt;
    if (!attempt) return;
    attempt.state = "committed";
    attempt.transactionHash = toBase58(transactionHash);
    attempt.outcome = "succeeded";
    try {
      await persist();
    } catch (error) {
      throw new RunPersistenceError(error);
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
    attempt.outcome = receiptOutcome(receipt);
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
    async step<T>(
      name: string,
      action: () => Promise<T>,
      options?: RunStepOptions,
    ) {
      if (
        !name ||
        name.trim() !== name ||
        report.steps.some((step) => step.name === name)
      )
        throw new Error(`Invalid or duplicate run step: ${name}`);
      const step: RunReport["steps"][number] = {
        name,
        state: "running",
        ...(options?.metadata === undefined
          ? {}
          : { metadata: copyMetadata(options.metadata) }),
      };
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
  function track(
    actor: string,
    operations: ActorOperations & ActorFundOperations,
  ): ActorOperations & ActorFundOperations {
    return {
      fund(options) {
        return capture(
          actor,
          "fund",
          { recipient: report.actors[actor] ?? null },
          async () => {
            const result = await operations.fund(options);
            await funded(result.transactionHash);
            return result;
          },
        );
      },
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
/** Current read-only observation of one attempt; missing receipts remain unresolved. */
export interface RunObservation {
  readonly attemptId: string;
  readonly transactionHash?: string;
  readonly status: TransactionStatus | null;
  readonly receipt: TransactionReceipt | null;
  /** Latest known execution outcome; the original report remains unchanged. */
  readonly outcome: RunOutcome;
  /** An observation error never proves transaction failure. */
  readonly error?: unknown;
}
/**
 * Query original attempts once, without writing files or submitting transactions.
 *
 * Checks network identity and validates saved signed evidence, including evidence
 * saved just before an interruption prevented the public report update. The
 * deadline defaults to 30 seconds. Individual read errors are retained in the
 * observations; invalid reports, corrupt evidence, and network mismatches throw.
 * A missing receipt or an unknown status is not proof that the transaction failed.
 *
 * @example
 * With a connected SDK client for the original network:
 * ```ts
 * import { reconcileRun } from "@thruputchain/testkit";
 *
 * const result = await reconcileRun("./runs/deployment", client);
 * for (const observation of result.observations) {
 *   console.log(observation.transactionHash, observation.outcome);
 * }
 * ```
 */
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
    // Read-only: status and receipt for an original hash. Nothing is submitted.
    async function observe(
      attempt: RunAttempt,
      transactionHash: Uint8Array,
    ): Promise<RunObservation> {
      const hash = toBase58(transactionHash);
      let status: TransactionStatus | null = null;
      let receipt: TransactionReceipt | null = null;
      try {
        status = await client.getTransactionStatus(
          { transactionHash },
          { signal },
        );
        receipt = await client.getTransactionReceipt(
          { transactionHash },
          { signal },
        );
        return {
          attemptId: attempt.id,
          transactionHash: hash,
          status,
          receipt,
          outcome: receipt
            ? receiptOutcome(receipt)
            : (attempt.outcome ?? "unknown"),
        };
      } catch (error) {
        return {
          attemptId: attempt.id,
          transactionHash: hash,
          status,
          receipt,
          error,
          outcome: attempt.outcome ?? "unknown",
        };
      }
    }
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
        // Faucet transactions are not signed by the run, so only their hash exists.
        if (attempt.operation === "fund" && attempt.transactionHash) {
          observations.push(
            await observe(
              attempt,
              fixedFromBase58(attempt.transactionHash, 32),
            ),
          );
          continue;
        }
        observations.push({
          attemptId: attempt.id,
          status: null,
          receipt: null,
          outcome: attempt.outcome ?? "unknown",
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
      observations.push(await observe(attempt, evidence.transactionHash));
    }
    return { report, observations };
  } finally {
    clearTimeout(timer);
  }
}
