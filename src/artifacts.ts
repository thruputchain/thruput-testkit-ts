import { readFile } from "node:fs/promises";
import {
  prepareContractDeployment,
  rv32Contract,
  type ContractAddress,
  type ContractDeployment,
} from "@thruputchain/client";

/** Named RV32 code, retained in memory independently of its source file. */
export interface ScenarioArtifact {
  readonly name: string;
  /** Predict an address without signing, funding, or sending a transaction. */
  prepare(
    deployer: ContractAddress,
    deploymentNonce?: Uint8Array,
  ): ContractDeployment;
}

/**
 * Load named RV32 files. Use matching CLI-generated method descriptors.
 *
 * Files are read once and retained in memory. Preparing a deployment predicts
 * its address; {@link ActorOperations.deploy} signs and sends it.
 *
 * @example
 * ```ts
 * import { loadArtifacts } from "@thruputchain/testkit";
 *
 * const artifacts = await loadArtifacts({
 *   counter: new URL("./fixtures/counter.rv32a", import.meta.url),
 * });
 * const deployment = artifacts.counter.prepare(alice.account.address);
 * await alice.deploy(deployment, { amount: 50_000_000n });
 * ```
 */
export async function loadArtifacts<TName extends string>(
  paths: Readonly<Record<TName, string | URL>>,
): Promise<Readonly<Record<TName, ScenarioArtifact>>> {
  const entries = await Promise.all(
    Object.entries<string | URL>(paths).map(async ([name, path]) => {
      if (!name || name.trim() !== name)
        throw new Error(
          "Artifact names must be nonempty without surrounding whitespace",
        );
      const contract = rv32Contract(await readFile(path));
      const artifact: ScenarioArtifact = Object.freeze({
        name,
        prepare(deployer: ContractAddress, deploymentNonce?: Uint8Array) {
          return prepareContractDeployment({
            deployer,
            contract,
            deploymentNonce,
          });
        },
      });
      return [name, artifact] as const;
    }),
  );
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    Record<TName, ScenarioArtifact>
  >;
}
