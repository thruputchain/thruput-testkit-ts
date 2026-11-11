import { deploymentWorkflow } from "./operations-workflow.mjs";

console.log(
  `Typed deployment workflow confirmed at block ${await deploymentWorkflow()}`,
);
