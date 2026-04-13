# Matriya System

Monorepo for the **Matriya** research and RAG platform and the **Manager** operations stack: four Node.js / React applications designed to run together in development and deploy independently (for example via Vercel).

---

## Repository layout

| Directory | Role | Stack |
|-----------|------|--------|
| [`matriya-front`](./matriya-front) | Matriya web client: Ask Matriya, uploads, admin, lab flows | React 18, Create React App |
| [`matriya-back`](./matriya-back) | Matriya API: RAG, constraints, lab chain, auth, Supabase / vectors | Node.js 18+, Express (ESM) |
| [`maneger-front`](./maneger-front) | Manager web client: project and lab tooling | React 18, Vite |
| [`maneger-back`](./maneger-back) | Manager API: Supabase, documents, RAG sync, integrations | Node.js 18+, Express (ESM) |

---

## Prerequisites

- **Node.js** 18 or newer ([nodejs.org](https://nodejs.org/))
- **npm** (bundled with Node)
- **Supabase** (or compatible Postgres) and any third-party keys your teams use—see each app’s env templates and internal docs

---

## Quick start

Clone the repository, then install and run each service from its own folder.

### Matriya (frontend + backend)

```bash
cd matriya-back
cp env_example.txt .env   # then edit .env with your real values
npm install
npm run dev
```

In a second terminal:

```bash
cd matriya-front
npm install
npm start
```

The CRA dev server defaults to [http://localhost:3000](http://localhost:3000). Point the frontend at your Matriya API URL via the project’s env instructions (see [`matriya-front/ENV_SETUP.md`](./matriya-front/ENV_SETUP.md) and related files).

### Manager (frontend + backend)

```bash
cd maneger-back
npm install
# create .env from your team’s template (never commit secrets)
npm run dev
```

```bash
cd maneger-front
npm install
npm run dev
```

Vite typically serves at [http://localhost:5173](http://localhost:5173). Configure the API base URL to match your `maneger-back` instance.

---

## Scripts (summary)

| App | Dev | Production start | Notes |
|-----|-----|------------------|--------|
| `matriya-back` | `npm run dev` | `npm start` | Large `test` / verification script surface for gates and lab flows |
| `matriya-front` | `npm start` | `npm run build` then static host | Uses `react-scripts` |
| `maneger-back` | `npm run dev` | `npm start` | Includes vector indexing and GPT RAG sync helpers |
| `maneger-front` | `npm run dev` | `npm run build` / `npm run preview` | Vite |

Run `npm test` (or the specific `npm run` scripts) inside `matriya-back` or `maneger-back` when you need automated checks before release.

---

## Environment and security

- **Do not commit** `.env` files or live API keys. This repository uses `.gitignore` at the root and in each app.
- Prefer **`.env.example`** / `env_example.txt` patterns for onboarding; rotate any credential that was ever committed by mistake.
- Deployment notes for Vercel and related envs live next to each app (for example `VERCEL_DEPLOY.md`, `vercel.json`).

### Vercel: wiring the Matriya API URL

When **Matriya backend** is live (example: [https://matriya-project-fttv.vercel.app](https://matriya-project-fttv.vercel.app)), set these **per project** in the Vercel dashboard (**Project → Settings → Environment Variables**). Use **Production** (and Preview if you use preview deployments).

| Vercel project | Variable | Value (example) |
|----------------|----------|-------------------|
| **matriya-front** | `REACT_APP_API_BASE_URL` | `https://matriya-project-fttv.vercel.app` |
| **maneger-back** | `MATRIYA_BACK_URL` | `https://matriya-project-fttv.vercel.app` |

**Notes**

- **matriya-front** is Create React App: `REACT_APP_*` variables are baked in at **build** time. After changing them on Vercel, trigger a **new deployment** (redeploy).
- **maneger-back** uses `MATRIYA_BACK_URL` to proxy auth to Matriya, call ingest/RAG routes, and related flows. Without it, those features return 503. See [`maneger-back/VERCEL_DEPLOY.md`](./maneger-back/VERCEL_DEPLOY.md).
- **matriya-back** is the API itself at that URL; you do not set “Matriya URL” there. You *may* set `MANAGEMENT_BACK_URL` / `MATRIYA_MANAGEMENT_API_URL` once **maneger-back** is deployed, so Matriya can talk to Manager (lab bridge, materials). See [`matriya-back/config.js`](./matriya-back/config.js) and [`matriya-front/ENV_SETUP.md`](./matriya-front/ENV_SETUP.md) for `REACT_APP_MANAGEMENT_*` on the Matriya UI.
- **maneger-front** only needs `VITE_MANEGER_API_URL` pointing at your **deployed maneger-back** URL, not the Matriya API.

Matriya’s API uses permissive CORS (`origin: true`), so browser calls from your deployed frontends work once the correct base URLs are set.

**Uploads on Vercel:** Matriya does not persist raw files on disk between requests (serverless filesystem is ephemeral). Uploads are buffered in RAM, written under **`/tmp`** for processing, chunked, and stored in **Postgres / pgvector** (and optionally OpenAI). Ensure **`POSTGRES_URL`** and **`OPENAI_API_KEY`** (for embeddings on Vercel) are set on the Matriya backend project.

### Vercel: wiring the Manager API URL (`maneger-back`)

When **Manager backend** is live (example: [https://matriya-project-vskr.vercel.app](https://matriya-project-vskr.vercel.app)), set these variables (**no trailing slash** is fine; apps normalize URLs).

| Where | Variable | Example value |
|--------|----------|-----------------|
| **maneger-front** (Vercel + local `.env`) | `VITE_MANEGER_API_URL` | `https://matriya-project-vskr.vercel.app` |
| **matriya-front** (Vercel + local `.env`) | `REACT_APP_MANAGEMENT_API_URL` | `https://matriya-project-vskr.vercel.app` |
| **matriya-front** (Vercel + local `.env`) | `REACT_APP_MANAGEMENT_FRONT_URL` | `https://matriya-project-3vra.vercel.app` (site **root** — do **not** append `/login`; the app redirects there if needed) |
| **matriya-back** (Vercel + `matriya-back/.env`) | `MANAGEMENT_BACK_URL` | **Value = URL only:** `https://matriya-project-vskr.vercel.app` — **required for `flow=lab`**. In Vercel, the *name* is `MANAGEMENT_BACK_URL` and the *value* must **not** repeat the name (pasting `MANAGEMENT_BACK_URL=https://...` as the value causes **ENOTFOUND `management_back_url=https`**). |
| **matriya-back** (same deploy, if you use “materials library” / management data in Ask Matriya) | `MATRIYA_MANAGEMENT_API_URL` | `https://matriya-project-vskr.vercel.app` |

**CORS on `maneger-back`:** the server only allows listed origins. Defaults include `https://matriya-front.vercel.app` and `https://manegment-front.vercel.app`. If your frontends use **other** `*.vercel.app` hostnames, either set `CORS_ORIGINS` to a comma-separated list of exact origins, or set `CORS_ALLOW_VERCEL_PREVIEWS=true` so any `https://*.vercel.app` preview/production URL is accepted. See [`maneger-back/server.js`](./maneger-back/server.js) (`DEFAULT_CORS_ORIGINS`, `getAllowedOrigins`).

**`maneger-back` itself** does not need its own URL in an env var for normal API operation; optional `PUBLIC_API_BASE_URL` is for absolute links in some responses/docs.

---

## Documentation

- Matriya backend: constraint engine, migrations, and runbooks under [`matriya-back/docs`](./matriya-back/docs) and markdown guides in that folder.
- Manager backend: architecture and verification docs under [`maneger-back`](./maneger-back) (for example `ARCHITECTURE.md`, `docs/`).

---

## Contributing

1. Create a branch from `main`.
2. Keep changes scoped to the app you are modifying.
3. Run installs and relevant tests in that app before opening a pull request.
4. Avoid adding secrets; use env files locally only.

---

## License

Specify your license here (proprietary, MIT, etc.) once your organization decides.

---

**Remote:** [github.com/Waqas56jb/Matriya-Project](https://github.com/Waqas56jb/Matriya-Project)
