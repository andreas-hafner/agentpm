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
- `agentpm.yaml` is the committed project config. `.agentpmrc` is an optional local override or compatibility fallback.
- Project config sources support shorthands such as `skills.sh`, `skillshub.wtf`, `github:owner/repo`, `local:<path>`, and `registry:<url-or-path>`.
- `agentpm.yaml` skills can be string shorthand or detailed objects with `source`, `ref`, `revision`, `target`, `scope`, `items`, and `workspaceRoot`.
- `target` is the public project-config selector for native layouts (`codex`, `claude`, or `generic`); `adapter` remains a compatibility alias.
- `AgentPmService.resolveRuntimeContext()` builds global/project/temporary skill layers without creating project runtime folders.
- Project install/sync writes generated target paths to `.git/info/exclude` when a scope root is a Git repository.
- Source addition indexes installable entries immediately, and `agentpm refresh`, `agentpm search --refresh`, or `agentpm update --refresh` rebuild source indexes later.
- Adapter detection scans supported roots for marker files, so nested collections inside `skills/` can still be indexed and installed.
- Generic installs from plain `skills/` sources now target `.agents/skills/`; already-native `.agents/skills/` and `subagents/` roots are preserved.
- Adapter detection also recognizes `.codex.cloud/skills` and reports install scripts as risks without executing them.
- Git-backed remote operations that may require SSH or passphrase prompts run through an interactive runner, and `agentpm push` now discovers local native entries, preserves their target-relative layout in the destination repo, force-stages selected paths even when native dot-directories match Git ignore rules, supports interactive multi-select and push target default selection, and handles empty remotes without resolving `HEAD` first.
- Git cache directories use shortened hashed paths under `cache/repos/` so sparse clones stay within Windows path-length limits.
- Registry sources include the skills.sh API (auth required) and the SkillsHub API (skillshub.wtf, no auth, 1000-entry cap).
- Private HTTP registry indexes can use `AGENTPM_REGISTRY_TOKEN` or host-specific bearer tokens such as `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`.
- On first start (no sources in DB, TTY available), the CLI prompts to add SkillsHub as the default registry.
- `agentpm cache clean` removes unused repository caches without clearing active install caches or source catalog indexes, and `--dry-run` previews removals.
- `agentpm doctor` validates project config resolution, configured sources/skills, broken installs, cache state, local source paths, permissions, and tracked generated targets. `agentpm doctor --fix` plans and confirms safe removal of unreachable unused sources and stale install records.
