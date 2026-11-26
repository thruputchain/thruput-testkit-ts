import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  assertTransactionAdmission,
  assertTransactionSuccess,
  bytesEqual,
  createDefaultWalletBatchInvocation,
  createSubmissionEvidence,
  decodeDeployment,
  decodeExecution,
  defaultWalletAdapter,
  gasAmount,
  isThruputError,
  sendTransaction,
  serializeSignedTransaction,
  submitAndObserve,
  ThruputError,
  toBase58,
  walletGasLimit,
  type AirdropActions,
  type AirdropSucceeded,
  type CallResults,
  type Cluster,
  type ConnectedThruputClient,
  type ContractAddress,
  type ContractCall,
  type PrepareTransactionRequest,
  type ContractDeployment,
  type ContractView,
  type ContractViewRequest,
  type ExecutionResult,
  type GasAmount,
  type PubkeyAccount,
  type SignedTransaction,
  type SubmissionEvidence,
  type Transaction,
  type TransactionReason,
  type TransactionReceipt,
  type WaitForTransactionReceiptOptions,
} from "@thruputchain/client";
import type { WalletActions } from "@thruputchain/client/wallet";

/** Budgets, not estimates. Child call budgets and storage funding remain explicit. */
export const SCENARIO_GAS = Object.freeze({
  walletOverhead: gasAmount(500_000n),
  deployment: gasAmount(10_000_000n),
});

/** SDK receipt-wait controls. The scenario supplies the expected network hash. */
export type ObserveOptions = Omit<
  WaitForTransactionReceiptOptions,
  "expectedNetworkHash"
