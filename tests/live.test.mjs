import { test } from "node:test";
import { transfer } from "./live-workflow.mjs";

test(
  "packed testkit calls and reads a generated binding on a local node",
  { timeout: 70_000 },
  transfer,
);
