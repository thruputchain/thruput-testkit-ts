import { describe, expect, it, vi } from "vitest";
import {
  createPubkeyAccount,
  Ed25519Signer,
  gasAmount,
  localnet,
  mainnet,
  MockTransport,
  networkHash,
  sha256Hash,
  type Transport,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import { createScenario, withScenario, type Scenario } from "./index.js";

function account(byte = 1) {
  return createPubkeyAccount({
    signer: Ed25519Signer.fromSeed(new Uint8Array(32).fill(byte)),
  });
}

function options(transport: Transport = new MockTransport()) {
  return {
    network: { cluster: localnet(), transport },
    accounts: { alice: account(), bob: account(2) },
  };
}

describe("attached scenarios", () => {
  it("binds distinct named wallets without funding or mutating the client", async () => {
    const transport = new MockTransport();
    const request = vi.spyOn(transport, "request");
    const config = options(transport);
    const value = await withScenario(config, async (scenario) => {
      expect(scenario.actor("alice").account).toBe(config.accounts.alice);
      expect(scenario.actor("bob").wallet.account).toBe(config.accounts.bob);
      expect(scenario.actor("alice")).toBe(scenario.actor("alice"));
      expect("account" in scenario.client).toBe(false);
      expect(await scenario.actor("alice").wallet.getBalance()).toMatchObject({
        address: config.accounts.alice.address,
      });
      expect(() => scenario.actor("missing" as "alice")).toThrow(
        "Unknown scenario actor",
      );
      return 42;
    });
    expect(value).toBe(42);
    expect(
      request.mock.calls.some(([method]) => method === "faucet_requestAirdrop"),
    ).toBe(false);
  });

  it("requires an expected network identity before contacting the endpoint", async () => {
    const transport = new MockTransport();
    const request = vi.spyOn(transport, "request");
    await expect(
      createScenario({
        network: { cluster: mainnet(), transport },
        accounts: { alice: account() },
      }),
    ).rejects.toThrow("expected networkHash");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a mismatched network before signing", async () => {
    const alice = account();
    const sign = vi.spyOn(alice.signers[0]!.signer, "sign");
    await expect(
      createScenario({
        network: {
          cluster: localnet({
            networkHash: networkHash(sha256Hash(new Uint8Array(32).fill(9))),
          }),
          transport: new MockTransport(),
        },
        accounts: { alice },
      }),
    ).rejects.toThrow(/network/i);
    expect(sign).not.toHaveBeenCalled();
  });

  it("validates actor names before discovery", async () => {
    const transport = new MockTransport();
    const request = vi.spyOn(transport, "request");
    await expect(
      createScenario({
        network: { cluster: localnet(), transport },
        accounts: { " alice ": account() },
      }),
    ).rejects.toThrow("Actor names");
    expect(request).not.toHaveBeenCalled();
  });

  it("closes after a failed callback and leaves the supplied transport usable", async () => {
    const transport = new MockTransport();
    const failure = new Error("assertion failed");
    let saved:
      | Scenario<ReturnType<typeof localnet>, "alice" | "bob">
      | undefined;
    await expect(
      withScenario(options(transport), async (scenario) => {
        saved = scenario;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(saved!.signal.aborted).toBe(true);
    await expect(saved!.client.getChainTip()).rejects.toThrow(
      "Scenario is closed",
    );
    await expect(transport.request("getChainTip")).resolves.toBeDefined();
    await saved!.close();
  });

  it("cancels an in-flight request and prevents dispatch through saved wallets", async () => {
    const mock = new MockTransport();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transport: Transport = {
      request(method, params, control) {
        if (method !== "getBalance")
          return mock.request(method, params, control);
        return new Promise((_, reject) => {
          control!.signal!.addEventListener(
            "abort",
            () => reject(control!.signal!.reason),
            { once: true },
          );
          started();
        });
      },
    };
    const request = vi.spyOn(transport, "request");
    const scenario = await createScenario(options(transport));
    const wallet = scenario.actor("alice").wallet;
    const pending = wallet.getBalance();
    const rejection = expect(pending).rejects.toThrow("Scenario is closed");
    await ready;
    await scenario.close();
    await rejection;
    const count = request.mock.calls.length;
    await expect(wallet.getBalance()).rejects.toThrow("Scenario is closed");
    expect(request).toHaveBeenCalledTimes(count);
  });

  it("combines per-request cancellation without closing other requests", async () => {
    await withScenario(options(), async (scenario) => {
      const reason = new Error("cancel this read");
      await expect(
        scenario.client.getChainTip({}, { signal: AbortSignal.abort(reason) }),
      ).rejects.toBe(reason);
      expect(scenario.signal.aborted).toBe(false);
      await expect(scenario.client.getChainTip()).resolves.toBeDefined();
    });
  });

  it("honors caller cancellation throughout the scenario lifetime", async () => {
    const controller = new AbortController();
    const config = options();
    const scenario = await createScenario({
      ...config,
      network: { ...config.network, signal: controller.signal },
    });
    controller.abort(new Error("test deadline"));
    expect(() => scenario.actor("alice")).toThrow("test deadline");
    await expect(scenario.client.getChainTip()).rejects.toThrow(
      "test deadline",
    );
    await scenario.close();
  });

  it("awaits the SDK evidence hook before broadcast and preserves its errors", async () => {
    const transport = new MockTransport();
    const request = vi.spyOn(transport, "request");
    const failure = new Error("evidence write failed");
    const onSigned = vi.fn(() => {
      throw failure;
    });
    await withScenario(
      { ...options(transport), onSigned },
      async (scenario) => {
        const alice = scenario.actor("alice");
        const operation = alice.wallet.executeAndWait({
          invocation: ERC20.v0_1.transfer.invocation(
            NATIVE_TOKEN_ADDRESS,
            gasAmount(500_000n),
            {
              receiver: scenario.actor("bob").account.address,
              amount: 1n,
            },
          ),
          gasLimit: gasAmount(1_000_000n),
        });
        // The client's wallet reports a failed signing hook as not submitted.
        await expect(operation).rejects.toMatchObject({
          code: "transactionNotSubmitted",
          transaction: { outcome: "notSubmitted", reason: "persistenceFailed" },
        });
        expect(onSigned).toHaveBeenCalledWith(
          "alice",
          expect.objectContaining({ transactionHash: expect.any(Uint8Array) }),
        );
        expect(
          request.mock.calls.some(([method]) => method === "sendTransaction"),
        ).toBe(false);
      },
    );
  });
});
