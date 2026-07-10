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
- Project config sources support shorthands such as bare `owner/repo`, `github:owner/repo`, `local:<path>`, and `registry:<url-or-path>`.
- `agentpm skills search` shells out to `npx skills find`, disables provider telemetry by default, parses provider selectors like `owner/repo@skill`, and the `skills install/list/update/remove` bridge commands reuse normal AgentPM install state while tagging provider-backed installs in metadata; `skills install <query>` can open an interactive picker, one-off direct repo installs do not have to persist a global source, and when `agentpm.yaml` exists AgentPM still persists the resolved source plus optional provider provenance so later `sync` does not need the bridge.
- `agentpm source skills` lists installable entries from a configured source or a direct repo locator, and `agentpm install --from <locator>` reuses the same service-layer selection flow for direct repo installs.
- `agentpm target add` accepts either `<id> <locator>` or a locator alone in interactive mode, then prompts for a target name with a repo-name default suggestion.
- `agentpm.yaml` skills can be string shorthand or detailed objects with `source`, `ref`, `revision`, `target`, `scope`, `items`, and `workspaceRoot`.
- `target` is the public project-config selector for native layouts (`codex`, `claude`, or `generic`); `adapter` remains a compatibility alias.
- `AgentPmService.resolveRuntimeContext()` builds global/project/temporary skill layers without creating project runtime folders.
- Project and workspace installs stay local by default when `agentpm.yaml` is absent; `agentpm init` is the explicit creation step, and later project/workspace installs update the existing `agentpm.yaml`.
- Project install/sync writes generated target paths to `.git/info/exclude` when a scope root is a Git repository.
- Source addition indexes installable entries immediately, and `agentpm refresh`, `agentpm search --refresh`, `agentpm source skills --refresh`, or `agentpm update --refresh` rebuild source indexes later.
- Adapter detection scans supported roots for marker files, so nested collections inside `skills/` can still be indexed and installed.
- Generic installs from plain `skills/` sources now target `.agents/skills/`; already-native `.agents/skills/` and `subagents/` roots are preserved.
- Adapter detection also recognizes `.codex.cloud/skills` and reports install scripts as risks without executing them.
- Git-backed remote operations that may require SSH or passphrase prompts run through an interactive runner, and `agentpm push` now discovers local native entries, preserves their target-relative layout in the destination repo, resolves push targets from global config, force-stages selected paths even when native dot-directories match Git ignore rules, supports interactive multi-select and push target default selection, and handles empty remotes without resolving `HEAD` first.
- Git-backed source clones run quietly, and `agentpm push` reports user-facing progress while reusing a cached target checkout instead of recloning the destination on every push.
- Git cache directories use shortened hashed paths under `cache/repos/` so sparse clones stay within Windows path-length limits, and Git-backed source indexing now reuses that cache when it can do so without mutating an active sparse install checkout.
- Registry sources are static local or HTTP YAML/JSON indexes.
- Private HTTP registry indexes can use `AGENTPM_REGISTRY_TOKEN` or host-specific bearer tokens such as `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`.
- `agentpm cache clean` removes unused repository caches without clearing active install caches or source catalog indexes, and `--dry-run` previews removals.
- Skills follow a canonical + transform model: a canonical local skill library lives at `skillsLibraryDir` (`~/.agentpm/skills/`, resolved in `@agentpm/config`), and every agent's native skill directory is a symlink back to a single library entry. The `skill` kind installs into the chosen agent's native root (`.codex/skills`, `.claude/skills`, `.agents/skills`) regardless of source layout, preserving any nested collection sub-path; `agent`/`subagent` kinds keep selector/passthrough behavior. `nativeSkillRoot()` in `@agentpm/adapters` is the per-agent root map.
- `agentpm push` normalizes pushed entries to a canonical `skills/<name>` folder by default; `--preserve-layout` keeps native target-relative paths, and canonical destination collisions now abort instead of silently dropping one variant.
- `agentpm pull` (`AgentPmService.pull`) clones the canonical push target, copies its `skills/*` into the library, auto-detects installed agents (`.codex`/`.claude`/`.agents`), multi-selects (default all) via `prompts.selectMany`, and symlinks each chosen agent's native skill dir to the shared library entry (one install record per agent). Defaults to global scope (home agent dirs); `--project` uses cwd. A repo with no `skills/*` but with `agent`-kind entries still pulls successfully (the agent-target prompt is skipped when there are no skills to fan out).
- `agentpm push` also discovers flat `.claude/agents/<name>.md` files (in addition to marker-directory agents) via `DetectedEntry.entryType === 'file'` (`@agentpm/shared`, set by `@agentpm/adapters`'s `detectGroupsForLayout`); `pushToGit`/`copyTreeInto` in `packages/core/src/service.ts` stat the source first and copy a single file when it is not a directory.
- `agentpm pull` (`AgentPmService.pull`) additionally materializes every detected `agent`-kind entry via `materializeAgents()` in `packages/core/src/agent-materializer.ts`: each entry is **copied** (not symlinked) into `<scopeRoot>/.claude/agents/<basename>` and recorded with `db.saveInstall` against a `src_git_<locator>`-keyed source row (same id formula as `AgentPmService.ensureSource`, so it reuses the row created for skills from the same repo). Controlled by `PullOptions.includeAgents` (default `true`, CLI `--no-agents`) and returned as `PullResult.agents` (names). `PullOptions.transform === 'codex-agents'` (CLI `--transform codex-agents`) additionally runs `transformClaudeAgentToCodexToml()` (`@agentpm/adapters`, pure, `js-yaml` frontmatter parsing, hand-rolled TOML emission) on each flat agent entry and writes `<scopeRoot>/.codex/agents/<snake_case-name>.toml`; a pre-existing file is only overwritten when it starts with the `# generated by agentpm from` marker comment, otherwise the transform is skipped with a warning.
- `agentpm adopt` (`AgentPmService.adopt`) moves an existing local skill into the library, replaces the origin with a managed symlink, and fans it out to the other agents the same way as pull; if the library already has a different skill with the same name, adopt now aborts before deleting local content. If the origin is already `skillsLibraryDir/<name>`, adopt treats it as a canonical library entry and only links it into selected global agents, avoiding a self-link over the library copy. Both reuse `ensureManagedLink`, `recordGeneratedTargetInLocalGitExclude`, and a backing source row via `db.upsertSource` (installs require a non-null `source_id`).
- `agentpm remove` and `agentpm skills remove` can disambiguate duplicate install names non-interactively with `--target`, `--scope`, or `--path`; without filters, duplicate names still use the interactive picker when available and otherwise fail with the matching target paths.
- `agentpm doctor` validates project config resolution, configured sources/skills, broken installs, cache state, local source paths, permissions, and tracked generated targets. `agentpm doctor --fix` plans and confirms safe removal of unreachable unused sources and stale install records.
- `agentpm export <layout> --dest <dir>` (`AgentPmService.export` -> `exportLayout()` in `packages/core/src/exporter.ts`) materializes the skill library and managed agent installs into a destination directory using a named layout, keyed in a simple `LAYOUTS` registry map so more layouts can be added later. The only layout, `antigravity`, writes each library skill's `SKILL.md` to `<dest>/templates/skills/<name>/SKILL.md` (`--skills a,b` limits selection, default all) plus a **relative** symlink `<dest>/skills/<name>/SKILL.md -> ../../templates/skills/<name>/SKILL.md`; a pre-existing regular (non-symlink) file at that path is left untouched and reported as a warning, unless its content matches the current skill source (no-op) or the previous template content (recognized as a stale copy-fallback and refreshed). If creating the symlink fails with `EPERM`/`EACCES` (e.g. Windows without Developer Mode), the exporter writes a plain copy instead and reports a warning. Unless `--no-agents`, it also reads every `claude`/global-scope agent install with `metadata.agent === true` (the ones `materializeAgents()` created), strips YAML frontmatter via the now-shared `parseFrontmatter()` (`packages/adapters/src/transforms/frontmatter.ts`, also used by the Codex agent transform), and writes the body to `<dest>/agents/<slugified-frontmatter-name>.md`. `--install` spawns `agy plugin install <dest>` with the service's merged env (stdio inherited); a missing `agy` binary on `PATH` is reported as a warning without failing the command.
- `agentpm deploy [--config <path>] [--dry-run] [--json]` (`AgentPmService.deploy` -> `packages/core/src/deployer.ts`) replaces per-machine shell deploy scripts with one declarative, cross-platform `deploy.yaml`. `deployer.ts` owns YAML parsing/validation (unknown-key errors name the key and list/entry index) and the filesystem-only `base`/`consistency`/`instructions` steps; `service.ts`'s thin `deploy()` sequences those plus its own `pull()`/`export()` for the `pull`/`export` sections, in the fixed order `base` -> `consistency` -> `instructions` -> `pull` -> `export`. All relative config paths resolve against the YAML file's directory (not `cwd`); `~/` expands via `os.homedir()`. `base` entries copy a file or (non-recursively) the files directly inside a directory, `mode: always` diffs content and backs up the previous `dest` (default on) before overwriting, `mode: if-missing` only writes when `dest` is absent; `instructions` entries concatenate `header` + each `sources` file + `footer` (blank-line separated, no injected timestamps, byte-stable across runs) the same way `base`/`always` does, backup included. Backups land in `~/.agentpm/backups/deploy-<ISO-ts>/` (colons replaced with `-` for Windows) under `AGENTPM_HOME`, mirroring the destination's absolute path so a run's backups never collide. `consistency.library-vs` compares every `~/.agentpm/skills/<name>/SKILL.md` against `<checkout-dir>/skills/<name>/SKILL.md` and aborts the whole deploy on any mismatch. `export` entries support `optional: true` to skip (recorded in `skipped`, not `actions`) when `dest` does not already exist, for runtime-specific plugin dirs machines may not have. `--dry-run` reports every planned action (including per-file `base` decisions) without touching the filesystem or invoking `pull`/`export`. Result shape: `{ success, configPath, dryRun, actions: string[], warnings: string[], skipped: string[] }`, wrapped in the usual `{ ok, action }` CLI JSON envelope.
