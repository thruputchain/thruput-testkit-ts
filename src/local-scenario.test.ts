import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  checkCliVersion,
  checkWireFormat,
  createLocalScenario,
  parseDefaultDevnode,
  withLocalScenario,
  LOCAL_RUNTIME,
} from "./local-scenario.js";
import { createScenario } from "./scenario.js";

vi.mock("./scenario.js", () => ({
  createScenario: vi.fn(async (options) => ({
    signal: options.network.signal,
    actor: (name: string) => ({ account: options.accounts[name] }),
    client: {
      getVersionInfo: async () => ({
        implementation: "0.48.0",
        wireFormat: "14.7.0",
      }),
    },
    close: async () => {},
  })),
}));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "testkit-unit-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function config(mode = "ready", version = "0.48.0", devnode = "0.1.37") {
  const cli = join(root, `cli-${mode}`);
  await writeFile(
    cli,
    `#!/usr/bin/env node
const {writeFileSync} = require('node:fs');
const {spawn} = require('node:child_process');
const {createServer} = require('node:http');
if (process.argv.includes('--version')) { console.log('thruput ${version}'); process.exit(0); }
if (process.argv.includes('list')) { console.log(JSON.stringify({ok:true,command:'toolchain.list',data:{defaultVersion:'${devnode}'}})); process.exit(0); }
if (process.argv.includes('install')) process.exit(0);
writeFileSync('node-args.json', JSON.stringify(process.argv.slice(2)));
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {stdio:'ignore'});
writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));
if ('${mode}' === 'fail') process.exit(1);
if ('${mode}' === 'hang') setInterval(()=>{},1000);
else {
 const server = createServer((q,r)=>r.end('{}'));
 server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ok:true,command:'node',data:{schemaVersion:5,rpcUrl:'http://127.0.0.1:'+server.address().port}})));
}
`,
    { mode: 0o700 },
  );
  return {
    cli,
    seed: "seed",
    accounts: { alice: { initialStorageTokens: 10n } },
    directory: root,
    keepDirectory: true,
  };
}

async function assertStopped(directory: string) {
  const pids: number[] = JSON.parse(
    await readFile(join(directory, "pids.json"), "utf8"),
  );
  for (const pid of pids) {
    // A reparented child can briefly remain a zombie until PID 1 reaps it.
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    expect(stat === "" || stat.split(") ")[1]?.startsWith("Z ")).toBe(true);
  }
}

it.skipIf(process.platform !== "linux")(
  "isolates concurrent nodes and reaps descendants on close",
  async () => {
    const options = await config();
    const fixtures = await Promise.all([
      createLocalScenario(options),
      createLocalScenario(options),
    ]);
    try {
      expect(fixtures[0]!.local.rpcUrl).not.toBe(fixtures[1]!.local.rpcUrl);
      expect(fixtures[0]!.local.directory).not.toBe(
        fixtures[1]!.local.directory,
      );
      expect(fixtures[0]!.actor("alice").account.address).toEqual(
        fixtures[1]!.actor("alice").account.address,
      );
    } finally {
      await Promise.all(fixtures.map((fixture) => fixture.close()));
    }
    for (const fixture of fixtures) {
      await fixture.close();
      await assertStopped(fixture.local.directory);
    }
  },
  15000,
);

it.skipIf(process.platform !== "linux")(
  "cleans up after a callback failure",
  async () => {
    let directory = "";
    const failure = new Error("assertion failed");
    await expect(
      withLocalScenario(await config(), async (scenario) => {
        directory = scenario.local.directory;
        throw failure;
      }),
    ).rejects.toBe(failure);
    await assertStopped(directory);
  },
  15000,
);

it.skipIf(process.platform !== "linux").each(["fail", "hang"])(
  "cleans up startup %s including orphan children",
  async (mode) => {
    await expect(
      createLocalScenario({ ...(await config(mode)), startupTimeoutMs: 1000 }),
    ).rejects.toThrow("startup failed");
    const directory = (await readdir(root)).find((name) =>
      name.startsWith("thruput-testkit-"),
    )!;
    await assertStopped(join(root, directory));
  },
  15000,
);

it.skipIf(process.platform !== "linux")(
  "cancellation closes a ready node without waiting for user work",
  async () => {
    const controller = new AbortController();
    const fixture = await createLocalScenario({
      ...(await config()),
      signal: controller.signal,
    });
    controller.abort(new Error("cancelled"));
    expect(fixture.signal.aborted).toBe(true);
    await fixture.close();
    await assertStopped(fixture.local.directory);
  },
  15000,
);

