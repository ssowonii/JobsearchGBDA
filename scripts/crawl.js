// CLI: `npm run crawl` refreshes every saved company board (same as "Refresh all" in the UI).
// `npm run crawl -- "Company name or careers URL" [--all]` runs a dream-company search.
import { crawlAll, crawlDreamCompany, task } from '../server/crawl.js';
import { flushNow } from '../server/store.js';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
if (target) crawlDreamCompany(target, { includeAll: args.includes('--all') });
else crawlAll();

while (task.running) await new Promise((r) => setTimeout(r, 500));
flushNow();
if (task.error) {
  console.error('Failed:', task.error);
  process.exit(1);
}
