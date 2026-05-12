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
```

## Try the CLI

```bash
node apps/cli/dist/index.js source add examples/repos/codex-sample
node apps/cli/dist/index.js inspect examples/repos/codex-sample
```

For isolated experiments, point AgentPM at a temp home:

```bash
AGENTPM_HOME=/tmp/agentpm-home node apps/cli/dist/index.js source list
```

