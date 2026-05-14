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
  - local:./examples/repos/codex-sample
scope: project
skills:
  - audio-mastering
```

Run `agentpm sync` after cloning a repository with `agentpm.yaml`. AgentPM restores the configured skills and records generated project targets in local Git exclude metadata so skill code, cache paths, and generated links do not need to be committed.

`.agentpmrc` is reserved for local-only overrides or compatibility fallback and should normally stay uncommitted.

Source entries may be full Git URLs or shorthands such as `skills.sh`, `github:owner/repo`, `local:~/skills`, and `registry:https://registry.example.com/agentpm/index.yaml`. Private HTTP registries can use `AGENTPM_REGISTRY_TOKEN` or host-specific bearer tokens such as `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`.
