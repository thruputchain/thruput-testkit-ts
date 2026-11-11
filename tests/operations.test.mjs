import { test } from "node:test";
import { deploymentWorkflow } from "./operations-workflow.mjs";

test(
  "packed helpers deploy, initialize, call, read, and resume observation",
  { timeout: 120_000 },
  deploymentWorkflow,
);
