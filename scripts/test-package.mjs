import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "thruput-testkit-package-"));
const live = process.argv.includes("--live");
const managed = process.argv.includes("--managed");

async function run(command, args, cwd = work) {
  const result = await exec(command, args, {
    cwd,
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

async function pack(directory) {
  const { stdout } = await exec(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", work],
    { cwd: directory },
  );
  return JSON.parse(stdout)[0];
}

try {
  // Install the tarball outside the checkout with the published SDK. Source
  // imports cannot hide an incorrect exports map or missing dependency.
  const testkit = await pack(root);
  assert.ok(testkit.files.some(({ path }) => path === "dist/index.d.ts"));
  assert.ok(testkit.files.some(({ path }) => path === "LICENSE"));
  assert.ok(
    testkit.files.every(
      ({ path }) => !path.startsWith("src/") && !path.startsWith("tests/"),
    ),
  );
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(
    join(work, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@thruputchain/client": pkg.dependencies["@thruputchain/client"],
        "@thruputchain/testkit": `file:./${testkit.filename}`,
        "@thruputchain/protocol": pkg.devDependencies["@thruputchain/protocol"],
        "@thruputchain/contract-spec":
          pkg.devDependencies["@thruputchain/contract-spec"],
        "@types/node": pkg.devDependencies["@types/node"],
        tsx: pkg.devDependencies.tsx,
      },
    }),
  );
  await run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.npmjs.org",
  ]);
  await cp(join(root, "tests"), work, { recursive: true });
  await cp(join(root, "examples"), join(work, "examples"), { recursive: true });
  await writeFile(
    join(work, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: false,
        noEmit: true,
        types: ["node"],
      },
      files: ["consumer.ts"],
      include: ["examples/**/*.ts"],
    }),
  );
  await run(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.json",
  ]);
  await run(process.execPath, ["consumer-smoke.mjs"]);
  await run(process.execPath, ["--test", "interruption.test.mjs"]);
  if (live) {
    assert.ok(process.env.THRUPUT_RPC_URL, "--live requires THRUPUT_RPC_URL");
    await run(process.execPath, ["--test", "live.test.mjs"]);
    await run(process.execPath, ["live-script.mjs"]);
  }
  if (managed) {
    await run(process.execPath, [
      join(root, "node_modules/typescript/bin/tsc"),
      "--ignoreConfig",
      "fixtures/counter.ts",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--outDir",
      "generated",
      "--strict",
    ]);
    await run(process.execPath, [
      "--test",
      "managed.test.mjs",
      "operations.test.mjs",
      "run.test.mjs",
      "agents.test.mjs",
      "examples.test.mjs",
    ]);
    await run(process.execPath, ["operations-script.mjs"]);
  }
  console.log(
    `Packed testkit checks passed${live ? " (including real-node test and script)" : ""}${managed ? " (including managed fixtures)" : ""}.`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
