import {
  createThruputClient,
  createWalletClient,
  HttpTransport,
  type Cluster,
  type ClusterThruputClientOptions,
  type ConnectedThruputClient,
  type ExecutableWalletClient,
  type PubkeyAccount,
  type SubmissionEvidence,
  type Transport,
  toBase58,
} from "@thruputchain/client";
import { createRun, type ScenarioRun } from "./run.js";
import {
  createAgentRunner,
  type AgentDefinition,
  type AgentOptions,
} from "./agents.js";
import {
  createOperations,
  type ActorOperations,
  type ScenarioOperations,
} from "./operations.js";

/** A named account and its ordinary SDK wallet. */
export interface Actor<
  TCluster extends Cluster = Cluster,
> extends ActorOperations {
  readonly name: string;
  readonly account: PubkeyAccount;
  readonly wallet: ExecutableWalletClient<
    ConnectedThruputClient<TCluster>,
    PubkeyAccount
  >;
}

/** Configuration for attaching a scenario to an existing network. */
export interface ScenarioOptions<
  TCluster extends Cluster = Cluster,
  TName extends string = string,
> {
  /**
   * SDK connection options. The cluster must contain an expected networkHash.
   * Optional capabilities and required RPC methods are checked by the SDK.
   * The network signal cancels discovery and all subsequent scenario requests.
   */
  readonly network: ClusterThruputClientOptions<TCluster>;
  /** Explicit pubkey accounts, keyed by actor name. No accounts are funded implicitly. */
  readonly accounts: Readonly<Record<TName, PubkeyAccount>>;
  /** Exclusively create this directory for durable reports and restricted evidence. */
  readonly runDirectory?: string;
  /** SDK hook awaited before broadcast. Throwing prevents submission. */
  readonly onSigned?: (
    actor: TName,
    submission: SubmissionEvidence,
  ) => void | Promise<void>;
}

/** An attached network and named actors, owned by one test or script. */
export interface Scenario<
  TCluster extends Cluster = Cluster,
  TName extends string = string,
> extends ScenarioOperations {
  readonly client: ConnectedThruputClient<TCluster>;
  /** Aborted when closed or when the configured network signal is aborted. */
  readonly signal: AbortSignal;
  readonly run: ScenarioRun;
  /** Run optional, cooperatively cancelled named agents within this scenario. */
  agents<TMessage = never>(
    definitions: readonly AgentDefinition<TCluster, TName, TMessage>[],
    options: AgentOptions,
  ): Promise<void>;
  /** Look up a configured actor. Throws for an unknown name or a closed scenario. */
  actor(name: TName): Actor<TCluster>;
  /**
   * Cancel scenario requests and prevent further RPC dispatch. Idempotent.
   * Leaves the attached node, supplied accounts, and underlying transport owned
   * by the caller. Await your workflow before closing; this does not join user
   * tasks or revoke signers. Custom transports must honor request signals.
   */
  close(): Promise<void>;
}

/**
 * Attach to a pinned network and bind each supplied account to an SDK wallet.
 * Use withScenario for automatic cleanup, or close the result in finally.
 */
export async function createScenario<
  const TCluster extends Cluster,
  TName extends string,
>(
  options: ScenarioOptions<TCluster, TName>,
): Promise<Scenario<TCluster, TName>> {
  if (options.network.cluster.networkHash === undefined) {
    throw new Error("Scenario network requires an expected networkHash");
  }

  // Snapshot the name/account mapping before asynchronous discovery.
  const accounts = new Map<TName, PubkeyAccount>();
  for (const name of Object.keys(options.accounts) as TName[]) {
    if (!name || name.trim() !== name) {
      throw new Error(
        "Actor names must be nonempty without surrounding whitespace",
      );
    }
    const account = options.accounts[name];
    if (account?.kind !== "pubkey") {
      throw new Error(`Actor ${name} requires a pubkey account`);
    }
    accounts.set(name, account);
  }

  const transport =
    options.network.transport ??
    (options.network.cluster.rpcUrl
      ? new HttpTransport(options.network.cluster.rpcUrl)
      : undefined);
  if (!transport) {
    throw new Error("Scenario network requires a transport or rpcUrl");
  }
  const controller = new AbortController();
  const signal = options.network.signal
    ? AbortSignal.any([controller.signal, options.network.signal])
    : controller.signal;
  const scopedTransport: Transport = {
    async request(method, params, control) {
      const requestSignal = control?.signal
        ? AbortSignal.any([signal, control.signal])
        : signal;
      requestSignal.throwIfAborted();
      return transport.request(method, params, { signal: requestSignal });
    },
  };

  try {
    signal.throwIfAborted();
    const client = await createThruputClient({
      ...options.network,
      transport: scopedTransport,
      signal,
    });
    signal.throwIfAborted();
    const actors = new Map<TName, Actor<TCluster>>();
    const onSigned = options.onSigned;
    const recorder = await createRun(
      client.network.networkHash,
      Object.fromEntries(
        [...accounts].map(([name, account]) => [
          name,
          toBase58(account.address),
        ]),
      ),
      options.runDirectory,
    );
    signal.throwIfAborted();
    const operations = createOperations(client, signal, recorder.receipt);
    function bindActor(
      name: TName,
      walletClient: ConnectedThruputClient<TCluster>,
    ): Actor<TCluster> {
      const account = accounts.get(name)!;
      const signed = async (submission: SubmissionEvidence) => {
        await recorder.signed(name, submission);
        await onSigned?.(name, submission);
      };
      const wallet = createWalletClient({
        client: walletClient,
        account,
        onSigned: signed,
      });
      return Object.freeze({
        name,
        account,
        wallet,
        ...recorder.track(name, operations.actor(wallet, signed)),
      });
    }
    for (const name of accounts.keys()) {
      actors.set(name, bindActor(name, client));
    }
    const agents = createAgentRunner<TCluster, TName>(
      signal,
      new Set(accounts.keys()),
      async (name, agentSignal) => {
        const transport: Transport = {
          request(method, params, control) {
            const requestSignal = control?.signal
              ? AbortSignal.any([agentSignal, control.signal])
              : agentSignal;
            requestSignal.throwIfAborted();
            return scopedTransport.request(method, params, {
              signal: requestSignal,
            });
          },
        };
        const agentClient = await createThruputClient({
          ...options.network,
          transport,
          signal: agentSignal,
        });
        return bindActor(name, agentClient);
      },
      operations.reads,
    );
    return Object.freeze({
      client,
      signal,
      run: recorder.run,
      agents,
      get confirmedHeight() {
        return operations.reads.confirmedHeight;
      },
      observe: operations.reads.observe,
      view: operations.reads.view,
      actor(name: TName) {
        signal.throwIfAborted();
        const actor = actors.get(name);
        if (!actor) throw new Error(`Unknown scenario actor: ${name}`);
        return actor;
      },
      async close() {
        controller.abort(new Error("Scenario is closed"));
        await recorder.flush();
      },
    });
  } catch (error) {
    controller.abort(error);
    throw error;
  }
}

/** Run an async workflow and close its scenario after success or failure. */
export async function withScenario<
  const TCluster extends Cluster,
  TName extends string,
  TResult,
>(
  options: ScenarioOptions<TCluster, TName>,
  run: (scenario: Scenario<TCluster, TName>) => Promise<TResult>,
): Promise<TResult> {
  const scenario = await createScenario(options);
  try {
    return await run(scenario);
  } finally {
    await scenario.close();
  }
}
