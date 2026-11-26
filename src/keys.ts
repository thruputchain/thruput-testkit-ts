import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  Ed25519Signer,
  createPubkeyAccount,
  fromHex0x,
  toBase58,
  toHex0x,
  type PubkeyAccount,
} from "@thruputchain/client";

/** An Ed25519 account and the private key file that can restore it. */
export interface KeyFile {
  readonly path: string;
  readonly address: string;
  readonly account: PubkeyAccount;
  /** Private signing seed. Never log it or put it in a report. */
  readonly seed: Uint8Array;
}

/**
 * Create a new private, timestamped directory for one script invocation.
 *
 * Put key files in it, and pass a new child path as the scenario
 * `runDirectory`. The parent is created when missing. Directories use mode 0700.
 *
 * @example
 * ```ts
 * const directory = await createOutputDirectory(".local/setup");
 * const deployer = await createKeyFile(join(directory, "key.json"));
 * await withScenario({
 *   network,
 *   accounts: { deployer: deployer.account },
 *   runDirectory: join(directory, "transactions"),
 * }, async (scenario) => {
 *   // ...
 * });
 * ```
 */
export async function createOutputDirectory(parent: string): Promise<string> {
  await mkdir(resolve(parent), { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return mkdtemp(join(resolve(parent), `run-${timestamp}-`));
}

/**
 * Generate an Ed25519 account and save its seed before the account is funded or used.
 *
 * The file is created exclusively with mode 0600 and flushed to disk. An
 * existing file is never replaced. Missing parent directories are created with
 * mode 0700. Use {@link loadKeyFile} to restore the account later.
 */
export async function createKeyFile(path: string): Promise<KeyFile> {
  const seed = randomBytes(32);
  const account = createPubkeyAccount({ signer: Ed25519Signer.fromSeed(seed) });
  const address = toBase58(account.address);
  const file = resolve(path);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(
    file,
    JSON.stringify(
      { seed: toHex0x(seed), accountNonce: account.nonce.toString(), address },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600, flush: true },
  );
  return Object.freeze({
    path: file,
    address,
    account,
    seed: new Uint8Array(seed),
  });
}

/** Restore an account saved by {@link createKeyFile}. The saved address must match the seed. */
export async function loadKeyFile(path: string): Promise<KeyFile> {
  const file = resolve(path);
  const saved: unknown = JSON.parse(await readFile(file, "utf8"));
  if (
    typeof saved !== "object" ||
    saved === null ||
    !("seed" in saved) ||
    !("accountNonce" in saved) ||
    !("address" in saved) ||
    typeof saved.seed !== "string" ||
    typeof saved.accountNonce !== "string" ||
    !/^\d+$/.test(saved.accountNonce) ||
    typeof saved.address !== "string"
  )
    throw new Error(`Invalid key file: ${file}`);
  const seed = fromHex0x(saved.seed);
  if (seed.length !== 32) throw new Error(`Invalid key file seed: ${file}`);
  const account = createPubkeyAccount({
    signer: Ed25519Signer.fromSeed(seed),
    nonce: BigInt(saved.accountNonce),
  });
  const address = toBase58(account.address);
  if (address !== saved.address)
    throw new Error(`Key file address does not match its seed: ${file}`);
  return Object.freeze({ path: file, address, account, seed });
}
