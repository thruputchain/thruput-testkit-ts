import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  localnet,
  type ClusterThruputClientOptions,
} from "@thruputchain/client";
import { fixtureAccounts, type FixtureAccount } from "./fixtures.js";
import {
  launch,
  ownProcesses,
  stop,
  type NodeProcess,
} from "./node-process.js";
import {
  createScenario,
  type Scenario,
  type ScenarioOptions,
} from "./scenario.js";

/**
 * Runtime combination qualified by this testkit release.
 *
 * Testkit installs this exact devnode and requires its wire format. The CLI
 * can be this version or newer: a newer minor or major version emits a Node.js
 * warning, and an older version is rejected.
 */
export const LOCAL_RUNTIME = Object.freeze({
  cli: "0.45.0",
  devnode: "0.1.33",
  wireFormat: "14.4.0",
});
type LocalCluster = ReturnType<typeof localnet>;

/**
 * Accept the qualified CLI or a newer one. Patch releases are treated as
 * qualified; newer minor or major versions run with a warning.
 */
export function checkCliVersion(output: string): {
  version: string;
  qualified: boolean;
} {
  const match = /^thruput (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(output.trim());
  if (!match)
    throw new Error(`Unrecognized Thruput CLI version: ${output.trim()}`);
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  const found = match.slice(1, 4).map(Number);
  const pinned = LOCAL_RUNTIME.cli.split(".").map(Number);
  const order =
    found.map((value, index) => value - pinned[index]!).find(Boolean) ?? 0;
  if (order < 0)
    throw new Error(
      `Thruput CLI ${version} is older than the qualified ${LOCAL_RUNTIME.cli}`,
    );
  return {
    version,
    qualified: found[0] === pinned[0] && found[1] === pinned[1],
  };
}

/** Configuration for an isolated Linux node with explicit genesis funding. */
export interface LocalScenarioOptions<TName extends string = string> {
  /** Public test seed. These repeatable accounts are for disposable local nodes. */
  readonly seed: string;
  /** Named allocations. The seed and each name determine its test account. */
  readonly accounts: Readonly<Record<TName, FixtureAccount>>;
  /** Installed CLI executable. Defaults to thruput on PATH. */
  readonly cli?: string;
  /** Parent for a unique private directory. Defaults to the OS temporary directory. */
  readonly directory?: string;
  /** Preserve state and logs after close, including failed startup. */
  readonly keepDirectory?: boolean;
  /** Separate durable run directory; never removed with the managed node. */
  readonly runDirectory?: string;
  /** Includes runtime installation and RPC discovery. Defaults to 120 seconds. */
  readonly startupTimeoutMs?: number;
  /** Cancellation closes the node even if the workflow is still running. */
  readonly signal?: AbortSignal;
  /** Defaults to instant. Manual block production is not supported. */
  readonly blockDriver?: "instant" | "interval";
  readonly requiredMethods?: ClusterThruputClientOptions<LocalCluster>["requiredMethods"];
  readonly onSigned?: ScenarioOptions<LocalCluster, TName>["onSigned"];
}

/** A scenario that owns its node process, temporary state, and fixture accounts. */
export interface LocalScenario<TName extends string = string> extends Scenario<
  LocalCluster,
  TName
> {
  readonly local: {
    readonly directory: string;
    readonly rpcUrl: string;
    readonly capabilities: {
      readonly genesisAccounts: true;
      readonly blockDriver: "instant" | "interval";
      readonly manualBlocks: false;
      readonly snapshots: false;
    };
  };
}

/**
 * Start an isolated Linux node with explicit, deterministic genesis accounts.
 *
 * Requires the CLI version in {@link LOCAL_RUNTIME}, or a newer one, on PATH
 * or as an explicit `cli` executable. Startup checks runtime and network identity. Each scenario
 * uses its own directory and ports. Close the returned scenario in `finally`,
 * or use {@link withLocalScenario} for callback-scoped cleanup.
 */
export async function createLocalScenario<TName extends string>(
  options: LocalScenarioOptions<TName>,
): Promise<LocalScenario<TName>> {
  if (process.platform !== "linux")
    throw new Error("Managed local scenarios require Linux");
  const blockDriver = options.blockDriver ?? "instant";
  if (blockDriver !== "instant" && blockDriver !== "interval")
    throw new Error(`Unsupported block driver: ${blockDriver}`);
  const timeout = options.startupTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647)
    throw new Error("startupTimeoutMs must be a positive timer duration");
  options.signal?.throwIfAborted();
  const { accounts, allocations } = fixtureAccounts(
    options.seed,
    options.accounts,
  );
  const cli = options.cli?.includes("/")
    ? resolve(options.cli)
    : (options.cli ?? "thruput");
  const directory = await mkdtemp(
    join(resolve(options.directory ?? tmpdir()), "thruput-testkit-"),
  );
  const controller = new AbortController();
  const signal = controller.signal;
  const tasks: NodeProcess[] = [];
  let scenario: Scenario<LocalCluster, TName> | undefined;
  let finishStartup!: () => void;
  const started = new Promise<void>((resolve) => {
    finishStartup = resolve;
  });
  let closing: Promise<void> | undefined;
  let cleanupError: unknown;
  const unregister = ownProcesses(close);
  const onAbort = () => {
    void close(options.signal?.reason).catch((error: unknown) => {
      cleanupError = error;
    });
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`Local node startup timed out after ${timeout}ms`),
      ),
    timeout,
  );

  function close(
    reason = new Error("Local scenario is closed"),
  ): Promise<void> {
    controller.abort(reason);
    closing ??= (async () => {
      await started;
      const errors: unknown[] = [];
      try {
        await scenario?.close();
        for (const task of [...tasks].reverse()) {
          try {
            await stop(task);
          } catch (error) {
            errors.push(error);
          }
        }
        if (!options.keepDirectory && !errors.length)
          await rm(directory, { recursive: true, force: true });
      } finally {
        unregister();
        options.signal?.removeEventListener("abort", onAbort);
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          `Local node cleanup failed; logs: ${directory}`,
        );
    })();
    return closing;
  }

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("THRUPUT_") ||
      key.startsWith("GROUNDHOG_") ||
      key === "HOGD_PROTOCOL_OVERRIDE"
    )
      delete env[key];
  }
  env.XDG_CONFIG_HOME = join(directory, "config");
  env.XDG_CACHE_HOME = join(directory, "cache");
  env.XDG_DATA_HOME = join(directory, "data");
  function start(args: string[], label: string) {
    signal.throwIfAborted();
    const task = launch(cli, args, directory, env, label);
    tasks.push(task);
    return task;
  }
  async function run(args: string[], label: string) {
    const task = start(args, label);
    while (!task.exited) await sleep(25, undefined, { signal });
    signal.throwIfAborted();
    if (task.child.exitCode !== 0) throw task.result;
    return readFile(join(directory, `${label}.stdout.log`), "utf8");
  }

  try {
    let local: LocalScenario<TName>["local"];
    try {
      const cliVersion = checkCliVersion(await run(["--version"], "version"));
      if (!cliVersion.qualified)
        process.emitWarning(
          `Thruput CLI ${cliVersion.version} is newer than the qualified ${LOCAL_RUNTIME.cli}`,
          { code: "THRUPUT_TESTKIT_UNQUALIFIED_CLI" },
        );
      await mkdir(env.XDG_CONFIG_HOME, { recursive: true });
      await writeFile(
        join(directory, "allocations.json"),
        JSON.stringify(allocations),
        { mode: 0o600 },
      );
      await run(
        ["--json", "toolchain", "install", LOCAL_RUNTIME.devnode],
        "install",
      );
      const node = start(
        [
          "--json",
          "node",
          "--host",
          "127.0.0.1",
          "--port",
          "0",
          "--hog-devnode-version",
          LOCAL_RUNTIME.devnode,
          "--offline",
          "--startup-timeout-secs",
          "45",
          "--block-driver",
          blockDriver,
          "--data-dir",
          join(directory, "node"),
          "--bootstrap-accounts",
          join(directory, "allocations.json"),
        ],
        "node",
      );
      let rpcUrl: string;
      while (true) {
        signal.throwIfAborted();
        if (node.exited) throw node.result;
        const text = await readFile(join(directory, "node.stdout.log"), "utf8");
        const end = text.indexOf("\n");
        if (end !== -1) {
          const report = JSON.parse(text.slice(0, end));
          if (
            report?.ok !== true ||
            report.command !== "node" ||
            report.data?.schemaVersion !== 5
          )
            throw new Error("Invalid node startup report");
          const url = new URL(report.data.rpcUrl);
          if (
            url.protocol !== "http:" ||
            url.hostname !== "127.0.0.1" ||
            !url.port ||
            url.username ||
            url.password
          )
            throw new Error("Node must report a loopback RPC URL");
          rpcUrl = url.href;
          break;
        }
        await sleep(50, undefined, { signal });
      }
      void node.done
        .then(() => close(node.result))
        .catch((error: unknown) => {
          cleanupError = error;
        });
      scenario = await createScenario({
        network: {
          cluster: localnet({ rpcUrl }),
          signal,
          requiredMethods: options.requiredMethods,
        },
        accounts,
        runDirectory: options.runDirectory,
        onSigned: options.onSigned,
      });
      const versionInfo = await scenario.client.getVersionInfo({}, { signal });
      if (
        versionInfo.implementation !== cliVersion.version ||
        versionInfo.wireFormat !== LOCAL_RUNTIME.wireFormat
      )
        throw new Error(
          `Serving runtime ${versionInfo.implementation} (wire ${versionInfo.wireFormat}) does not match CLI ${cliVersion.version} and wire ${LOCAL_RUNTIME.wireFormat}`,
        );
      signal.throwIfAborted();
      local = Object.freeze({
        directory,
        rpcUrl,
        capabilities: Object.freeze({
          genesisAccounts: true,
          blockDriver,
          manualBlocks: false,
          snapshots: false,
        }),
      });
    } finally {
      clearTimeout(timer);
      finishStartup();
    }
    return Object.freeze({
      ...scenario!,
      get confirmedHeight() {
        return scenario!.confirmedHeight;
      },
      local,
      close: () => close(),
    });
  } catch (error) {
    let diagnostics = "";
    for (const label of ["install", "node"])
      diagnostics += await readFile(
        join(directory, `${label}.stderr.log`),
        "utf8",
      ).then(
        (text) => text.slice(-4096),
        () => "",
      );
    try {
      await close();
    } catch (failure) {
      cleanupError = failure;
    }
    if (cleanupError)
      throw new AggregateError(
        [error, cleanupError],
        `Local scenario failed; logs: ${directory}`,
      );
    throw new Error(
      `Local scenario startup failed${options.keepDirectory ? `; logs: ${directory}` : ""}${diagnostics ? `\n${diagnostics}` : ""}`,
      { cause: error },
    );
  }
}

/**
 * Run a local workflow and await owned-node cleanup on every exit path.
 *
 * Account allocations use raw native-token units; account storage consumes part
 * of each allocation. Seeded accounts are for disposable test networks.
 *
 * @example
 * ```ts
 * import { withLocalScenario } from "@thruputchain/testkit";
 *
 * await withLocalScenario({
 *   seed: "example",
 *   accounts: { alice: { initialStorageTokens: 1_000_000_000n } },
 * }, async (scenario) => {
 *   console.log(await scenario.actor("alice").wallet.getBalance());
 * });
 * ```
 */
export async function withLocalScenario<TName extends string, TResult>(
  options: LocalScenarioOptions<TName>,
  run: (scenario: LocalScenario<TName>) => Promise<TResult>,
): Promise<TResult> {
  const scenario = await createLocalScenario(options);
  let result: TResult;
  try {
    result = await run(scenario);
  } catch (error) {
    try {
      await scenario.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Local workflow and cleanup failed",
      );
    }
    throw error;
  }
  await scenario.close();
  return result;
}
