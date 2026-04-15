Perform the Docker operation: $ARGUMENTS

Operations:
- `up` — `docker compose up --build -d`
- `down` — `docker compose down`
- `logs` — `docker compose logs -f api`
- `rebuild` — `docker compose down && docker compose up --build -d`
- `shell` — `docker compose exec api sh`

If $ARGUMENTS is empty, run `docker compose up --build -d` then tail logs.

**Before running:** verify `Dockerfile` and `docker-compose.yml` exist in the project root. If they don't, create them following `docs/DOCKER.md` before executing the compose command. The SQLite volume must be `./data:/app/data`.
