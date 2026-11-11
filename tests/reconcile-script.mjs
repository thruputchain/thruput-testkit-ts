import { createThruputClient, localnet } from "@thruputchain/client";
import { reconcileRun } from "@thruputchain/testkit";

const client = await createThruputClient({
  cluster: localnet({ rpcUrl: process.argv[3] }),
});
const result = await reconcileRun(process.argv[2], client);
console.log(
  JSON.stringify(
    result.observations.map((item) => ({
      hash: item.transactionHash,
      committed: item.receipt !== null,
    })),
  ),
);
