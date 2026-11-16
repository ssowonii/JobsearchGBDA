# Internship Hub

A personal, local web app that crawls internship and co-op postings in **content creation, marketing and UX/UI design**, ranks them against your resume, and tracks your applications on one page. It's tuned for an undergrad in **Ontario** on a **study permit + co-op work permit** (no PR or citizenship).

## Quick start

```bash
cp .env.example .env        # add your OPENAI_API_KEY (for semantic search)
npm install
npm start                   # → http://localhost:3000
```

Then click **↻ Refresh all** to crawl. A full crawl of the 45 seeded companies takes about 3–5 minutes. You can also run it from a terminal with `npm run crawl`.

## What it does

| Feature | How |
|---|---|
| **Crawling** | Calls the public job APIs of company applicant-tracking systems: Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Workable and Avature. Only student roles (intern, co-op, student) are kept. Seed list: `server/companies.js`. |
| **Dream company** | Type a name or careers URL. It checks the ATS board APIs for matching slugs, crawls the company's website and careers pages to find which ATS they use, and falls back to schema.org `JobPosting` data. The company is then saved so later refreshes include it. |
| **RAG search** | Each job gets two OpenAI `text-embedding-3-small` vectors: the role title (minus term and co-op noise) and the description with company boilerplate stripped (paragraphs repeated across a company's postings). Search is hybrid: 75% semantic plus 25% BM25 keyword score. **Similar jobs** finds nearest neighbours. **Match %** = 60% your skills vs. the description + 40% your target roles vs. the title, calibrated so that unrelated roles score ≈0% and strong fits score 70–100%. Edit the profile under **Profile**. If OpenAI is unavailable, everything falls back to keyword search. |
| **Filters** | Salary low→high / high→low and minimum hourly pay; job type (remote / hybrid / in-person); location (Ontario by default, plus remote-in-Canada, by city); focus area; work term (Winter 2027, Summer 2027, 8-month); company. |
| **Eligibility** | Flags postings that need citizenship/PR, are outside Canada, mention security clearance, or are funded by **SWPP / Canada Summer Jobs** wage subsidies (these exclude international students). |
| **Tracker** | Status (Saved → Applied → Interviewing → Offer), notes and deadlines on every job. Workday deadlines are picked up automatically. See the **My applications** tab. |
| **Add posting** | Paste a URL or the description text (for WaterlooWorks and similar sites). |

## LinkedIn & Indeed (`npm run browser`)

Opens your own Chrome with a separate profile. **You sign in manually.**

- `npm run browser`: **capture mode**. Browse normally; every posting you open is saved to the hub.
- `npm run browser -- search [--max=20] [--sites=linkedin,indeed]`: **search mode**. Runs your saved searches automatically with 4–9 s pauses between pages.

> ⚠ LinkedIn's User Agreement prohibits automated access, even when you're signed in, and both LinkedIn and Indeed can restrict accounts they flag as bots. Capture mode only reads pages you open yourself, so it's the lower-risk option. If you use search mode, keep volumes small. Selectors on these sites change often; if a capture comes through blank, paste the posting via **+ Add posting** instead.

## Work-authorization notes (not legal advice)

- A **co-op work permit** covers work terms that are a required part of your program. If you find a job outside WaterlooWorks, register it with Co-operative and Experiential Education as an **arranged co-op** so it counts.
- A non-co-op job during an academic term falls under the off-campus limit of **24 hrs/week**. Full-time is allowed only during scheduled breaks.
- US roles need US work authorization (e.g. J-1), which your Canadian permits don't provide, so they're hidden by default.

## Data

Everything is stored locally in `./data` (git-ignored): `db.json` holds jobs, statuses and companies, and `embeddings.json` holds the vectors. The OpenAI key is only used for embedding calls.
