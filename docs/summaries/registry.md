# Registry

## Responsibility

Loads and parses static registry index files (JSON/YAML).

## Key Files

- `packages/registry/src/index.ts`

## Entry Points

- `loadRegistryIndex(locator)` — dispatched from `packages/core` during `reindexSource`

## Dependencies

- js-yaml
- @agentpm/fs (pathExists, readTextFile)
- @agentpm/shared (AgentPmError, types, isHttpUrl)

## Notes

- Supports static registry files (local .json/.yaml files or HTTP URLs serving them), including `registry:<url-or-path>` source shorthands. Registry indexes are rebuilt on source add and refresh.
- Registry entries prefer `target` for the native runtime layout and still accept `adapterHint` as a compatibility alias.
- The no-key public `skills.sh` path is not handled here; it lives in the provider bridge under `packages/core`.
- HTTP requests use `node:https` (not `fetch()`) to avoid a libuv handle cleanup assert on Windows (Node.js v25.x).
- The `readRegistryLocator` function fetches remote registry content via `httpsGet`.
- Private HTTP registry indexes can use `AGENTPM_REGISTRY_TOKEN` or host-specific bearer tokens such as `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`.
