import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { toBase58 } from "@thruputchain/client";
import { createKeyFile, createOutputDirectory, loadKeyFile } from "./index.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "testkit-keys-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("saves a private key file that restores the same account", async () => {
  const path = join(root, "keys", "deployer.json");
  const created = await createKeyFile(path);
  expect(created.address).toBe(toBase58(created.account.address));
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, "keys"))).mode & 0o777).toBe(0o700);

  const loaded = await loadKeyFile(path);
  expect(loaded.address).toBe(created.address);
  expect(loaded.seed).toEqual(created.seed);
  expect(toBase58(loaded.account.address)).toBe(created.address);
});

it("never replaces an existing key file", async () => {
  const path = join(root, "key.json");
  const first = await createKeyFile(path);
  await expect(createKeyFile(path)).rejects.toMatchObject({ code: "EEXIST" });
  expect((await loadKeyFile(path)).address).toBe(first.address);
});

it("rejects key files whose address does not match the seed", async () => {
  const path = join(root, "key.json");
  await createKeyFile(path);
  const saved = JSON.parse(await readFile(path, "utf8"));
  const other = await createKeyFile(join(root, "other.json"));
  await writeFile(path, JSON.stringify({ ...saved, address: other.address }));
  await expect(loadKeyFile(path)).rejects.toThrow("does not match");
  await writeFile(path, JSON.stringify({ seed: saved.seed }));
  await expect(loadKeyFile(path)).rejects.toThrow("Invalid key file");
});

it("creates a new private directory for each invocation", async () => {
  const parent = join(root, ".local", "setup");
  const first = await createOutputDirectory(parent);
  const second = await createOutputDirectory(parent);
  expect(first).not.toBe(second);
  expect(first.startsWith(join(parent, "run-"))).toBe(true);
  for (const directory of [parent, first])
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
});