>;
/** Controls for preparing and sending one transaction. Writes are never retried. */
export interface SubmitOptions {
  /** Root budget. Defaults to child budgets plus SCENARIO_GAS.walletOverhead. */
  readonly gasLimit?: GasAmount;
  /** Optional transaction expiry window, in blocks. */
  readonly expiryBlocks?: bigint;
  /**
   * Contract code attached to the transaction, so a factory call can deploy it.
   * The node keeps attached code only when the transaction deploys an instance.
   */
  readonly contractsToDeploy?: PrepareTransactionRequest["contractsToDeploy"];
  /**
   * Bounds the send request after signing; defaults to 30 seconds. `submit`
   * then stops with outcome `unknown`. `call` and `deploy` keep observing
   * the hash until `wait.timeoutMs`.
   */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
/**
 * Send controls, plus wait controls that bound sending and observation
 * together. A new transaction has no known commitment.
 */
export interface CallOptions extends SubmitOptions {
  readonly wait?: Omit<ObserveOptions, "knownCommitment">;
}
/** Atomic deployment controls. The default root budget is SCENARIO_GAS.deployment. */
export interface DeployOptions extends Omit<
  CallOptions,
  "expiryBlocks" | "contractsToDeploy"
> {
  /** Exact raw native-token storage allocation. Zero explicitly skips funding. */
  readonly amount: bigint;
  /** Ordinary generated call to the prepared address, executed atomically. */
  readonly initializer?: ContractCall;
}
/** Original signed evidence and repeatable, read-only receipt observation. */
export interface SubmittedCalls<TCalls extends readonly ContractCall[]> {
  readonly submission: SubmissionEvidence;
  /** Read-only; can be called again after a timeout or cancellation. */
  wait(
    options?: ObserveOptions,
  ): Promise<ExecutionResult & { values: CallResults<TCalls> }>;
}
/** Faucet request controls. The faucet chooses the amount. */
export interface FundOptions {
  /** Covers the request and its receipt; defaults to 60 seconds. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Identifies the faucet request, 1 to 32 bytes. The run report saves the
   * nonce before the request. A repeated request with the same nonce reconciles
   * the attempt; a new nonce can fund twice. Generated when omitted.
   */
  readonly clientNonce?: Uint8Array;
}
/** Faucet funding, available on networks with the airdrop capability. */
export interface ActorFundOperations {
  /**
   * Request faucet funds for this actor once, and wait for successful execution.
   * The run report records the request's nonce first, then its hash. An
   * uncertain request is never repeated: a `fundingStopped` error keeps the
   * known hash in `transaction`.
   */
  fund(options?: FundOptions): Promise<AirdropSucceeded>;
}
/** Typed helpers over SDK transactions and generated contract descriptors. */
export interface ActorOperations {
  /** Submit once without waiting for a receipt. No write is retried. */
  submit<const TCalls extends readonly ContractCall[]>(
    calls: TCalls,
    options?: SubmitOptions,
  ): Promise<SubmittedCalls<TCalls>>;
  /** Submit an atomic batch and decode its ordered results. Events remain in receipt. */
  call<const TCalls extends readonly ContractCall[]>(
    calls: TCalls,
    options?: CallOptions,
  ): Promise<ExecutionResult & { values: CallResults<TCalls> }>;
  /** Fund, deploy, and optionally initialize in one transaction. */
  deploy(
    deployment: ContractDeployment,
    options: DeployOptions,
  ): Promise<ExecutionResult & { address: ContractAddress }>;
}
/** Controls for waiting until a contract read includes its confirmed dependencies. */
export interface ViewOptions {
  /** Additional dependency, combined with the scenario's confirmed height. */
  readonly minStateBlockHeight?: bigint;
  /** Overall read deadline. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /** Delay between stale-snapshot reads. Defaults to 50 milliseconds. */
  readonly pollingIntervalMs?: number;
  readonly signal?: AbortSignal;
}
/** Shared receipt observation and confirmed-height reads across scenario actors. */
export interface ScenarioOperations {
  /** Highest known committed height, including failed executions and stopped waits. */
  readonly confirmedHeight: bigint;
  /**
   * Observe original signed evidence without sending it again.
   * A failure is a `ThruputError` whose `transaction` keeps this evidence in
   * `submission`. Execution errors keep their receipts.
   * Cancellation cannot undo a transaction that was already sent.
   */
  observe(
    submission: SubmissionEvidence,
    options?: ObserveOptions,
  ): Promise<ExecutionResult>;
  /**
   * Wait for a snapshot that includes all previously observed scenario writes.
   * Captures the required height when called; it does not wait for concurrent
   * writes that have not been observed. For direct SDK writes, supply their
   * receipt height through `minStateBlockHeight`. Only stale-snapshot errors retry.
   */
  view<TResult, TException>(
    request: ContractViewRequest<TResult, TException>,
    options?: ViewOptions,
  ): Promise<ContractView<TResult>>;
}

function duration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)
    throw new RangeError(`${name} must be a positive timer duration`);
  return value;
}

