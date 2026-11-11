import { transfer } from "./live-workflow.mjs";

const height = await transfer();
console.log(`Standalone scenario confirmed at block ${height}`);
