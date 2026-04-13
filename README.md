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
