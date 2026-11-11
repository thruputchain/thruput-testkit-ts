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
} from "@thruputchain/client";

/** A named account and its ordinary SDK wallet. */
export interface Actor<TCluster extends Cluster = Cluster> {
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
> {
  readonly client: ConnectedThruputClient<TCluster>;
  /** Aborted when closed or when the configured network signal is aborted. */
  readonly signal: AbortSignal;
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
    for (const [name, account] of accounts) {
      actors.set(
        name,
        Object.freeze({
          name,
          account,
          wallet: createWalletClient({
            client,
            account,
            onSigned: onSigned
              ? (submission) => onSigned(name, submission)
              : undefined,
          }),
        }),
      );
    }
    return Object.freeze({
      client,
      signal,
      actor(name: TName) {
        signal.throwIfAborted();
        const actor = actors.get(name);
        if (!actor) throw new Error(`Unknown scenario actor: ${name}`);
        return actor;
      },
      async close() {
        controller.abort(new Error("Scenario is closed"));
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
