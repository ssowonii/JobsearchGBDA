# Internship Hub

A personal web app that crawls internship and co-op postings in **content creation, marketing and UX/UI design**, ranks them against your resume, and tracks your applications on one page. It's tuned for an undergrad in **Ontario** on a **study permit + co-op work permit** (no PR or citizenship).

**Stack:** Next.js 16 (frontend) · FastAPI (backend, `backend/`) · Neon Postgres + pgvector · deployed as one Vercel project.

```
app/, components/, lib/   Next.js App Router UI (TypeScript)
proxy.ts                  sends signed-out visitors to /login
api/index.py              Vercel Python function → FastAPI app (all /api/* routes)
backend/                  crawler, normalizer, retrieval, auth, DB access (Python)
tests/                    pytest, incl. parity tests against the original JS implementation
scripts/browser.js        LinkedIn/Indeed capture helper (runs on your machine)
```

## Local development

Requires Node ≥ 20.9 and Python 3.12.

```bash
npm install
npm run setup:py          # creates .venv and installs requirements-dev.txt
cp .env.example .env.local   # fill in DATABASE_URL (Neon), OPENAI_API_KEY, …
npm run dev               # Next.js on http://localhost:3000 + FastAPI on :8000
```

`npm run dev` runs both servers; Next.js proxies `/api/*` to FastAPI. Tables are created automatically on the first request (or run `npm run db:migrate`). Leave `APP_PASSWORD` empty locally to skip the login screen.

Other scripts: `npm test` (pytest), `npm run crawl` (full crawl from the terminal), `npm run crawl -- "Shopify" --all` (dream company), `npm run typecheck`.

Moving over data from the old Express version (`./data/db.json` + `embeddings.json`):
`node scripts/py.mjs -m backend.cli import-json data`

## Deploying to Vercel

1. **Import the repo** at vercel.com/new (framework: Next.js; defaults are fine). Or with the CLI: `npx vercel link`.
2. **Add the database:** Project → Storage → Marketplace → **Neon** → connect it to the project. This injects `DATABASE_URL`. pgvector is enabled automatically by the schema.
3. **Set environment variables** (Project → Settings → Environment Variables):

   | Name | Value |
   |---|---|
   | `APP_PASSWORD` | the password you'll log in with |
   | `SESSION_SECRET` | long random string (`openssl rand -hex 32`) |
   | `OPENAI_API_KEY` | for semantic search + Match % (optional; keyword search works without) |
   | `HUB_TOKEN` | long random string, used by `npm run browser` against the deployed hub |
   | `CRON_SECRET` | long random string; Vercel sends it to the daily crawl |

4. **Deploy** (push to GitHub, or `npx vercel deploy --prod`). Open the site, sign in, click **↻ Refresh all**.

`vercel.json` gives the Python function up to 300 s and schedules a **daily crawl at 11:00 UTC** (6–7 am Toronto).

## How crawling works on serverless

Serverless functions can't run a 3–5 minute background job, so a refresh is a queue of company boards stored in the `crawl_runs` table:

- **↻ Refresh all** creates the queue, and the open tab calls `POST /api/crawl/step` in a loop. Each step crawls a batch of boards (up to 5 fast ones plus at most 1 slow Workday board) for about 90 s, then embeds and re-scores. A full refresh usually takes 2–3 steps. If you close the tab, the run resumes the next time you open the app.
- The **daily cron** (`/api/cron/crawl`) works the same queue and re-invokes itself until it's done.
- **Dream company** and **Add posting** run as single requests and show their log when finished.

## What it does

| Feature | How |
|---|---|
| **Crawling** | Calls the public job APIs of applicant-tracking systems: Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Workable and Avature. Only student roles (intern, co-op, student) are kept. Seed list: `backend/companies.py` (saved to the DB on first run). |
| **Dream company** | Type a name or careers URL. It checks the ATS board APIs for matching slugs, crawls the company's website and careers pages to find which ATS they use, and falls back to schema.org `JobPosting` data. The company is then saved so later refreshes include it. |
| **RAG search** | Each job gets two OpenAI `text-embedding-3-small` vectors (512-d, in pgvector): the role title (minus term and co-op noise) and the description with company boilerplate stripped. Search is hybrid: 75% semantic plus 25% Postgres full-text keyword score. **Similar jobs** finds nearest neighbours. **Match %** = 60% your skills vs. the description + 40% your target roles vs. the title, calibrated so that unrelated roles score ≈0% and strong fits score 70–100%. Edit the profile under **Profile**. If OpenAI is unavailable, everything falls back to keyword search. |
| **Filters** | Salary low→high / high→low and minimum hourly pay; job type (remote / hybrid / in-person); location (Ontario by default, plus remote-in-Canada, by city); focus area; work term (Winter 2027, Summer 2027, 8-month); company. |
| **Eligibility** | Flags postings that need citizenship/PR, are outside Canada, mention security clearance, or are funded by **SWPP / Canada Summer Jobs** wage subsidies (these exclude international students). |
| **Tracker** | Status (Saved → Applied → Interviewing → Offer), notes and deadlines on every job. Workday deadlines are picked up automatically. See the **My applications** tab. |
| **Add posting** | Paste a URL or the description text (for WaterlooWorks and similar sites). |
| **Access** | One password (`APP_PASSWORD`) → signed HttpOnly cookie. Every API route requires it (or the `HUB_TOKEN` bearer for scripts). |

## LinkedIn & Indeed (`npm run browser`)

Opens your own Chrome with a separate profile. **You sign in manually.** Captured postings go to `HUB_URL` (default `http://localhost:3000`). To send them to the deployed hub, put `HUB_URL=https://<your-app>.vercel.app` and `HUB_TOKEN=<same value as in Vercel>` in `.env.local`.

- `npm run browser`: **capture mode**. Browse normally; every posting you open is saved to the hub.
- `npm run browser -- search [--max=20] [--sites=linkedin,indeed]`: **search mode**. Runs your saved searches automatically with 4–9 s pauses between pages.

> ⚠ LinkedIn's User Agreement prohibits automated access, even when you're signed in, and both LinkedIn and Indeed can restrict accounts they flag as bots. Capture mode only reads pages you open yourself, so it's the lower-risk option. If you use search mode, keep volumes small. Selectors on these sites change often; if a capture comes through blank, paste the posting via **+ Add posting** instead.

## Work-authorization notes (not legal advice)

- A **co-op work permit** covers work terms that are a required part of your program. If you find a job outside WaterlooWorks, register it with Co-operative and Experiential Education as an **arranged co-op** so it counts.
- A non-co-op job during an academic term falls under the off-campus limit of **24 hrs/week**. Full-time is allowed only during scheduled breaks.
- US roles need US work authorization (e.g. J-1), which your Canadian permits don't provide, so they're hidden by default.
