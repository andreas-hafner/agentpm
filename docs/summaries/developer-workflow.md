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
- Package builds use local `tsconfig.build.json` files so declaration generation stays scoped to each workspace package.
- Git-backed validation can take longer on Windows; keep explicit timeouts on slower integration tests.
