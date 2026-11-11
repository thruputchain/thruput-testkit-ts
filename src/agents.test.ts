import { expect, it, vi } from "vitest";
import {
  createPubkeyAccount,
  Ed25519Signer,
  localnet,
  MockTransport,
  gasAmount,
  deserializeSignedTransaction,
  TransactionObservationError,
  type Transport,
  type SubmissionEvidence,
} from "@thruputchain/client";
import { Counter } from "../tests/fixtures/counter.js";
import {
  AgentGroupError,
  withScenario,
  type Actor,
  type AgentContext,
} from "./index.js";

function config(transport: Transport = new MockTransport()) {
  const account = createPubkeyAccount({
    signer: Ed25519Signer.fromSeed(new Uint8Array(32).fill(5)),
  });
  return {
    network: { cluster: localnet(), transport },
    accounts: { alice: account, bob: account, extra: account },
  };
}

it("rejects duplicate and unknown agents before callbacks execute", async () => {
  await withScenario(config(), async (scenario) => {
    const run = vi.fn(async () => {});
    await expect(
      scenario.agents(
        [
          { name: "alice", run },
          { name: "alice", run },
        ],
        { seed: "test" },
      ),
    ).rejects.toThrow("Duplicate");
    await expect(
      scenario.agents([{ name: "missing" as "alice", run }], { seed: "test" }),
    ).rejects.toThrow("unknown");
    expect(run).not.toHaveBeenCalled();
  });
});

it("copies message ownership and coordinates one-shot barrier phases", async () => {
  await withScenario(config(), async (scenario) => {
    const entered: string[] = [];
    await scenario.agents<{ values: number[]; bytes: Uint8Array }>(
      [
        {
          name: "alice",
          async run(ctx) {
            const value = { values: [1], bytes: new Uint8Array([2]) };
            ctx.send("bob", value);
            value.values[0] = 99;
            value.bytes[0] = 99;
            entered.push("alice");
            await ctx.barrier("ready");
            expect(entered).toHaveLength(2);
            const reply = await ctx.receive();
            expect(reply.from).toBe("bob");
            expect(reply.value.values).toEqual([3]);
            expect(value.values).toEqual([99]);
            await ctx.barrier("done");
          },
        },
        {
          name: "bob",
          async run(ctx) {
            const received = await ctx.receive();
            expect(received.from).toBe("alice");
            expect(received.value.values).toEqual([1]);
            expect([...received.value.bytes]).toEqual([2]);
            received.value.values[0] = 3;
            ctx.send("alice", received.value);
            entered.push("bob");
            await ctx.barrier("ready");
            await ctx.barrier("done");
          },
        },
      ],
      { seed: "messages" },
    );
  });
});

it("retains stable random streams when unrelated actors are added", async () => {
  await withScenario(config(), async (scenario) => {
    const outputs: unknown[] = [];
    const alice = {
      name: "alice" as const,
      async run(
        ctx: AgentContext<
          ReturnType<typeof localnet>,
          "alice" | "bob" | "extra",
          never
        >,
      ) {
        outputs.push([
          ctx.random.next(),
          ctx.random.integer(7),
          ctx.random.bytes(40),
        ]);
      },
    };
    await scenario.agents([alice], { seed: "stable" });
    await scenario.agents(
      [
        {
          name: "extra",
          async run(ctx) {
            ctx.random.bytes(100);
          },
        },
        alice,
      ],
      { seed: "stable" },
    );
    expect(outputs[0]).toEqual(outputs[1]);
    await scenario.agents([alice], { seed: "changed" });
    expect(outputs[2]).not.toEqual(outputs[0]);
  });
});

it("cancels peer waits and scoped SDK wallets while preserving the parent scenario", async () => {
  await withScenario(config(), async (scenario) => {
    let saved: Actor | undefined;
    const failure = new Error("agent failed");
    await expect(
      scenario.agents<boolean>(
        [
          {
            name: "alice",
            async run(ctx) {
              saved = ctx.actor;
              ctx.send("bob", true);
              await ctx.receive();
            },
          },
          {
            name: "bob",
            async run(ctx) {
              await ctx.receive();
              throw failure;
            },
          },
        ],
        { seed: "fail" },
      ),
    ).rejects.toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ agent: "bob", cause: failure }),
      ]),
      unfinishedAgents: [],
    });
    await expect(saved!.wallet.getBalance()).rejects.toThrow();
    await expect(saved!.submit([])).rejects.toThrow();
    expect(scenario.signal.aborted).toBe(false);
    await scenario.client.getChainTip();
  });
});

it("bounds teardown when a callback ignores cancellation", async () => {
  await withScenario(config(), async (scenario) => {
    await expect(
      scenario.agents(
        [{ name: "alice", run: () => new Promise<void>(() => {}) }],
        { seed: "deadline", timeoutMs: 20, teardownTimeoutMs: 20 },
      ),
    ).rejects.toMatchObject({
      unfinishedAgents: ["alice"],
      errors: [expect.objectContaining({ operation: "deadline" })],
    });
  });
}, 1000);

