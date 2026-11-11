import { createHash } from "node:crypto";
import {
  createPubkeyAccount,
  Ed25519Signer,
  toBase58,
  type PubkeyAccount,
} from "@thruputchain/client";

/** Explicit genesis allocation, in raw native-token units. */
export interface FixtureAccount {
  readonly initialStorageTokens: bigint;
}

// Versioned, length-delimited input keeps identities independent of enumeration
// order and prevents ambiguous seed/name concatenations.
export function fixtureAccounts<TName extends string>(
  seed: string,
  fixtures: Readonly<Record<TName, FixtureAccount>>,
) {
  if (typeof seed !== "string" || !seed.length)
    throw new Error("Fixture seed must be a nonempty string");
  const entries = Object.entries<FixtureAccount>(fixtures);
  if (entries.length > 1000)
    throw new Error("At most 1000 fixture accounts are supported");
  const accounts: [string, PubkeyAccount][] = [];
  const allocations: { publicKey: string; initialStorageTokens: string }[] = [];
  for (const [name, fixture] of entries) {
    if (!name || name.trim() !== name)
      throw new Error(
        "Actor names must be nonempty without surrounding whitespace",
      );
    const amount = fixture?.initialStorageTokens;
    if (
      typeof amount !== "bigint" ||
      amount <= 0n ||
      amount > 9223372036854775807n
    ) {
      throw new Error(
        `Actor ${name} requires a positive signed-64-bit initialStorageTokens amount`,
      );
    }
    const bytes = createHash("sha256")
      .update(JSON.stringify(["thruput-testkit/fixture/v1", seed, name]))
      .digest();
    const signer = Ed25519Signer.fromSeed(bytes);
    bytes.fill(0);
    accounts.push([name, createPubkeyAccount({ signer })]);
    allocations.push({
      publicKey: toBase58(signer.publicKey.ed25519),
      initialStorageTokens: amount.toString(),
    });
  }
  return {
    accounts: Object.fromEntries(accounts) as Record<TName, PubkeyAccount>,
    allocations,
  };
}
