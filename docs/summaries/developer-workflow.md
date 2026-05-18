# Developer Workflow

## Responsibility

Summarizes the repo tooling, validation workflow, and documentation expectations.

## Key Files

- `package.json`
- `turbo.json`
- `tsconfig.json`
- `vitest.config.ts`
- `AGENTS.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `.github/pull_request_template.md`

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
- User-facing source, cache, update, doctor, and push flows have focused Vitest coverage; keep CLI behavior covered when changing prompts or command contracts.
- Package builds use local `tsconfig.build.json` files so declaration generation stays scoped to each workspace package.
- Git-backed validation can take longer on Windows; keep explicit timeouts on slower integration tests.
- ESLint applies type-aware rules to TypeScript files and Node globals to CommonJS helper scripts, matching the GitHub Actions CI matrix.
- Repo-local governance is split between `AGENTS.md` for implementation and release-law rules, `CHANGELOG.md` for release-facing history, `CONTRIBUTING.md` for contributor workflow, `SECURITY.md` for private reporting, and the PR template for validation and release-bookkeeping reminders.
- `AGENTS.md` now carries an explicit GodMode operating contract: governance preflight, `Goal/Context/Constraints/Done when`, a single-writer model, role triggers for `api_guardian`, `builder`, `validator`, and `tester`, and release-impact reporting before final handoff.
