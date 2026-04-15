Target: $ARGUMENTS (e.g. "security middleware", "circuit breaker", "authorize endpoint"). If empty, run all existing tests.

**If Jest is not configured yet**, set it up first:
1. Install devDependencies: `jest @types/jest ts-jest supertest @types/supertest`
2. Create `jest.config.ts` using ts-jest preset, targeting `src/**/*.test.ts`
3. Add `"test": "jest"` and `"test:watch": "jest --watch"` to `package.json` scripts

**Test rules (from CLAUDE.md):**
- Integration tests must use a real in-memory SQLite instance (`DATABASE_PATH=:memory:`), never mocks
- Unit tests for resilience primitives (circuit breaker, bulkhead, retry) can be isolated
- For endpoint tests, use supertest against the full Express app

Write tests for $ARGUMENTS covering: happy path, idempotent replay, error cases, and state machine transitions where applicable.
