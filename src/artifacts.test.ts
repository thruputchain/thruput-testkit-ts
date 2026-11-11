import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { contractAddress } from "@thruputchain/client";
import { loadArtifacts } from "./artifacts.js";

it("loads the pinned artifact and prepares independent SDK deployment snapshots", async () => {
  const path = new URL("../tests/fixtures/counter.rv32a", import.meta.url);
  const provenance = JSON.parse(
    await readFile(
      new URL("../tests/fixtures/provenance.json", import.meta.url),
      "utf8",
    ),
  );
  expect(
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  ).toBe(provenance.sha256);
  const artifacts = await loadArtifacts({ counter: path });
  const deployer = contractAddress(new Uint8Array(32));
  const nonce = new Uint8Array(32).fill(1);
  const first = artifacts.counter.prepare(deployer, nonce);
  const second = artifacts.counter.prepare(deployer, nonce);
  expect(first.address).toEqual(second.address);
  expect(first.contract).not.toBe(second.contract);
  first.address.fill(9);
  expect(artifacts.counter.prepare(deployer, nonce).address).toEqual(
    second.address,
  );
  expect(artifacts.counter.name).toBe("counter");
});

it("rejects invalid names and missing artifacts", async () => {
  await expect(loadArtifacts({ " bad ": "missing" })).rejects.toThrow(
    "Artifact names",
  );
  await expect(
    loadArtifacts({ counter: "missing-artifact.rv32a" }),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
