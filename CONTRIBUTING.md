# Contributing

This project accepts no outside contributions before its first public release.

- Use synthetic test data only: no real paths, identifiers, credentials or session captures.
  Build forbidden-looking values from fragments at runtime so `pnpm privacy-check` stays clean.
- Run `pnpm typecheck && pnpm build && pnpm test && pnpm privacy-check` before committing.
- Linting is deferred; strict TypeScript typechecking is the gate for now.
