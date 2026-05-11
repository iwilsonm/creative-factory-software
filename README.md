# Creative Factory

Single-tenant ad generation and deployment software for Creative Factory.

## Live App

- Production: https://creative-factory-software.vercel.app
- Convex deployment: https://elated-mastiff-709.convex.cloud
- GitHub: https://github.com/iwilsonm/creative-factory-software

## Deployment Binding

This repository is the Creative Factory production codebase. Marco's production data lives in the existing Convex deployment `elated-mastiff-709`.

Do not point this codebase at any non-CF Convex deployment or any other fork/client deployment. Conversely, do not point another fork at `elated-mastiff-709`. The project data, users, sessions, ads, costs, template storage, and Meta connection records in that deployment belong to Creative Factory.

## Local Convex Binding

Local development should use environment files that target the Creative Factory Convex deployment only when you intentionally need to inspect or verify Creative Factory data:

- `CONVEX_DEPLOYMENT=dev:elated-mastiff-709` or the matching deployment key setup
- `CONVEX_URL=https://elated-mastiff-709.convex.cloud`
- `CONVEX_SITE_URL=https://elated-mastiff-709.convex.site`

For schema/function deploys, use the Creative Factory Convex deploy key. Schema changes must be additive unless a separate migration plan has been approved.

## Useful Commands

```bash
pnpm install
npx convex dev --once --typecheck=disable
pnpm --dir frontend build
pnpm --dir backend test
```

## Current Substrate

The current source substrate was cut over from Ian's improved fork, then re-skinned and rebound for Creative Factory. Preserve Creative Factory branding, the `creative-factory-software.vercel.app` URL, and the `elated-mastiff-709` Convex deployment.
