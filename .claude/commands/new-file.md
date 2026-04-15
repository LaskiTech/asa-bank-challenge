Create a new source file at the path: $ARGUMENTS

Before writing:
1. Read CLAUDE.md for required code patterns (structured JSON logging with correlationId, business error statusCode pattern, Express v5 async routes, resilience chain order)
2. Read the relevant spec doc in `docs/` if one covers this module
3. Verify the path falls under `src/` and matches the project file structure in CLAUDE.md

After creating, check if the file needs to be imported/registered anywhere (e.g. middleware in `app.ts`, routes in `app.ts`, resilience primitives in `resilienceService.ts`) and make those connections.
