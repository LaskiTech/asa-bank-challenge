# Setup Guide — Docker + Postman

Step-by-step guide to run the API locally with Docker and test it with the Postman collection.  
No prior Docker experience required.

---

## What you will need

| Tool | Where to get it | Why |
|------|----------------|-----|
| **Docker Desktop** | https://www.docker.com/products/docker-desktop | Runs the container |
| **Postman** | https://www.postman.com/downloads | Calls the API endpoints |

> **Windows note**: Docker Desktop requires WSL 2 (Windows Subsystem for Linux). The installer will prompt you to enable it if it is not already active — just follow the on-screen steps.

---

## Part 1 — Install and start Docker Desktop

1. Download and run the Docker Desktop installer.
2. After installation, open **Docker Desktop** from the Start Menu.
3. Wait until the bottom-left corner shows a **green dot** and the text "Engine running". This takes about 30–60 seconds on first launch.
4. Verify the installation by opening a terminal (PowerShell, CMD, or Git Bash) and running:
   ```
   docker --version
   ```
   You should see something like `Docker version 26.x.x`.

---

## Part 2 — Prepare the project

Open a terminal, navigate to the project root (the folder that contains `docker-compose.yml`), and run the following commands one by one.

### 2.1 — Create the environment file

```bash
cp .env.example .env
```

This creates a `.env` file with the default configuration. The defaults work out of the box for local development — you do not need to change anything.

### 2.2 — (Optional) Review the configuration

Open `.env` in any text editor if you are curious. The important value for testing is:

```
SHARED_SECRET=dev-secret-key-change-in-production
```

This is the secret used to sign requests. The Postman collection already has this value configured — so as long as you do not change it here, everything will work automatically.

---

## Part 3 — Build and start the container

### 3.1 — Start the API

```bash
docker compose up -d
```

What this does, step by step:
- `docker compose` reads `docker-compose.yml` and knows what to build
- `up` builds the image and starts the container
- `-d` runs it in the background (detached), so your terminal is free

The **first run** takes longer (2–5 minutes) because Docker downloads the Node.js base image and installs npm dependencies. Subsequent starts are near-instant.

### 3.2 — Confirm it is running

```bash
docker compose ps
```

You should see one container named `api` with status `running`.

### 3.3 — Check the logs

```bash
docker compose logs -f
```

You should see output similar to:
```
api  | {"level":"info","message":"Server listening on port 3000"}
```

Press `Ctrl+C` to stop following the logs (the container keeps running).

### 3.4 — Smoke-test with a quick request

Open a browser and go to:
```
http://localhost:3000/health
```

You should see:
```json
{"status":"ok"}
```

If you see that, the API is ready.

---

## Part 4 — Import the Postman collection

1. Open **Postman**.
2. Click the **Import** button (top-left, next to "My Workspace").
3. Select **File** and choose:
   ```
   docs/postman_collection.json
   ```
4. Click **Import**. A collection named **"ASA Bank - POS Transaction API"** will appear in your left sidebar.

---

## Part 5 — Configure the collection

The collection uses variables so you never have to type the URL or secret manually.

1. In the left sidebar, **right-click** the collection name → **Edit**.
2. Go to the **Variables** tab.
3. Confirm these values (they should already be set):

   | Variable | Current Value |
   |----------|--------------|
   | `baseUrl` | `http://localhost:3000` |
   | `sharedSecret` | `dev-secret-key-change-in-production` |
   | `transactionId` | *(empty — filled automatically later)* |

4. Click **Save**.

> The `X-Signature` and `X-Timestamp` security headers are **generated automatically** by pre-request scripts inside each request. You do not need to compute them manually.

---

## Part 6 — Test the endpoints

Run the requests in the order below to walk through a complete transaction lifecycle.

### Step 1 — Health check

- Open the **Health** folder → click **GET /health**
- Click **Send**
- Expected response: `200 OK` with body `{"status":"ok"}`

---

### Step 2 — Authorize a transaction

- Open the **Transactions** folder → click **POST /authorize**
- Click **Send**
- Expected response: `200 OK`

```json
{
    "nsu": "123456",
    "amount": 199.90,
    "terminalId": "T-1000",
    "transactionId": "...",
    "status": "AUTHORIZED"
}
```

> The `transactionId` from this response is **automatically saved** to the collection variable. The next requests (confirm and void) will use it without any copy-paste.

---

### Step 3 — Test idempotency (replay the same authorize)

- Still inside **Transactions** → click **POST /authorize (idempotency replay)**
- Click **Send**
- Expected response: `200 OK` with the **exact same `transactionId`**

This proves the API recognizes the duplicate request and returns the existing transaction without creating a new one.

---

### Step 4 — Confirm the transaction

- Click **POST /confirm**
- Click **Send**
- Expected response: `204 No Content` (empty body — this is correct)

---

### Step 5 — Void the transaction (two ways)

**Option A — by transactionId:**
- Click **POST /void (by transactionId)**
- Click **Send**
- Expected: `204 No Content`

**Option B — by nsu + terminalId:**
- Click **POST /void (by nsu + terminalId)**
- Click **Send**
- Expected: `204 No Content`

> If you already ran Option A, Option B will also return `204` — that is idempotency working correctly.

---

### Step 6 — Run the security scenarios

Open the **Security Scenarios** folder and send each request. All three are expected to return `401 Unauthorized`:

| Request | What it tests | Expected |
|---------|--------------|----------|
| 401 — Missing Signature | No `X-Signature` header | `401` `missing_signature` |
| 401 — Invalid Signature | Wrong hex value in `X-Signature` | `401` `invalid_signature` |
| 401 — Expired Timestamp | `X-Timestamp` 10 minutes in the past | `401` `timestamp_out_of_range` |

The **Tests** tab in each request shows green checkmarks when the response matches the expectation.

---

## Part 7 — Run all tests at once (Collection Runner)

To run every request automatically in sequence:

1. Right-click the collection name → **Run collection**
2. Keep all requests selected
3. Click **Run ASA Bank - POS Transaction API**

Postman will execute each request in order and show a pass/fail report. A complete green run confirms the full transaction lifecycle works correctly.

---

## Part 8 — Useful commands while working

```bash
# View live logs from the container
docker compose logs -f

# Stop the API (data is preserved)
docker compose down

# Start again after stopping
docker compose up -d

# Restart the container (e.g., after a code change)
docker compose restart api

# Wipe all data and start fresh
docker compose down
rm -rf ./data
docker compose up -d
```

---

## Troubleshooting

### "Cannot connect" / "ECONNREFUSED" in Postman

- Check that Docker Desktop is running (green dot).
- Run `docker compose ps` — the `api` service must show status `running`.
- Run `docker compose logs` and look for startup errors.

### Container exits immediately after `docker compose up`

- Run `docker compose logs` to see the error.
- Common cause: the `src/` directory is missing. The implementation must exist before the container can start.

### Port 3000 already in use

Another process is using port 3000. Either stop it, or change the port mapping in `docker-compose.yml` from `"3000:3000"` to `"3001:3000"` and update the `baseUrl` collection variable to `http://localhost:3001`.

### Postman shows "401 invalid_signature" on all requests

The `sharedSecret` collection variable does not match the `SHARED_SECRET` in your `.env` file. Open `.env`, copy the value of `SHARED_SECRET`, and paste it into the `sharedSecret` collection variable in Postman.

### Test scripts show red (unexpected status code)

Run the requests in order (authorize → confirm → void). Some requests depend on a `transactionId` that is only available after `/authorize` succeeds.
