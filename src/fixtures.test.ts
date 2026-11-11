import { expect, it } from "vitest";
import { fixtureAccounts } from "./fixtures.js";

it("derives stable accounts by seed and name, independent of order and allocation", async () => {
  const first = fixtureAccounts("seed", {
    alice: { initialStorageTokens: 1n },
    bob: { initialStorageTokens: 2n },
  });
  const second = fixtureAccounts("seed", {
    bob: { initialStorageTokens: 3n },
    alice: { initialStorageTokens: 4n },
  });
  expect(first.accounts.alice.address).toEqual(second.accounts.alice.address);
  expect(first.accounts.bob.address).toEqual(second.accounts.bob.address);
  expect(first.accounts.alice.address).not.toEqual(first.accounts.bob.address);
  expect(first.accounts.alice.address).not.toEqual(
    fixtureAccounts("other", { alice: { initialStorageTokens: 1n } }).accounts
      .alice.address,
  );
  const message = new Uint8Array([1, 2, 3]);
  expect(await first.accounts.alice.signers[0]!.signer.sign(message)).toEqual(
    await second.accounts.alice.signers[0]!.signer.sign(message),
  );
  expect(first.allocations[0]).toEqual({
    publicKey: expect.any(String),
    initialStorageTokens: "1",
  });
});

it("rejects invalid fixture inputs before starting a process", () => {
  for (const amount of [
    0n,
    -1n,
    9223372036854775808n,
    1 as unknown as bigint,
  ]) {
    expect(() =>
      fixtureAccounts("seed", { alice: { initialStorageTokens: amount } }),
    ).toThrow("initialStorageTokens");
  }
  expect(() => fixtureAccounts("", {})).toThrow("seed");
  expect(() =>
    fixtureAccounts("seed", { " alice": { initialStorageTokens: 1n } }),
  ).toThrow("Actor names");
});
