# Drill (water-well-manager)

Offline-first field app and office dashboard for water well drilling crews. React + Vite + Capacitor, backed by Supabase. See `README.md`.

## SaaS work

The multi-tenant SaaS work is specified in `docs/SAAS_ARCHITECTURE_PROPOSAL.md` and run by a fixed workflow.

- Before doing anything on it, read `docs/saas/IMPLEMENTATION_STATUS.md` and follow `docs/saas/WORKFLOW.md`. The main session is the Lead; implementation, testing and review are delegated to the agents in `.claude/agents/`.
- Do not start a phase the status file marks "Not approved".
- `scripts/gate.sh quick` is the check to run before claiming anything works.

## Rules that always apply

- The production Supabase project is `bfteveoeodbvjxjlpnwz`. Never run migrations, deployments, e2e suites or data scripts against it without the owner approving that specific action.
- Never weaken an RLS policy or a test to make something pass.
- Never push to `main` or merge a pull request.
- `npm run lint` does not type-check JSX (`@types/react` is missing). After changing a `.tsx` file, build and render it.
