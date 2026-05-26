# Getting Started

## Requirements

- Node.js 24 LTS or newer
- Git

## Install

Install the published CLI globally:

```bash
npm install -g @travelhawk/agentpm
agentpm --help
```

For local AgentPM development, use pnpm 10 from the repository root:

```bash
pnpm install
pnpm build
```

No native dependencies are required. SQLite is provided by Node.js built-in `node:sqlite`.

## Validate

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm smoke
```

`pnpm smoke` builds the CLI and runs a temporary end-to-end project flow with an isolated `AGENTPM_HOME`.

## Try the CLI

With the published package installed:

```bash
agentpm source add examples/repos/codex-sample
agentpm inspect examples/repos/codex-sample
agentpm resolve
```

From a development checkout without a global install:

```bash
node apps/cli/dist/index.js source add examples/repos/codex-sample
node apps/cli/dist/index.js inspect examples/repos/codex-sample
node apps/cli/dist/index.js resolve
```

For isolated experiments, point AgentPM at a temp home:

```bash
AGENTPM_HOME=/tmp/agentpm-home node apps/cli/dist/index.js source list
```

## Project config

Use committed `agentpm.yaml` only when you want reproducible project setup:

```yaml
sources:
  - id: internal
    locator: git@github.com:company/private-skills.git
  - id: registry
    locator: registry:https://registry.example.com/agentpm/index.yaml
  - local:./examples/repos/codex-sample

skills:
  - audio-mastering

  - name: shared-review
    source: registry
    target: generic
    scope: workspace
    workspaceRoot: ..
    ref: main
    items:
      - review/checklists
```

String skills are shorthand. Object skills bind a stable project skill name to a configured source, optional Git ref or resolved revision, runtime target, install scope, and one or more native skill items. Use `target` for the runtime layout in `agentpm.yaml`; accepted MVP targets are `codex`, `claude`, and `generic`. `target` selects a matching native layout and does not convert one format into another.

By default, `agentpm install --project` and `agentpm install --workspace` stay local and do not create `agentpm.yaml`. Run `agentpm init` when you want to turn the current repo into a shared contract. After `agentpm.yaml` exists, project and workspace installs update it automatically.

Run `agentpm sync` after cloning a repository with `agentpm.yaml`. AgentPM restores the configured direct skills and records generated project targets in local Git exclude metadata so skill code, cache paths, and generated links do not need to be committed.

`.agentpmrc` is reserved for local-only overrides or compatibility fallback and should normally stay uncommitted.

Source entries may be full Git URLs or shorthands such as `github:owner/repo`, `local:~/skills`, and `registry:https://registry.example.com/agentpm/index.yaml`. Private HTTP registries can use `AGENTPM_REGISTRY_TOKEN` or host-specific bearer tokens such as `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`.

For public no-key discovery and import, use the skills.sh CLI bridge:

```bash
agentpm skills search typescript
agentpm skills install wshobson/agents@typescript-advanced-types --project
agentpm skills install typescript
```

Adding a source immediately rebuilds the local searchable index for that source. Use `agentpm refresh` to rebuild all configured source indexes later, or pass source ids or locators to refresh only selected sources. `agentpm search --refresh <query>` refreshes before searching when you expect new Git repository entries, and normal search prints a stale-index hint when no matches are found. `agentpm update --refresh` refreshes source indexes before showing the update preview.

If you want to inspect a private repo before adding it, use `agentpm source skills <repo-or-source>`. If you already know which repo you want, `agentpm install --from <repo-or-source>` can add the source, let you choose installable skills, and install them in one flow.

## Recommended flow

```bash
agentpm source add git@github.com:company/private-skills.git
agentpm source skills git@github.com:company/private-skills.git
agentpm skills search typescript
agentpm install --from github:company/private-skills --skill audio-mastering --project --add-source
agentpm source add registry:https://registry.example.com/agentpm/index.yaml
agentpm inspect git@github.com:company/private-skills.git --target codex
agentpm refresh
agentpm search audio --refresh
agentpm sync
agentpm update --refresh
agentpm resolve --json
agentpm cache clean --dry-run
agentpm doctor --fix
agentpm target add production git@github.com:company/pushed-skills.git --default
```

`agentpm update` first prints a dry-run preview and prompts before applying available updates, then prints a success summary for applied changes. `agentpm cache clean` removes unused Git checkout caches under `AGENTPM_HOME/cache/repos`; active install caches and the searchable source index are preserved. `agentpm doctor` checks malformed project config, unavailable sources, missing generated targets, broken links, missing cache entries, and generated skill folders that were accidentally committed to Git. `agentpm doctor --fix` lists each safe fix it intends to apply and asks for confirmation before removing unreachable unused sources or stale install records.