/** One reservation and dependency scope shared by all named actors. */
export function createOperations(
  client: ConnectedThruputClient<Cluster>,
  signal: AbortSignal,
  onReceipt?: (
    receipt: TransactionReceipt,
    submission: SubmissionEvidence,
  ) => Promise<void>,
) {
  let nextNonce = randomBytes(8).readBigUInt64BE();
  let confirmedHeight = 0n;
  function confirm(height: bigint) {
    if (height > confirmedHeight) confirmedHeight = height;
  }
  function reserve(): bigint {
    signal.throwIfAborted();
    if (nextNonce > 0xffffffffffffffffn)
      throw new Error("Scenario transaction nonce space is exhausted");
    return nextNonce++;
  }
  function scoped(other?: AbortSignal): AbortSignal {
    return other ? AbortSignal.any([signal, other]) : signal;
  }
  // Later reads must include a transaction that is known to have committed.
  function confirmKnown(error: unknown) {
    const known =
      isThruputError(error, "transactionOutcomeUnknown") ||
      isThruputError(error, "fundingStopped")
        ? error.context.knownCommitment
        : undefined;
    if (known) confirm(known.blockHeight);
  }
  /** Record the receipt, then require successful execution. */
  async function settle(
    receipt: TransactionReceipt,
    submission: SubmissionEvidence,
  ): Promise<ExecutionResult> {
    confirm(receipt.blockHeight);
    await onReceipt?.(receipt, submission);
    assertTransactionSuccess(receipt, submission);
    return { transactionHash: submission.transactionHash, receipt, submission };
  }
  async function observe(
    evidence: SubmissionEvidence,
    options: ObserveOptions = {},
  ): Promise<ExecutionResult> {
    const submission = createSubmissionEvidence(
      evidence.signedTransaction,
      evidence.networkHash,
    );
    if (
      !bytesEqual(submission.networkHash, client.network.networkHash) ||
      !bytesEqual(submission.transactionHash, evidence.transactionHash)
    )
      throw new Error(
        "Submission evidence does not match this network or transaction hash",
      );
    let receipt;
    try {
      receipt = await client.waitForTransactionReceipt(
        submission.transactionHash,
        {
          ...options,
          signal: scoped(options.signal),
          expectedNetworkHash: submission.networkHash,
        },
      );
    } catch (error) {
      confirmKnown(error);
      throw withSubmission(error, submission);
    }
    return settle(receipt, submission);
  }

  const reads: ScenarioOperations = {
    get confirmedHeight() {
      return confirmedHeight;
    },
    observe,
    async view(request, options = {}) {
      const retained = {
        ...request,
        request: structuredClone(request.request),
      };
      const minimum = options.minStateBlockHeight ?? 0n;
      if (
        typeof minimum !== "bigint" ||
        minimum < 0n ||
        minimum > 0x7fffffffffffffffn
      )
        throw new RangeError(
          "minStateBlockHeight must be a nonnegative signed-64-bit height",
        );
      const height = minimum > confirmedHeight ? minimum : confirmedHeight;
      const timeout = duration(options.timeoutMs ?? 30_000, "timeoutMs");
      const interval = duration(
        options.pollingIntervalMs ?? 50,
        "pollingIntervalMs",
      );
      const deadline = new AbortController();
      const control = AbortSignal.any([
        scoped(options.signal),
        deadline.signal,
      ]);
      let lastError: unknown;
      const timer = setTimeout(
        () =>
          deadline.abort(
            new Error(
              `View did not reach confirmed height ${height} within ${timeout}ms`,
              { cause: lastError },
            ),
          ),
        timeout,
      );
      try {
        while (true) {
          control.throwIfAborted();
          try {
            const response = await client.readViews(
              { calls: [retained] as const, minStateBlockHeight: height },
              { signal: control },
            );
            const outcome = response.results[0];
            if (outcome.kind !== "return")
              throw new ThruputError(
                "contractViewFailed",
                `Contract view ${request.method.name} did not return`,
                {
                  context: {
                    method: request.method.name,
                    entrypoint: retained.request.entrypoint,
                    outcome,
                  },
                },
              );
            return {
              value: outcome.value,
              stateBlockHeight: outcome.stateBlockHeight,
              gasUsed: outcome.gasUsed,
              events: outcome.events,
            };
          } catch (error) {
            control.throwIfAborted();
            if (
              !isThruputError(error, "nativeRpcError") ||
              error.context.kind !== "stateHeightUnavailable"
            )
              throw error;
            lastError = error;
          }
          await sleep(interval, undefined, { signal: control });
        }
      } catch (error) {
        control.throwIfAborted();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };

  function actor(
    wallet: WalletActions<PubkeyAccount>,
    onSigned?: (evidence: SubmissionEvidence) => void | Promise<void>,
  ): ActorOperations & ActorFundOperations {
    function waiting(
      options: CallOptions,
    ): ObserveOptions & { signal: AbortSignal } {
      const wait = options.wait ?? {};
      // Fail before signing, as the client does.
      if ((wait as ObserveOptions).knownCommitment !== undefined)
        throw new TypeError(
          "knownCommitment applies only when observing an existing transaction",
        );
      if (wait.timeoutMs !== undefined)
        duration(wait.timeoutMs, "wait.timeoutMs");
      if (wait.pollingIntervalMs !== undefined)
        duration(wait.pollingIntervalMs, "wait.pollingIntervalMs");
      const control = wait.signal
        ? AbortSignal.any([scoped(options.signal), wait.signal])
        : scoped(options.signal);
      control.throwIfAborted();
      return { ...wait, signal: control };
    }
    /** Prepare, sign, and save evidence. Nothing is sent yet. */
    async function sign(
      prepare: (nonce: bigint) => Promise<Transaction>,
      control: AbortSignal,
    ): Promise<{ signed: SignedTransaction; evidence: SubmissionEvidence }> {
      control.throwIfAborted();
      client.requireMethods(["getChainTip", "sendTransaction"]);
      const nonce = reserve();
      const prepared = await prepare(nonce);
      control.throwIfAborted();
      const signed = await wallet.signTransaction({
        ...prepared,
        uniquifier: { ...prepared.uniquifier, nonce },
      });
      const evidence = createSubmissionEvidence(
        serializeSignedTransaction(signed),
        client.network.networkHash,
      );
      // A failed hook stops before dispatch. Check cancellation after the hook,
      // so a cancellation while evidence is saved also stops before dispatch.
      try {
        await onSigned?.(evidence);
      } catch (cause) {
        throw notSubmitted(evidence, "persistenceFailed", cause);
      }
      if (control.aborted)
        throw notSubmitted(evidence, "cancelled", control.reason);
      return { signed, evidence };
    }
    /** Send once and observe through the client, which never resends. */
    async function execute(
      prepare: (nonce: bigint) => Promise<Transaction>,
      options: SubmitOptions,
      wait: ObserveOptions & { signal: AbortSignal },
    ): Promise<ExecutionResult> {
      const timeout = duration(options.timeoutMs ?? 30_000, "timeoutMs");
      client.requireMethods([
        "getNetworkInfo",
        "getTransactionReceipt",
        "getTransactionStatus",
      ]);
      const { evidence } = await sign(prepare, wait.signal);
      let result: ExecutionResult;
      try {
        result = await submitAndObserve(
          client,
          evidence,
          async (dispatchSignal) => {
            const response = await client.sendTransaction(
              { signedTransaction: evidence.signedTransaction },
              {
                signal: AbortSignal.any([
                  dispatchSignal,
                  AbortSignal.timeout(timeout),
                ]),
              },
            );
            assertTransactionAdmission(response, evidence);
          },
          wait,
        );
      } catch (error) {
        confirmKnown(error);
        throw error;
      }
      return settle(result.receipt, evidence);
    }
    /** One DefaultWallet batch for the calls, prepared with a reserved nonce. */
    function batch(calls: readonly ContractCall[], options: SubmitOptions) {
      if (!calls.length)
        throw new RangeError("Execution requires at least one call");
      const invocations = calls.map((call) => call.invocation);
      const gasLimit =
        options.gasLimit ??
        walletGasLimit(invocations, SCENARIO_GAS.walletOverhead);
      const invocation = createDefaultWalletBatchInvocation(
        wallet.account.address,
        { invocations, gasLimit },
      );
      return (nonce: bigint) =>
        wallet.prepareTransaction({
          invocation,
          nonce,
          expiryBlocks: options.expiryBlocks,
          contractsToDeploy: options.contractsToDeploy,
        });
    }
    function decoded<const TCalls extends readonly ContractCall[]>(
      result: ExecutionResult,
      calls: TCalls,
    ) {
      return {
        ...result,
        values: decodeExecution(
          result.receipt,
          calls,
          defaultWalletAdapter,
          result.submission,
        ),
      };
    }
    async function submit<const TCalls extends readonly ContractCall[]>(
      calls: TCalls,
      options: SubmitOptions = {},
    ): Promise<SubmittedCalls<TCalls>> {
      const retained = [...calls] as unknown as TCalls;
      const control = scoped(options.signal);
      const timeout = duration(options.timeoutMs ?? 30_000, "timeoutMs");
      const prepare = batch(retained, options);
      const { signed, evidence: submission } = await sign(prepare, control);
      const deadline = AbortSignal.timeout(timeout);
      try {
        await sendTransaction(client, signed, {
          signal: AbortSignal.any([control, deadline]),
        });
      } catch (error) {
        // The client reports the deadline as a cancellation. Name it a timeout.
        const cancelled =
          isThruputError(error) && error.transaction?.reason === "cancelled";
        throw cancelled && deadline.aborted && !control.aborted
          ? withReason(error, "timeout")
          : error;
      }
      return Object.freeze({
        submission,
        async wait(wait?: ObserveOptions) {
          return decoded(await observe(submission, wait), retained);
        },
      });
    }
    return {
      async fund(options = {}) {
        const control = scoped(options.signal);
        control.throwIfAborted();
        if (!("requestAirdrop" in client))
          throw new Error(
            "Scenario network has no faucet. Use a cluster with the airdrop capability.",
          );
        const faucet = client as typeof client & AirdropActions;
        try {
          const result = await faucet.requestAirdrop({
            recipient: wallet.account.address,
            expectedNetworkHash: client.network.networkHash,
            signal: control,
            ...(options.clientNonce
              ? { clientNonce: options.clientNonce }
              : {}),
            ...(options.timeoutMs === undefined
              ? {}
              : { timeoutMs: duration(options.timeoutMs, "timeoutMs") }),
          });
          confirm(result.blockHeight);
          return result;
        } catch (error) {
          confirmKnown(error);
          throw error;
        }
      },
      submit,
      async call(calls, options = {}) {
        const retained = [...calls] as unknown as typeof calls;
        const wait = waiting(options);
        const result = await execute(batch(retained, options), options, wait);
        return decoded(result, retained);
      },
      async deploy(deployment, options) {
        const wait = waiting(options);
        const address = deployment.address.slice() as ContractAddress;
        const result = await execute(
          () =>
            wallet.prepareDeployment(deployment, {
              amount: options.amount,
              gasLimit: options.gasLimit ?? SCENARIO_GAS.deployment,
              initializer: options.initializer?.invocation,
            }),
          options,
          wait,
        );
        return {
          ...result,
          address: decodeDeployment(
            result.receipt,
            { ...deployment, address },
            defaultWalletAdapter,
            result.submission,
          ),
        };
      },
    };
  }
  return { reads, actor };
}

/** The signed transaction was not dispatched. Mirrors the client's wallet/transactionErrors.ts. */
function notSubmitted(
  submission: SubmissionEvidence,
  reason: TransactionReason,
  cause: unknown,
): ThruputError<"transactionNotSubmitted"> {
  return new ThruputError(
    "transactionNotSubmitted",
    `Transaction ${toBase58(submission.transactionHash)} was not submitted`,
    {
      cause,
      transaction: {
        hash: submission.transactionHash,
        outcome: "notSubmitted",
        reason,
        submission,
      },
    },
  );
}

/**
 * Mirrors the client's wallet/transactionErrors.ts, which does not export it.
 * Add the signed bytes to an observation error. Observation never proves that
 * a transaction did not commit, so any other error becomes `unknown`.
 */
function withSubmission(
  error: unknown,
  submission: SubmissionEvidence,
): ThruputError<"transactionOutcomeUnknown"> {
  if (isThruputError(error, "transactionOutcomeUnknown") && error.transaction)
    return new ThruputError("transactionOutcomeUnknown", error.message, {
      context: error.context,
      ...(error.cause === undefined ? {} : { cause: error.cause }),
      transaction: { ...error.transaction, submission },
    });
  return new ThruputError(
    "transactionOutcomeUnknown",
    `Could not observe transaction ${toBase58(submission.transactionHash)}`,
    {
      cause: error,
      transaction: {
        hash: submission.transactionHash,
        outcome: "unknown",
        reason: "observationFailed",
        submission,
      },
    },
  );
}

/** Replace the reason on an error's transaction facts, keeping everything else. */
function withReason(error: unknown, reason: TransactionReason): unknown {
  if (!isThruputError(error) || !error.transaction) return error;
  return new ThruputError(error.code, error.message, {
    context: error.context,
    ...(error.cause === undefined ? {} : { cause: error.cause }),
    transaction: { ...error.transaction, reason },
  });
}
