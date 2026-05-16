# Developer Workflow

## Responsibility

Summarizes the repo tooling, validation workflow, and documentation expectations.

## Key Files

- `package.json`
- `turbo.json`
- `tsconfig.json`
- `vitest.config.ts`
- `AGENTS.md`

## Entry Points

- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm smoke`

## Dependencies

- pnpm workspaces
- Turborepo
- TypeScript
- ESLint
- Prettier
- Vitest

## Notes

- Update summaries alongside major package changes.
- Prefer manual CLI checks plus automated tests for user-facing flows.
- `pnpm smoke` builds the workspace and exercises the packaged CLI against fixture repositories with an isolated `AGENTPM_HOME`, including a detailed registry-backed `agentpm.yaml` skill object pinned to a Git revision.
- Package builds use local `tsconfig.build.json` files so declaration generation stays scoped to each workspace package.
- Git-backed validation can take longer on Windows; keep explicit timeouts on slower integration tests.
- ESLint applies type-aware rules to TypeScript files and Node globals to CommonJS helper scripts, matching the GitHub Actions CI matrix.
