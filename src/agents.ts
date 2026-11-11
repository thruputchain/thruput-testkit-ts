import { createHmac } from "node:crypto";
import { serialize, deserialize } from "node:v8";
import type { Cluster } from "@thruputchain/client";
import type { Actor } from "./scenario.js";
import type { ScenarioOperations, ObserveOptions } from "./operations.js";

/** Repeatable inputs keyed by seed and actor name, independent of unrelated agents. */
export interface AgentRandom {
  /** Deterministic value in [0, 1). Not a cryptographic secret generator. */
  next(): number;
  /** Uniform integer from zero through maxExclusive - 1; maximum is a positive safe integer. */
  integer(maxExclusive: number): number;
  /** Generate up to 1,048,576 repeatable bytes. Do not use them as signing secrets. */
  bytes(length: number): Uint8Array;
}
/**
 * One agent's scoped actor, copied messages, and cooperative cancellation signal.
 * Await its work before returning. The context is cancelled when its callback
 * ends; helper reads and writes share the parent scenario's confirmed height.
 */
export interface AgentContext<
  TCluster extends Cluster,
  TName extends string,
  TMessage,
> {
  readonly name: TName;
  readonly actor: Actor<TCluster>;
  readonly signal: AbortSignal;
  readonly random: AgentRandom;
  /** Copies the payload. Shared memory and nonserializable values are rejected. */
  send(to: TName, value: TMessage): void;
  /** Wait for the next copied message, bounded by the configured wait deadline. */
  receive(options?: {
    timeoutMs?: number;
  }): Promise<{ from: TName; value: TMessage }>;
  /** One-shot rendezvous for every agent in this group; use a new name per phase. */
  barrier(name: string, options?: { timeoutMs?: number }): Promise<void>;
  readonly view: ScenarioOperations["view"];
  readonly observe: ScenarioOperations["observe"];
}
/** An async participant using an existing named scenario actor. */
export interface AgentDefinition<
  TCluster extends Cluster,
  TName extends string,
  TMessage,
> {
  /** An existing scenario actor name. Duplicate names fail before execution. */
  readonly name: TName;
  readonly run: (
    context: AgentContext<TCluster, TName, TMessage>,
  ) => Promise<void>;
}
/** Group deadlines and message limits. Seeded inputs do not determine async scheduling. */
export interface AgentOptions {
  readonly seed: string;
  /** Whole-group deadline. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /** Default receive/barrier deadline. Defaults to the group deadline. */
  readonly waitTimeoutMs?: number;
  /** Maximum cooperative teardown wait after failure. Defaults to one second. */
  readonly teardownTimeoutMs?: number;
  /** Per-recipient queue capacity. Defaults to 1024; a full queue rejects sends. */
  readonly maxQueuedMessages?: number;
  readonly signal?: AbortSignal;
}
/** Agent and operation context with the original error available as cause. */
export class AgentError extends Error {
  constructor(
    readonly agent: string,
    readonly operation: string,
    message: string,
    cause?: unknown,
  ) {
    super(`Agent ${agent}: ${operation}: ${message}`, { cause });
    this.name = "AgentError";
  }
}
/**
 * Group failure with original agent errors and names still running at teardown.
 * Cancellation is cooperative; callbacks that ignore their signal can continue.
 */
export class AgentGroupError extends AggregateError {
  constructor(
    errors: unknown[],
    readonly unfinishedAgents: readonly string[],
  ) {
    super(
      errors,
      `Agent group failed${unfinishedAgents.length ? `; teardown deadline reached for: ${unfinishedAgents.join(", ")}` : ""}`,
    );
    this.name = "AgentGroupError";
  }
}
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)
    throw new RangeError(`${name} must be a positive bounded integer`);
  return value;
}
function randomStream(
  seed: string,
  name: string,
  signal: AbortSignal,
): AgentRandom {
  let counter = 0n;
  function block(): Buffer {
    signal.throwIfAborted();
    return createHmac("sha256", seed)
      .update(
        JSON.stringify([
          "thruput-testkit/agent-rng/v1",
          name,
          (counter++).toString(),
        ]),
      )
      .digest();
  }
  return Object.freeze({
    next: () => Number(block().readBigUInt64BE() >> 11n) / 9007199254740992,
    integer(maxExclusive: number) {
      if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0)
        throw new AgentError(
          name,
          "random.integer",
          "maxExclusive must be a positive safe integer",
        );
      const maximum = BigInt(maxExclusive);
      const limit = (1n << 64n) - ((1n << 64n) % maximum);
      let sample: bigint;
      do {
        sample = block().readBigUInt64BE();
      } while (sample >= limit);
      return Number(sample % maximum);
    },
    bytes(length: number) {
      if (!Number.isSafeInteger(length) || length < 0 || length > 1_048_576)
        throw new AgentError(
          name,
          "random.bytes",
          "length must be between zero and 1048576",
        );
      signal.throwIfAborted();
      const result = new Uint8Array(length);
      for (let offset = 0; offset < length; offset += 32)
        result.set(block().subarray(0, Math.min(32, length - offset)), offset);
      return result;
    },
  });
}

