# Getting Started

## Requirements

- Node.js 24 LTS or newer
- pnpm 10
- Git

## Install

```bash
pnpm install
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

Use committed `agentpm.yaml` for reproducible project setup:

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

Run `agentpm sync` after cloning a repository with `agentpm.yaml`. AgentPM restores the configured direct skills and records generated project targets in local Git exclude metadata so skill code, cache paths, and generated links do not need to be committed.

`.agentpmrc` is reserved for local-only overrides or compatibility fallback and should normally stay uncommitted.

Source entries may be full Git URLs or shorthands such as `skills.sh`, `github:owner/repo`, `local:~/skills`, and `registry:https://registry.example.com/agentpm/index.yaml`. Private HTTP registries can use `AGENTPM_REGISTRY_TOKEN` or host-specific bearer tokens such as `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`.

Adding a source immediately rebuilds the local searchable index for that source. Use `agentpm refresh` to rebuild all configured source indexes later, or pass source ids or locators to refresh only selected sources. `agentpm update --refresh` refreshes source indexes before showing the update preview.

## Recommended flow

```bash
agentpm source add git@github.com:company/private-skills.git
agentpm source add registry:https://registry.example.com/agentpm/index.yaml
agentpm inspect git@github.com:company/private-skills.git --target codex
agentpm refresh
agentpm sync
agentpm update --refresh
agentpm resolve --json
agentpm cache clean
agentpm doctor --fix
```

`agentpm update` first prints a dry-run preview and prompts before applying available updates. `agentpm doctor` checks malformed project config, unavailable sources, missing generated targets, broken links, missing cache entries, and generated skill folders that were accidentally committed to Git. `agentpm doctor --fix` lists each safe fix it intends to apply and asks for confirmation before removing unreachable unused sources.
