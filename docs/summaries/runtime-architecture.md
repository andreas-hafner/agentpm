# Runtime Architecture

## Responsibility

Summarizes the runtime package split and the main command execution flow.

## Key Files

- `apps/cli/src/index.ts`
- `packages/core/src/index.ts`
- `packages/config/src/index.ts`
- `packages/adapters/src/index.ts`
- `packages/git/src/index.ts`
- `packages/db/src/index.ts`
- `packages/registry/src/index.ts`
- `packages/shared/src/index.ts`

## Entry Points

- `agentpm` CLI binary
- `AgentPmService` orchestration layer

## Dependencies

- Commander.js
- simple-git
- Ink

## Notes

- The CLI stays thin and delegates behavior to `packages/core`.
- Native layout preservation is the default install strategy.
- Public no-key discovery lives in a provider bridge under `packages/core`, not in `packages/registry`.
- `agentpm.yaml` is an optional committed project config that enables shared contract mode. `.agentpmrc` is an optional local override or compatibility fallback.
- Project config sources support shorthands such as `skills.sh`, `github:owner/repo`, `local:<path>`, and `registry:<url-or-path>`.
- `agentpm skills search` shells out to `npx skills find`, disables provider telemetry by default, parses provider selectors like `owner/repo@skill`, and the `skills install/list/update/remove` bridge commands reuse normal AgentPM install state while tagging provider-backed installs in metadata; when `agentpm.yaml` exists they also persist the resolved source plus optional provider provenance so later `sync` does not need the bridge.
- `agentpm source skills` lists installable entries from a configured source or a direct repo locator, and `agentpm install --from <locator>` reuses the same service-layer selection flow for direct repo installs.
- `agentpm.yaml` skills can be string shorthand or detailed objects with `source`, `ref`, `revision`, `target`, `scope`, `items`, and `workspaceRoot`.
- `target` is the public project-config selector for native layouts (`codex`, `claude`, or `generic`); `adapter` remains a compatibility alias.
- `AgentPmService.resolveRuntimeContext()` builds global/project/temporary skill layers without creating project runtime folders.
- Project and workspace installs stay local by default when `agentpm.yaml` is absent; `agentpm init` is the explicit creation step, and later project/workspace installs update the existing `agentpm.yaml`.
- Project install/sync writes generated target paths to `.git/info/exclude` when a scope root is a Git repository.
- Source addition indexes installable entries immediately, and `agentpm refresh`, `agentpm search --refresh`, `agentpm source skills --refresh`, or `agentpm update --refresh` rebuild source indexes later.
- Adapter detection scans supported roots for marker files, so nested collections inside `skills/` can still be indexed and installed.
- Generic installs from plain `skills/` sources now target `.agents/skills/`; already-native `.agents/skills/` and `subagents/` roots are preserved.
- Adapter detection also recognizes `.codex.cloud/skills` and reports install scripts as risks without executing them.
- Git-backed remote operations that may require SSH or passphrase prompts run through an interactive runner, and `agentpm push` now discovers local native entries, preserves their target-relative layout in the destination repo, force-stages selected paths even when native dot-directories match Git ignore rules, supports interactive multi-select and push target default selection, and handles empty remotes without resolving `HEAD` first.
- Git-backed source clones run quietly, and `agentpm push` reports user-facing progress while reusing a cached target checkout instead of recloning the destination on every push.
- Git cache directories use shortened hashed paths under `cache/repos/` so sparse clones stay within Windows path-length limits, and Git-backed source indexing now reuses that cache when it can do so without mutating an active sparse install checkout.
- Registry sources include the skills.sh API (auth required) plus static local or HTTP YAML/JSON indexes.
- The no-key public `skills.sh` path is the CLI bridge, not the native registry loader.
- Private HTTP registry indexes can use `AGENTPM_REGISTRY_TOKEN` or host-specific bearer tokens such as `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`.
- On first start with no configured sources, the CLI can prompt to add `skills.sh` as the default registry when `SKILLS_SH_API_KEY` or `SKILLS_API_KEY` is already configured.
- `agentpm cache clean` removes unused repository caches without clearing active install caches or source catalog indexes, and `--dry-run` previews removals.
- `agentpm doctor` validates project config resolution, configured sources/skills, broken installs, cache state, local source paths, permissions, and tracked generated targets. `agentpm doctor --fix` plans and confirms safe removal of unreachable unused sources and stale install records.
