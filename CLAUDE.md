# CLAUDE.md

## How to write the code

- Test-driven for behaviour. Any change to what the code does starts with a failing test: write it, watch it fail for the reason you predicted, then write the minimum that makes it pass. Bug fixes included — reproduce in a test before touching the fix. Docs, config, and dependency bumps are exempt; nothing else is.

- Smallest thing that works. No abstraction for a single call site, no configurability nobody asked for, no error handling for cases that cannot happen. If it is 200 lines and could be 50, rewrite it before showing it.

## Code comments

Write all code in this repo without any code comments.

- No inline comments, no block comments, no trailing explanations.
- No JSDoc/TSDoc or docstring blocks.
- Do not add "why" comments, TODO/FIXME notes, or section-divider comments.
- Remove comments you would otherwise have written; express intent through names and structure instead.
