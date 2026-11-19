# Contributing

Thank you for helping. A change is welcome when it keeps navvied light, clear and correct.

## Before you open a pull request

```
bun install
bun run typecheck
bun test packages
```

All three must pass. Type checking is `strict` with `noUncheckedIndexedAccess`.

## What we hold every change to

| Rule | Meaning |
|---|---|
| Tested | a change comes with the tests that prove it; a pull request with a failing test is not merged |
| No new runtime dependencies in the core | `packages/protocol`, `packages/engine` and `packages/cli` use no third-party packages at run time; a feature that needs one is a plugin |
| Small modules | one job per module, collaborators passed in, no global mutable state, so everything can be tested against a scripted model |
| Comments that earn their place | a comment says what the code cannot: a reason, a constraint, a trap |
| English | code, identifiers, comments, tests, documents, messages and commit messages (`packages/protocol/test/language.test.ts`) |
| One brand | other products are named only in `packages/cli/src/presets.ts` (`packages/protocol/test/hygiene.test.ts`) |
| Small models first | short prompts, few simply described tools, tolerant parsing; a change must not make a 3B or 7B model worse |

Commit messages follow `type(scope): summary` (feat, fix, refactor, test, docs, chore).

## Licensing of contributions

navvied is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE), and the copyright holder also offers commercial
licenses. To keep that possible, by submitting a contribution you confirm that you wrote it (or may submit it) and grant the
copyright holder a perpetual, worldwide, irrevocable, royalty-free license to use, modify, sublicense and distribute it,
including under commercial terms. You keep the copyright in your contribution.