/** Bind group-owned controls while retaining the parent scenario's nonce and report scope. */
function scopedActor<TCluster extends Cluster>(
  actor: Actor<TCluster>,
  signal: AbortSignal,
): Actor<TCluster> {
  const combine = (other?: AbortSignal) =>
    other ? AbortSignal.any([signal, other]) : signal;
  return Object.freeze({
    ...actor,
    async submit(calls, options = {}) {
      signal.throwIfAborted();
      const pending = await actor.submit(calls, {
        ...options,
        signal: combine(options.signal),
      });
      return Object.freeze({
        submission: pending.submission,
        wait: (wait: ObserveOptions = {}) =>
          pending.wait({ ...wait, signal: combine(wait.signal) }),
      });
    },
    call(calls, options = {}) {
      signal.throwIfAborted();
      return actor.call(calls, { ...options, signal: combine(options.signal) });
    },
    deploy(deployment, options) {
      signal.throwIfAborted();
      return actor.deploy(deployment, {
        ...options,
        signal: combine(options.signal),
      });
    },
  } satisfies Actor<TCluster>);
}

export function createAgentRunner<
  TCluster extends Cluster,
  TName extends string,
>(
  parentSignal: AbortSignal,
  names: ReadonlySet<TName>,
  bind: (name: TName, signal: AbortSignal) => Promise<Actor<TCluster>>,
  reads: ScenarioOperations,
) {
  return async function agents<TMessage = never>(
    definitions: readonly AgentDefinition<TCluster, TName, TMessage>[],
    options: AgentOptions,
  ): Promise<void> {
    if (typeof options.seed !== "string" || !options.seed.length)
      throw new Error("Agent seed must be a nonempty string");
    const timeout = positive(options.timeoutMs ?? 30_000, "timeoutMs");
    const waitTimeout = positive(
      options.waitTimeoutMs ?? timeout,
      "waitTimeoutMs",
    );
    const teardown = positive(
      options.teardownTimeoutMs ?? 1000,
      "teardownTimeoutMs",
    );
    const capacity = positive(
      options.maxQueuedMessages ?? 1024,
      "maxQueuedMessages",
    );
    const specs = definitions.map((definition) => ({ ...definition }));
    const running = new Set<TName>();
    for (const definition of specs) {
      if (running.has(definition.name) || !names.has(definition.name))
        throw new Error(`Duplicate or unknown agent: ${definition.name}`);
      if (typeof definition.run !== "function")
        throw new Error(`Agent ${definition.name} requires a run function`);
      running.add(definition.name);
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([
      parentSignal,
      abort.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    const failures: unknown[] = [];
    type Message = { from: TName; value: TMessage };
    type Receiver = {
      accept: (message: Message) => void;
      reject: (error: unknown) => void;
    };
    const mail = new Map(
      specs.map(({ name }) => [
        name,
        { queue: [] as Message[], receivers: [] as Receiver[] },
      ]),
    );
    const barriers = new Map<
      string,
      {
        arrived: Set<TName>;
        waiting: { accept: () => void; reject: (error: unknown) => void }[];
        completed: boolean;
        broken?: unknown;
      }
    >();
    let interrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => {
      interrupt = resolve;
    });
    const onAbort = () => interrupt();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () =>
        abort.abort(
          new AgentError("group", "deadline", `exceeded ${timeout}ms`),
        ),
      timeout,
    );
    function wait<T>(
      name: TName,
      operation: string,
      waitSignal: AbortSignal,
      timeoutMs: number,
      register: (
        accept: (value: T) => void,
        reject: (error: unknown) => void,
      ) => () => void,
    ): Promise<T> {
      waitSignal.throwIfAborted();
      positive(timeoutMs, `${operation}.timeoutMs`);
      return new Promise<T>((resolve, reject) => {
        let remove = () => {};
        let settled = false;
        const finish = (error: unknown, value?: T) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          waitSignal.removeEventListener("abort", cancel);
          remove();
          if (error !== undefined) reject(error);
          else resolve(value as T);
        };
        const cancel = () =>
          finish(
            new AgentError(name, operation, "cancelled", waitSignal.reason),
          );
        const deadline = setTimeout(
          () =>
            finish(
              new AgentError(name, operation, `timed out after ${timeoutMs}ms`),
            ),
          timeoutMs,
        );
        waitSignal.addEventListener("abort", cancel, { once: true });
        remove = register(
          (value) => finish(undefined, value),
          (error) => finish(error),
        );
        if (settled) remove();
      });
    }
    function fail(error: unknown) {
      failures.push(error);
      if (!signal.aborted) abort.abort(error);
    }
    const tasks = specs.map(async ({ name, run }) => {
      const owner = new AbortController();
      const agentSignal = AbortSignal.any([signal, owner.signal]);
      try {
        const actor = scopedActor(await bind(name, agentSignal), agentSignal);
        agentSignal.throwIfAborted();
        const combine = (other?: AbortSignal) =>
          other ? AbortSignal.any([agentSignal, other]) : agentSignal;
        const context = Object.freeze<AgentContext<TCluster, TName, TMessage>>({
          name,
          actor,
          signal: agentSignal,
          random: randomStream(options.seed, name, agentSignal),
          send(to: TName, value: TMessage) {
            agentSignal.throwIfAborted();
            const box = mail.get(to);
            if (!box || !running.has(to))
              throw new AgentError(
                name,
                "send",
                `recipient ${to} is not running`,
              );
            let copy: TMessage;
            try {
              copy = deserialize(serialize(value)) as TMessage;
            } catch (error) {
              throw new AgentError(
                name,
                "send",
                "payload cannot be copied",
                error,
              );
            }
            const receiver = box.receivers.shift();
            if (receiver) receiver.accept({ from: name, value: copy });
            else {
              if (box.queue.length >= capacity)
                throw new AgentError(
                  name,
                  "send",
                  `recipient ${to} queue is full`,
                );
              box.queue.push({ from: name, value: copy });
            }
          },
          receive(control = {}) {
            agentSignal.throwIfAborted();
            return wait<Message>(
              name,
              "receive",
              agentSignal,
              control.timeoutMs ?? waitTimeout,
              (accept, reject) => {
                const box = mail.get(name)!;
                const message = box.queue.shift();
                if (message) {
                  accept(message);
                  return () => {};
                }
                const receiver = { accept, reject };
                box.receivers.push(receiver);
                return () => {
                  const index = box.receivers.indexOf(receiver);
                  if (index >= 0) box.receivers.splice(index, 1);
                };
              },
            );
          },
          barrier(label: string, control = {}) {
            agentSignal.throwIfAborted();
            if (!label || label.trim() !== label)
              throw new AgentError(
                name,
                "barrier",
                "name must be nonempty without surrounding whitespace",
              );
            let barrier = barriers.get(label);
            if (!barrier) {
              barrier = { arrived: new Set(), waiting: [], completed: false };
              barriers.set(label, barrier);
            }
            if (barrier.broken)
              throw new AgentError(
                name,
                "barrier",
                `${label} is broken`,
                barrier.broken,
              );
            if (barrier.completed || barrier.arrived.has(name))
              throw new AgentError(
                name,
                "barrier",
                `${label} was already entered`,
              );
            positive(control.timeoutMs ?? waitTimeout, "barrier.timeoutMs");
            barrier.arrived.add(name);
            const current = barrier;
            return wait<void>(
              name,
              `barrier ${label}`,
              agentSignal,
              control.timeoutMs ?? waitTimeout,
              (accept, reject) => {
                const entry = { accept: () => accept(undefined), reject };
                current.waiting.push(entry);
                if (current.arrived.size === specs.length) {
                  current.completed = true;
                  for (const peer of [...current.waiting]) peer.accept();
                }
                return () => {
                  const index = current.waiting.indexOf(entry);
                  if (index >= 0) current.waiting.splice(index, 1);
                };
              },
            ).catch((error: unknown) => {
              current.broken = error;
              for (const peer of [...current.waiting]) peer.reject(error);
              throw error;
            });
          },
          view: (request, control = {}) =>
            reads.view(request, {
              ...control,
              signal: combine(control.signal),
            }),
          observe: (evidence, control = {}) =>
            reads.observe(evidence, {
              ...control,
              signal: combine(control.signal),
            }),
        });
        await run(context);
      } catch (error) {
        fail(
          error instanceof AgentError
            ? error
            : new AgentError(name, "run", "failed", error),
        );
      } finally {
        owner.abort(new Error(`Agent ${name} is closed`));
        running.delete(name);
      }
    });
    const settled = Promise.all(tasks);
    try {
      await Promise.race([settled, interrupted]);
      if (signal.aborted) {
        if (!failures.length) failures.push(signal.reason);
        let teardownTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            settled,
            new Promise<void>((resolve) => {
              teardownTimer = setTimeout(resolve, teardown);
            }),
          ]);
        } finally {
          clearTimeout(teardownTimer);
        }
        throw new AgentGroupError([...failures], [...running]);
      }
    } finally {
      clearTimeout(timer);
      // Invalidate contexts even when user code completes successfully.
      if (!signal.aborted) abort.abort(new Error("Agent group is closed"));
      signal.removeEventListener("abort", onAbort);
      for (const box of mail.values()) {
        box.queue.length = 0;
        box.receivers.length = 0;
      }
      barriers.clear();
    }
  };
}
