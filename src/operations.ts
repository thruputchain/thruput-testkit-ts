import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  assertTransactionAdmission,
  assertTransactionSuccess,
  bytesEqual,
  ContractViewError,
  createDefaultWalletBatchInvocation,
  createSubmissionEvidence,
  decodeDeployment,
  decodeExecution,
  defaultWalletAdapter,
  gasAmount,
  NativeRpcError,
  serializeSignedTransaction,
  TransactionObservationError,
  TransactionReceiptObservationError,
  walletGasLimit,
  type CallResults,
  type Cluster,
  type ConnectedThruputClient,
  type ContractAddress,
  type ContractCall,
  type ContractDeployment,
  type ContractView,
  type ContractViewRequest,
  type ExecutionResult,
  type GasAmount,
  type PubkeyAccount,
  type SubmissionEvidence,
  type Transaction,
  type TransactionReceipt,
  type WaitForTransactionReceiptOptions,
} from "@thruputchain/client";
import type { WalletActions } from "@thruputchain/client/wallet";

/** Budgets, not estimates. Child call budgets and storage funding remain explicit. */
export const SCENARIO_GAS = Object.freeze({
  walletOverhead: gasAmount(500_000n),
  deployment: gasAmount(10_000_000n),
});

export type ObserveOptions = Omit<
  WaitForTransactionReceiptOptions,
  "expectedNetworkHash"
