export type AppState = {
  status?: string;
  notes?: string;
  deadline?: string;
  appliedAt?: string;
  updatedAt?: string;
};

export type Location = {
  display?: string;
  country?: string;
  isCanada?: boolean;
  isOntario?: boolean;
  province?: string;
  cities?: string[];
  anyRemote?: boolean;
  nonCanadaOnly?: boolean;
  /** Remote role that can be done from Canada (Canadian remote, Remote – Americas/Worldwide, "US or Canada"). */
  remoteFromCanada?: boolean;
  /** The posting itself says Canada is OK (Canadian location, open region, or "US or Canada" text). */
  remoteCanadaStated?: boolean;
};

export type Salary = {
  min: number;
  max: number;
  currency: string;
  interval: string;
  hourlyMin: number;
  hourlyMax: number;
  text: string;
  raw?: string;
};

export type Job = {
  id: string;
  source: string;
  company: string;
  companyKey: string;
  title: string;
  url: string;
  applyUrl?: string;
  location?: Location;
  workMode?: string;
  salary?: Salary | null;
  term?: { terms?: string[]; durationMonths?: number | null; eightMonth?: boolean };
  categories?: string[];
  eligibility?: { status?: string; reasons?: string[] };
  postedAt?: string;
  deadline?: string;
  firstSeen?: string;
  app?: AppState;
  active?: boolean;
  dream?: boolean;
  match?: number | null;
  /** '' = in the hub, 'pending' = dream-company role waiting for you to add it. */
  review?: string;
  rank: number;
  snippet?: string;
  description?: string;
};

export type Meta = {
  lastCrawl: string | null;
  hasOpenAI: boolean;
  hasKey: boolean;
  openaiError: string | null;
  companies: number;
  /** Dream-company roles waiting in the review list. */
  pendingReview?: number;
};

export type Task = {
  id?: number;
  running: boolean;
  kind: string;
  label: string;
  log: string[];
  startedAt: string | null;
  finishedAt: string | null;
  result: { total?: number; company?: string; ids?: string[]; pending?: string[]; message?: string } | null;
  error: string | null;
  done: number;
  total: number;
  busy?: boolean;
};

export type Hit = { id: string; score: number };