it("identifies bounded receive failures and rejects shared memory messages", async () => {
  await withScenario(config(), async (scenario) => {
    await expect(
      scenario.agents(
        [
          {
            name: "alice",
            async run(ctx) {
              await ctx.receive({ timeoutMs: 5 });
            },
          },
        ],
        { seed: "receive" },
      ),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ agent: "alice", operation: "receive" }),
      ],
    });
    await expect(
      scenario.agents<SharedArrayBuffer>(
        [
          {
            name: "alice",
            async run(ctx) {
              ctx.send("alice", new SharedArrayBuffer(4));
            },
          },
        ],
        { seed: "shared" },
      ),
    ).rejects.toBeInstanceOf(AgentGroupError);
  });
});

it("reserves distinct identities for agents using aliases of one signer", async () => {
  const evidence: SubmissionEvidence[] = [];
  await withScenario(
    {
      ...config(),
      onSigned: (_, value) => {
        evidence.push(value);
      },
    },
    async (scenario) => {
      await scenario.agents(
        ["alice", "bob"].map((name) => ({
          name: name as "alice" | "bob",
          async run(ctx) {
            await ctx.barrier("submit");
            await ctx.actor.submit([
              Counter.v0_1.get.call({
                address: ctx.actor.account.address,
                gasLimit: gasAmount(500_000n),
              }),
            ]);
          },
        })),
        { seed: "parallel" },
      );
      expect(evidence).toHaveLength(2);
      expect(
        deserializeSignedTransaction(evidence[0]!.signedTransaction).tx
          .uniquifier.nonce,
      ).not.toBe(
        deserializeSignedTransaction(evidence[1]!.signedTransaction).tx
          .uniquifier.nonce,
      );
      expect(scenario.run.report().attempts).toHaveLength(2);
    },
  );
});

it("cancels an abandoned receive when its owner completes", async () => {
  await withScenario(config(), async (scenario) => {
    let abandoned: Promise<unknown> | undefined;
    await scenario.agents<boolean>(
      [
        {
          name: "alice",
          async run(ctx) {
            abandoned = ctx.receive().catch((error: unknown) => error);
            ctx.send("bob", true);
          },
        },
        {
          name: "bob",
          async run(ctx) {
            await ctx.receive();
            expect(await abandoned).toMatchObject({
              agent: "alice",
              operation: "receive",
            });
          },
        },
      ],
      { seed: "ownership" },
    );
  });
});

it("keeps timed-out barriers broken for late arrivals", async () => {
  await withScenario(config(), async (scenario) => {
    await scenario.agents<boolean>(
      [
        {
          name: "alice",
          async run(ctx) {
            await expect(
              ctx.barrier("phase", { timeoutMs: 5 }),
            ).rejects.toThrow("timed out");
            ctx.send("bob", true);
            await ctx.receive();
          },
        },
        {
          name: "bob",
          async run(ctx) {
            await ctx.receive();
            expect(() => ctx.barrier("phase")).toThrow("broken");
            ctx.send("alice", true);
          },
        },
      ],
      { seed: "barrier" },
    );
  });
});

it("bounds queued messages and propagates scenario closure", async () => {
  await withScenario(config(), async (scenario) => {
    await expect(
      scenario.agents<number>(
        [
          {
            name: "alice",
            async run(ctx) {
              ctx.send("alice", 1);
              ctx.send("alice", 2);
            },
          },
        ],
        { seed: "capacity", maxQueuedMessages: 1 },
      ),
    ).rejects.toMatchObject({
      errors: [expect.objectContaining({ operation: "send" })],
    });
    await expect(
      scenario.agents(
        [
          {
            name: "alice",
            async run(ctx) {
              const receive = ctx.receive();
              await scenario.close();
              await receive;
            },
          },
        ],
        { seed: "close" },
      ),
    ).rejects.toBeInstanceOf(AgentGroupError);
  });
});

it("preserves dispatched evidence after cancellation and observes it without resending", async () => {
  const mock = new MockTransport();
  const cancel = new AbortController();
  let sends = 0;
  let stopped = false;
  const transport: Transport = {
    async request(method, params, control) {
      if (method === "sendTransaction") sends++;
      if (method === "getTransactionReceipt" && !stopped) {
        stopped = true;
        cancel.abort(new Error("stop observation"));
        control?.signal?.throwIfAborted();
      }
      return mock.request(method, params, control) as never;
    },
  };
  await withScenario(config(transport), async (scenario) => {
    let evidence: SubmissionEvidence | undefined;
    await expect(
      scenario.agents(
        [
          {
            name: "alice",
            async run(ctx) {
              try {
                await ctx.actor.call([
                  Counter.v0_1.get.call({
                    address: ctx.actor.account.address,
                    gasLimit: gasAmount(500_000n),
                  }),
                ]);
              } catch (error) {
                expect(error).toBeInstanceOf(TransactionObservationError);
                evidence = (error as TransactionObservationError).submission;
                throw error;
              }
            },
          },
        ],
        { seed: "evidence", signal: cancel.signal },
      ),
    ).rejects.toBeInstanceOf(AgentGroupError);
    expect(scenario.run.report().attempts[0]!.state).toBe("signed");
    await scenario.observe(evidence!);
    expect(scenario.run.report().attempts[0]!.state).toBe("committed");
    expect(sends).toBe(1);
  });
});