>;
export interface SubmitOptions {
  readonly gasLimit?: GasAmount;
  readonly expiryBlocks?: bigint;
  /** Bounds submission after signing; defaults to 30 seconds. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface CallOptions extends SubmitOptions {
  readonly wait?: ObserveOptions;
}
export interface DeployOptions extends Omit<CallOptions, "expiryBlocks"> {
  /** Exact raw native-token storage allocation. Zero explicitly skips funding. */
  readonly amount: bigint;
  /** Ordinary generated call to the prepared address, executed atomically. */
  readonly initializer?: ContractCall;
}
export interface SubmittedCalls<TCalls extends readonly ContractCall[]> {
  readonly submission: SubmissionEvidence;
  /** Read-only; can be called again after a timeout or cancellation. */
  wait(
    options?: ObserveOptions,
  ): Promise<ExecutionResult & { values: CallResults<TCalls> }>;
}
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
export interface ViewOptions {
  /** Additional dependency, combined with the scenario's confirmed height. */
  readonly minStateBlockHeight?: bigint;
  readonly timeoutMs?: number;
  readonly pollingIntervalMs?: number;
  readonly signal?: AbortSignal;
}
export interface ScenarioOperations {
  /** Highest known committed height, including failed executions and stopped waits. */
  readonly confirmedHeight: bigint;
  /** Observe original signed evidence without sending it again. */
  observe(
    submission: SubmissionEvidence,
    options?: ObserveOptions,
  ): Promise<ExecutionResult>;
  /** Wait for a snapshot that includes all previously observed scenario writes. */
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
  function reserve(): bigint {
    signal.throwIfAborted();
    if (nextNonce > 0xffffffffffffffffn)
      throw new Error("Scenario transaction nonce space is exhausted");
    return nextNonce++;
  }
  function scoped(other?: AbortSignal): AbortSignal {
    return other ? AbortSignal.any([signal, other]) : signal;
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
      if (
        error instanceof TransactionReceiptObservationError &&
        error.knownCommitment &&
        error.knownCommitment.blockHeight > confirmedHeight
      ) {
        confirmedHeight = error.knownCommitment.blockHeight;
      }
      throw new TransactionObservationError(
        submission,
        error,
        undefined,
        error instanceof TransactionReceiptObservationError
          ? error.knownCommitment
          : options.knownCommitment,
        "observation",
      );
    }
    if (receipt.blockHeight > confirmedHeight)
      confirmedHeight = receipt.blockHeight;
    await onReceipt?.(receipt, submission);
    assertTransactionSuccess(receipt, submission);
    return { transactionHash: submission.transactionHash, receipt, submission };
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
            if (outcome.kind !== "return") throw new ContractViewError(outcome);
            return {
              value: outcome.value,
              stateBlockHeight: outcome.stateBlockHeight,
              gasUsed: outcome.gasUsed,
              events: outcome.events,
            };
          } catch (error) {
            control.throwIfAborted();
            if (
              !(error instanceof NativeRpcError) ||
              error.decoded.classification !== "known" ||
              error.decoded.data.kind !== "stateHeightUnavailable"
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
  ): ActorOperations {
    function waiting(options: CallOptions): ObserveOptions {
      const wait = options.wait ?? {};
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
    async function send(
      prepare: () => Promise<Transaction>,
      nonce: bigint,
      options: SubmitOptions,
    ): Promise<SubmissionEvidence> {
      const control = scoped(options.signal);
      const timeout = duration(options.timeoutMs ?? 30_000, "timeoutMs");
      control.throwIfAborted();
      client.requireMethods(["getChainTip", "sendTransaction"]);
      const prepared = await prepare();
      control.throwIfAborted();
      const signed = await wallet.signTransaction({
        ...prepared,
        uniquifier: { ...prepared.uniquifier, nonce },
      });
      const evidence = createSubmissionEvidence(
        serializeSignedTransaction(signed),
        client.network.networkHash,
      );
      try {
        await onSigned?.(evidence);
        control.throwIfAborted();
      } catch (error) {
        throw new TransactionObservationError(
          evidence,
          error,
          undefined,
          undefined,
          "beforeSubmission",
        );
      }
      const deadline = new AbortController();
      const timer = setTimeout(
        () =>
          deadline.abort(new Error(`Submission timed out after ${timeout}ms`)),
        timeout,
      );
      try {
        const response = await client.sendTransaction(
          { signedTransaction: evidence.signedTransaction },
          { signal: AbortSignal.any([control, deadline.signal]) },
        );
        assertTransactionAdmission(response);
        return evidence;
      } catch (error) {
        throw new TransactionObservationError(
          evidence,
          error,
          undefined,
          undefined,
          "submission",
        );
      } finally {
        clearTimeout(timer);
      }
    }
    async function submit<const TCalls extends readonly ContractCall[]>(
      calls: TCalls,
      options: SubmitOptions = {},
    ): Promise<SubmittedCalls<TCalls>> {
      options.signal?.throwIfAborted();
      const nonce = reserve();
      const retained = [...calls] as unknown as TCalls;
      if (!retained.length)
        throw new RangeError("Execution requires at least one call");
      const invocations = retained.map((call) => call.invocation);
      const gasLimit =
        options.gasLimit ??
        walletGasLimit(invocations, SCENARIO_GAS.walletOverhead);
      const invocation = createDefaultWalletBatchInvocation(
        wallet.account.address,
        { invocations, gasLimit },
      );
      const submission = await send(
        () =>
          wallet.prepareTransaction({
            invocation,
            nonce,
            expiryBlocks: options.expiryBlocks,
          }),
        nonce,
        options,
      );
      return Object.freeze({
        submission,
        async wait(wait?: ObserveOptions) {
          const result = await observe(submission, wait);
          return {
            ...result,
            values: decodeExecution(
              result.receipt,
              retained,
              defaultWalletAdapter,
              submission,
            ),
          };
        },
      });
    }
    return {
      submit,
      async call(calls, options = {}) {
        const wait = waiting(options);
        client.requireMethods([
          "getNetworkInfo",
          "getTransactionReceipt",
          "getTransactionStatus",
        ]);
        const pending = await submit(calls, {
          ...options,
          signal: wait.signal,
        });
        return pending.wait(wait);
      },
      async deploy(deployment, options) {
        const wait = waiting(options);
        client.requireMethods([
          "getNetworkInfo",
          "getTransactionReceipt",
          "getTransactionStatus",
        ]);
        options.signal?.throwIfAborted();
        const nonce = reserve();
        const address = deployment.address.slice() as ContractAddress;
        const submission = await send(
          () =>
            wallet.prepareDeployment(deployment, {
              amount: options.amount,
              gasLimit: options.gasLimit ?? SCENARIO_GAS.deployment,
              initializer: options.initializer?.invocation,
            }),
          nonce,
          { ...options, signal: wait.signal },
        );
        const result = await observe(submission, wait);
        return {
          ...result,
          address: decodeDeployment(
            result.receipt,
            { ...deployment, address },
            defaultWalletAdapter,
            submission,
          ),
        };
      },
    };
  }
  return { reads, actor };
}