it.skipIf(process.platform !== "linux")(
  "removes temporary files by default",
  async () => {
    const fixture = await createLocalScenario({
      ...(await config()),
      keepDirectory: false,
    });
    await fixture.close();
    await expect(
      readFile(join(fixture.local.directory, "allocations.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
  15000,
);

it("rejects unsupported platforms and controls clearly", async () => {
  const options = { seed: "seed", accounts: {} };
  vi.stubGlobal("process", { ...process, platform: "win32" });
  try {
    await expect(createLocalScenario(options)).rejects.toThrow("Linux");
  } finally {
    vi.unstubAllGlobals();
  }
  if (process.platform === "linux")
    await expect(
      createLocalScenario({ ...options, blockDriver: "manual" as "instant" }),
    ).rejects.toThrow("Unsupported block driver");
});

it("keeps public runtime pins aligned with integration qualification", async () => {
  expect(LOCAL_RUNTIME).toEqual(
    JSON.parse(
      await readFile(
        new URL("../scripts/integration-versions.json", import.meta.url),
        "utf8",
      ),
    ),
  );
});

it.skipIf(process.platform !== "linux")(
  "rejects an incompatible CLI before starting a node",
  async () => {
    const options = await config();
    await writeFile(options.cli, '#!/bin/sh\necho "thruput 0.1.0"\n', {
      mode: 0o700,
    });
    await expect(createLocalScenario(options)).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("older than the qualified"),
      }),
    });
  },
);

it("accepts the qualified CLI or newer, and rejects older versions", () => {
  expect(checkCliVersion("thruput 0.48.0 (commit 61ddf183)\n")).toEqual({
    version: "0.48.0",
    qualified: true,
  });
  // Patch releases are qualified; newer minor and major versions are not.
  expect(checkCliVersion("thruput 0.48.3").qualified).toBe(true);
  expect(checkCliVersion("thruput 0.49.0").qualified).toBe(false);
  expect(checkCliVersion("thruput 1.0.0").qualified).toBe(false);
  expect(() => checkCliVersion("thruput 0.47.9")).toThrow(
    "older than the qualified 0.48.0",
  );
  expect(() => checkCliVersion("hogd 0.48.0")).toThrow("Unrecognized");
});

it("reads the CLI's devnode and checks the wire-format major version", () => {
  expect(
    parseDefaultDevnode(
      JSON.stringify({ ok: true, data: { defaultVersion: "0.1.37" } }),
    ),
  ).toBe("0.1.37");
  expect(() => parseDefaultDevnode(JSON.stringify({ ok: false }))).toThrow(
    "default devnode",
  );
  expect(() => checkWireFormat("14.9.1")).not.toThrow();
  expect(() => checkWireFormat("15.0.0")).toThrow("supports 14.x");
});

it.skipIf(process.platform !== "linux")(
  "starts a newer CLI with its own devnode and emits a warning",
  async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const close = vi.fn(async () => {});
    vi.mocked(createScenario).mockImplementationOnce(async (options) => ({
      ...({} as Awaited<ReturnType<typeof createScenario>>),
      signal: options.network.signal!,
      client: {
        getVersionInfo: async () => ({
          implementation: "0.49.0",
          wireFormat: "14.8.0",
        }),
      } as unknown as Awaited<ReturnType<typeof createScenario>>["client"],
      close,
    }));
    try {
      const scenario = await createLocalScenario(
        await config("ready", "0.49.0", "0.1.38"),
      );
      await scenario.close();
      expect(scenario.local.runtime).toEqual({
        cli: "0.49.0",
        devnode: "0.1.38",
        wireFormat: "14.8.0",
      });
      // The node runs the CLI's own devnode, not the qualified one.
      const args: string[] = JSON.parse(
        await readFile(
          join(scenario.local.directory, "node-args.json"),
          "utf8",
        ),
      );
      expect(args[args.indexOf("--hog-devnode-version") + 1]).toBe("0.1.38");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "CLI 0.49.0 with devnode 0.1.38 is not the qualified",
        ),
        { code: "THRUPUT_TESTKIT_UNQUALIFIED_CLI" },
      );
    } finally {
      warn.mockRestore();
    }
  },
  15000,
);

it.skipIf(process.platform !== "linux")(
  "cleans up when SDK network discovery fails",
  async () => {
    const mismatch = new Error("network mismatch");
    vi.mocked(createScenario).mockRejectedValueOnce(mismatch);
    await expect(createLocalScenario(await config())).rejects.toMatchObject({
      cause: mismatch,
    });
    const directory = (await readdir(root)).find((name) =>
      name.startsWith("thruput-testkit-"),
    )!;
    await assertStopped(join(root, directory));
  },
  15000,
);
