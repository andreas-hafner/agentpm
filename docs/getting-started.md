# Getting Started

## Requirements

- Node.js 24 LTS or newer
- pnpm 10
- Git

## Install

```bash
pnpm install
```

If pnpm blocks native postinstall scripts, `better-sqlite3` will not build and AgentPM will fail at runtime. In that case:

```bash
pnpm config set ignore-scripts false
cd node_modules/.pnpm/better-sqlite3@12.9.0/node_modules/better-sqlite3
npm run build-release
cd ../../../../../
```

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

