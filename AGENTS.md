# Repository guide

## Purpose

`@thruputchain/testkit` runs Thruput application scenarios from Node.js tests and scripts. It consumes the published TypeScript client and supported CLI interfaces. Keep general wallet, transaction, and codec improvements in the SDK.

## Setup and checks

- Use npm and the checked-in `package-lock.json`. Develop with Node 24 (`.nvmrc`). The runtime floor is Node 22.12.0.
- Dependencies install anonymously from the public npm registry.
- Run `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:package` before review.
- `test:package` installs a tarball outside the checkout with the published SDK. It checks strict consumer types and ESM/CommonJS behavior. Build first.
- `npm run test:integration` uses Linux and the exact CLI/devnode pins in `scripts/integration-versions.json`. It starts an isolated test node and runs the same packed-package workflow as a test and a standalone script.
- Use `THRUPUT_RPC_URL=... npm run test:package -- --live` to check a node that is already running. This local smoke creates fresh accounts and requests faucet funds.

## Structure

- `src/`: public API and focused unit tests. `src/index.ts` is the export boundary.
- `tests/`: installed-consumer type checks, ESM/CommonJS smoke, and the real-node workflow.
- `scripts/`: packaging and internal integration-test infrastructure.
- `README.md`: current public API, lifecycle, prerequisites, and feature map.
- `dist/`: generated package output. Do not edit it.

Use public package imports from `@thruputchain/client`. Do not depend on sibling repositories, private SDK source paths, or generated bindings edited by hand. Use `.js` specifiers for local TypeScript imports.

The integration harness was adapted from the SDK harness. It is internal qualification infrastructure. The public managed-network API is in `src/local-scenario.ts`. Keep runtime identity checks and process-tree cleanup in both paths. Keep `LOCAL_RUNTIME` aligned with `scripts/integration-versions.json`.

## Behavior

- Validate the expected network before signing. Funding and storage allocations are explicit.
- Preserve SDK errors and original signed evidence. An uncertain outcome never authorizes another transaction.
- Carry confirmed-height requirements into dependent reads.
- Keep lifecycle ownership explicit. Closing an attached scenario leaves the external node running.
- Keep docs short and close to the API. Add advanced features when their workstream issue calls for them.

## Review and release

GH-608 tracks the workstream. GH-612, GH-610, and GH-616 are complete and committed; GH-615 is blocked on a supported external manual-block control interface. GH-614's generated API documentation is approved for implementation. Use TypeDoc with source comments and generated output in docs/api/; do not add custom documentation files. Consumer migration and publication require separate approval.

Commit, push, publish, or create a remote repository only when requested. Live CI is opt-in and requires this repository to have access to the configured runtime runner.
