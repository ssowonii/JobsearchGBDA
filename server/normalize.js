// Turns raw postings from any source into one normalized shape, and derives:
// location (Ontario/Canada), work mode, salary, co-op term, category, student level,
// and work-authorization eligibility for a study-permit + co-op-permit holder.

// ---------- text ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', bull: '•', middot: '·' };
export function decodeEntities(s = '') {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html = '') {
  if (!html) return '';
  let s = String(html);
  // Greenhouse double-encodes HTML (&lt;p&gt;) – decode first if so
  if (/&lt;\/?[a-z]/i.test(s) && !/<\/?[a-z]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- location ----------
const ON_CITIES = ['toronto', 'waterloo', 'kitchener', 'cambridge', 'guelph', 'mississauga', 'brampton', 'markham', 'vaughan', 'richmond hill', 'oakville', 'burlington', 'hamilton', 'ottawa', 'kingston', 'windsor', 'oshawa', 'barrie', 'scarborough', 'north york', 'etobicoke', 'pickering', 'ajax', 'whitby', 'milton', 'st. catharines', 'niagara', 'sudbury', 'thunder bay', 'peterborough', 'concord', 'thornhill', 'newmarket', 'aurora', 'london, on'];
const CA_CITIES = ['vancouver', 'montreal', 'montréal', 'calgary', 'edmonton', 'winnipeg', 'halifax', 'quebec city', 'québec', 'victoria', 'saskatoon', 'regina', 'burnaby', 'surrey', 'laval', 'gatineau', 'moncton', 'fredericton', "st. john's", 'charlottetown', 'kelowna', 'richmond, bc'];
const CA_PROV_NAMES = /\b(ontario|british columbia|quebec|québec|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward island|yukon|nunavut|northwest territories)\b/i;
const CA_PROV_ABBR = /(?:^|[,\s(/-])(ON|BC|QC|AB|MB|SK|NS|NB|NL|PE|PEI|YT|NT|NU)(?=$|[,\s)/-])/;
const US_STATES = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;
const US_ABBR = /(?:,\s*|\s)(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?=$|[,\s)])/;
const US_WORDS = /\b(united states|usa|u\.s\.a?\.?|us-remote|remote[\s-]*us|us only|san francisco|new york|seattle|chicago|austin|boston|los angeles|denver|atlanta|miami|houston|dallas|palo alto|menlo park|mountain view|sunnyvale|san jose|brooklyn|nyc|sf bay)\b/i;
const OTHER_COUNTRIES = /\b(united kingdom|uk|england|london(?!,?\s*(on|ontario))|ireland|dublin|germany|berlin|france|paris|spain|madrid|barcelona|netherlands|amsterdam|poland|india|bangalore|bengaluru|japan|tokyo|singapore|australia|sydney|melbourne|brazil|mexico|korea|seoul|china|shanghai|hong kong|philippines|manila|sweden|stockholm|denmark|finland|norway|italy|portugal|lisbon|israel|uae|dubai|bulgaria|romania|ukraine|argentina|colombia|chile|new zealand|switzerland|zurich|belgium|austria|czech|vietnam|indonesia|malaysia|thailand|taiwan|emea|apac|latam|europe)\b/i;

function classifyLoc(raw) {
  const s = String(raw || '').trim();
  const l = s.toLowerCase();
  const remote = /\b(remote|anywhere|work from home|wfh|distributed)\b/.test(l);
  const onCity = ON_CITIES.find((c) => l.includes(c));
  if (onCity || /\bontario\b/.test(l) || /(^|[,\s(])ON($|[,\s)])/.test(s)) {
    return { raw: s, country: 'CA', province: 'ON', city: onCity ? titleCase(onCity.replace(', on', '')) : '', remote };
  }
  const caCity = CA_CITIES.find((c) => l.includes(c));
  if (caCity || /\bcanada\b|\bcan\b|canadian/i.test(l) || CA_PROV_NAMES.test(l) || CA_PROV_ABBR.test(s)) {
    const prov = (s.match(CA_PROV_ABBR) || [])[1] || (l.match(CA_PROV_NAMES) || [])[1] || '';
    return { raw: s, country: 'CA', province: provAbbr(prov), city: caCity ? titleCase(caCity) : '', remote };
  }
  if (US_WORDS.test(l) || US_STATES.test(l) || US_ABBR.test(s)) return { raw: s, country: 'US', province: '', city: '', remote };
  if (OTHER_COUNTRIES.test(l)) return { raw: s, country: 'OTHER', province: '', city: '', remote };
  return { raw: s, country: remote ? 'REMOTE?' : 'UNKNOWN', province: '', city: '', remote };
}

function provAbbr(p) {
  const m = { ontario: 'ON', 'british columbia': 'BC', quebec: 'QC', québec: 'QC', alberta: 'AB', manitoba: 'MB', saskatchewan: 'SK', 'nova scotia': 'NS', 'new brunswick': 'NB', newfoundland: 'NL', 'prince edward island': 'PE' };
  return m[String(p).toLowerCase()] || String(p).toUpperCase();
}
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function parseLocations(list) {
  const items = (list || []).filter(Boolean).map(classifyLoc);
  const ca = items.filter((i) => i.country === 'CA');
  const country = ca.length ? 'CA' : items.find((i) => i.country === 'US') ? 'US' : items.find((i) => i.country === 'OTHER') ? 'OTHER' : items.find((i) => i.country === 'REMOTE?') ? 'REMOTE?' : 'UNKNOWN';
  const on = ca.filter((i) => i.province === 'ON');
  const cities = [...new Set(ca.map((i) => i.city).filter(Boolean))];
  const display = (list || []).filter(Boolean).join(' · ') || 'Location not listed';
  return {
    display: display.length > 140 ? display.slice(0, 137) + '…' : display,
    country,
    isCanada: ca.length > 0,
    isOntario: on.length > 0,
    province: on.length ? 'ON' : ca[0]?.province || '',
    cities,
    anyRemote: items.some((i) => i.remote),
    nonCanadaOnly: !ca.length && items.some((i) => i.country === 'US' || i.country === 'OTHER'),
  };
}

// ---------- work mode ----------
export function detectWorkMode({ hint, locations = [], text = '' }) {
  const h = String(hint || '').toLowerCase();
  if (/hybrid/.test(h)) return 'hybrid';
  if (/remote/.test(h)) return 'remote';
  if (/on-?site|office|in.?person/.test(h)) return 'onsite';
  const loc = locations.join(' ').toLowerCase();
  if (/hybrid/.test(loc)) return 'hybrid';
  const t = text.slice(0, 8000).toLowerCase();
  if (/\bhybrid\b/.test(t) || /\b(\d|two|three|four)\s*(?:days?)\s*(?:per|a|\/|each)\s*week\b[^.]{0,40}\b(office|on-?site|in[- ]person)/.test(t) || /\b(office|on-?site|in[- ]person)\b[^.]{0,30}\b(\d|two|three|four)\s*days?\s*(?:per|a|\/|each)\s*week/.test(t)) return 'hybrid';
  if (/\b(remote|anywhere|work from home)\b/.test(loc)) return 'remote';
  if (/\b(fully remote|100% remote|remote[- ]first|this (is a |role is |position is )?(fully )?remote|remote (role|position|opportunity|internship|co-?op))\b/.test(t)) return 'remote';
  if (/\b(on-?site|in[- ]office|in[- ]person)\b/.test(t)) return 'onsite';
  return 'unknown';
}

// ---------- salary ----------
const USD_TO_CAD = 1.38; // approximate; only used to sort mixed-currency postings
const HOURS = { hour: 1, week: 40, month: 173.33, year: 2080 };

function toNum(n, dec, k) {
  let v = parseFloat(String(n).replace(/[,\s]/g, '') + (dec ? '.' + dec : ''));
  if (k) v *= 1000;
  return v;
}
function intervalFromWords(s) {
  const l = String(s || '').toLowerCase();
  if (/hour|hr\b|hourly/.test(l)) return 'hour';
  if (/week/.test(l)) return 'week';
  if (/month/.test(l)) return 'month';
  if (/year|annual|annum|yr\b|salary/.test(l)) return 'year';
  return '';
}
function intervalFromMagnitude(max) {
  if (max <= 200) return 'hour';
  if (max >= 1000 && max < 15000) return 'month';
  if (max >= 15000) return 'year';
  return '';
}

export function makeSalary({ min, max, currency, interval, text }) {
  if (min == null && max == null) return null;
  min = min ?? max;
  max = max ?? min;
  if (!(min > 0)) return null;
  interval = interval || intervalFromMagnitude(max);
  if (!interval) return null;
  currency = (currency || 'CAD').toUpperCase();
  const fx = currency === 'USD' ? USD_TO_CAD : 1;
  const hourlyMin = Math.round(((min * fx) / HOURS[interval]) * 100) / 100;
  const hourlyMax = Math.round(((max * fx) / HOURS[interval]) * 100) / 100;
  // reject nonsense (e.g. $5M funding rounds parsed as salary)
  if (hourlyMax > 400 || hourlyMin < 8) return null;
  return { min, max, currency, interval, hourlyMin, hourlyMax, text: formatSalary(min, max, currency, interval), raw: text || '' };
}

export function formatSalary(min, max, currency, interval) {
  const f = (v) => (v >= 1000 ? `$${Math.round(v / 100) / 10}k` : `$${Number.isInteger(v) ? v : v.toFixed(2)}`);
  const per = { hour: '/hr', week: '/wk', month: '/mo', year: '/yr' }[interval] || '';
  return `${f(min)}${max && max !== min ? '–' + f(max) : ''}${per}${currency && currency !== 'CAD' ? ' ' + currency : ''}`;
}

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*([kK])?`;
const CUR = String.raw`(CA\$|C\$|CAD\s?\$?|US\$|USD\s?\$?|\$)`;
const RANGE_RE = new RegExp(`${CUR}\\s?${NUM}\\s*(CAD|USD)?\\s*(?:(?:\\/|per\\s)\\s*(?:hour|hr|h|year|yr|annum|month)\\b)?\\s*(?:-|–|—|to|and)\\s*(?:${CUR})?\\s?${NUM}\\s*(CAD|USD)?`, 'g');
const SINGLE_RE = new RegExp(`${CUR}\\s?${NUM}\\s*(CAD|USD)?\\s*(?:\\/|per|an|a)\\s*(hour|hr|year|yr|annum|month|week)`, 'gi');
const PAY_CONTEXT = /(salary|pay|compensation|wage|hourly|rate|range|base|per hour|\/hour|\/hr|annual|stipend|earn)/i;

export function parseSalaryFromText(text = '', defaultCurrency = 'CAD') {
  if (!text || !text.includes('$')) return null;
  const candidates = [];
  for (const m of text.matchAll(RANGE_RE)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (/^\s*(million|billion|m\b|b\b|in funding|raised)/i.test(after)) continue;
    const before = text.slice(Math.max(0, m.index - 140), m.index);
    const cur = /US/.test(m[1] + (m[5] || '') + (m[6] || '') + (m[10] || '')) ? 'USD' : /CA|C\$/.test(m[1] + (m[5] || '') + (m[10] || '')) ? 'CAD' : defaultCurrency;
    const min = toNum(m[2], m[3], m[4]);
    const max = toNum(m[7], m[8], m[9] || (m[4] && !m[9] && toNum(m[7]) < 1000 ? m[4] : ''));
    const interval = intervalFromWords(m[0].replace(/^\D+/, '')) || intervalFromWords(after.slice(0, 30)) || intervalFromWords(before.slice(-60)) || '';
    const ctx = PAY_CONTEXT.test(before + after);
    // ranges outrank single amounts; need pay context or an explicit unit
    candidates.push({ min, max, currency: cur, interval, score: (ctx ? 2 : 0) + (interval ? 2 : 0) + 0.5, text: m[0].trim() });
  }
  for (const m of text.matchAll(SINGLE_RE)) {
    const before = text.slice(Math.max(0, m.index - 140), m.index);
    const cur = /US/.test(m[1] + (m[5] || '')) ? 'USD' : /CA|C\$/.test(m[1] + (m[5] || '')) ? 'CAD' : defaultCurrency;
    const v = toNum(m[2], m[3], m[4]);
    candidates.push({ min: v, max: v, currency: cur, interval: intervalFromWords(m[6]), score: 2 + (PAY_CONTEXT.test(before) ? 2 : 0), text: m[0].trim() });
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (c.score < 2) continue; // require pay context or an explicit interval
    const s = makeSalary(c);
    if (s) return { ...s, raw: c.text.replace(/\s+/g, ' ') };
  }
  return null;
}

// ---------- co-op term ----------
const SEASON = { winter: 'Winter', spring: 'Summer', summer: 'Summer', fall: 'Fall', autumn: 'Fall' };
const MONTH_TERM = { jan: 'Winter', feb: 'Winter', mar: 'Winter', apr: 'Winter', may: 'Summer', jun: 'Summer', jul: 'Summer', aug: 'Summer', sep: 'Fall', oct: 'Fall', nov: 'Fall', dec: 'Fall' };

export function detectTerms(title = '', text = '') {
  const t = `${title}\n${text.slice(0, 6000)}`;
  const terms = new Set();
  // "Winter 2027", "Summer Intern 2027", "Fall/Winter 2027", "Spring (May–Aug) 2027"
  for (const m of t.matchAll(/\b(winter|spring|summer|fall|autumn)\b(?:[\s,/&()–-]+[a-z][a-z/-]*){0,3}?[\s,(–-]+(20(?:2[6-8]))\b/gi)) terms.add(`${SEASON[m[1].toLowerCase()]} ${m[2]}`);
  for (const m of t.matchAll(/\b(20(?:2[6-8]))\s*(winter|spring|summer|fall|autumn)\b/gi)) terms.add(`${SEASON[m[2].toLowerCase()]} ${m[1]}`);
  for (const m of t.matchAll(/\b(?:start(?:ing|s)?|begin(?:ning|s)?|commenc\w*|from|term|period|duration)\b[^.\n]{0,40}?\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(?:\d{1,2}(?:st|nd|rd|th)?,?\s*)?(20(?:2[6-8]))/gi)) {
    terms.add(`${MONTH_TERM[m[1].toLowerCase().slice(0, 3)]} ${m[2]}`);
  }
  const dur = t.match(/\b(4|8|12|16|four|eight|twelve|sixteen)[- ]?months?\b/i);
  const durMap = { four: 4, eight: 8, twelve: 12, sixteen: 16 };
  const months = dur ? Number(durMap[dur[1].toLowerCase()] || dur[1]) : null;
  const list = [...terms];
  const eightMonth = months === 8 || (terms.has('Winter 2027') && terms.has('Summer 2027'));
  return { terms: list, durationMonths: months, eightMonth };
}

// ---------- student level ----------
const STUDENT_TITLE = /\b(interns?|internships?|co-?op|co-?operative|student|summer (analyst|associate)|work term|placement|apprentice(ship)?|trainee)\b/i;
export function isStudentRole(title = '', hints = []) {
  if (STUDENT_TITLE.test(title)) return true;
  return hints.some((h) => /intern|co-?op|student/i.test(String(h || '')));
}

// ---------- category ----------
const CAT_TITLE = {
  ux: /\b(ux|ui|ux\/ui|ui\/ux|user experience|user interface|product design(er)?|interaction design(er)?|visual design(er)?|graphic design(er)?|web design(er)?|designer|design|figma)\b/i,
  marketing: /\b(marketing|marketer|brand(ing)?|growth|communications?|comms|public relations|social media|digital media|campaigns?|advertising|e-?commerce|events?|community|partnerships|merchandis\w*|seo|crm|lifecycle)\b/i,
  content: /\b(content|video|editor|editorial|creative|copywrit\w*|writer|writing|storytell\w*|multimedia|media|production|photograph\w*|motion|animation|creator|social media|localization|translation|journalis\w*)\b/i,
};
const NOT_DESIGN = /\b(engineer(ing)?|hardware|circuit|asic|mechanical|electrical|chip|silicon|systems design|structural|civil|software design)\b/i;
const CAT_DESC = {
  ux: /\b(figma|wireframe|prototype|prototyping|user research|usability|design system|adobe xd|user flows?|ux|ui)\b/gi,
  marketing: /\b(marketing campaigns?|digital marketing|social media marketing|brand awareness|marketing team|go-to-market|newsletter|seo|marketing materials)\b/gi,
  content: /\b(content creation|video editing|premiere|capcut|copywriting|storytelling|short-form|photo|editorial|content calendar|tiktok|instagram|youtube)\b/gi,
};

export function categorize(title = '', text = '') {
  const cats = new Set();
  for (const [k, re] of Object.entries(CAT_TITLE)) {
    if (re.test(title) && !(k === 'ux' && NOT_DESIGN.test(title))) cats.add(k);
  }
  let source = cats.size ? 'title' : '';
  if (!cats.size) {
    const sample = text.slice(0, 6000);
    for (const [k, re] of Object.entries(CAT_DESC)) {
      const n = (sample.match(re) || []).length;
      if (n >= 3) cats.add(k);
    }
    if (cats.size) source = 'description';
  }
  return { categories: [...cats], categorySource: source };
}

// ---------- eligibility (study permit + co-op work permit, no PR/citizenship) ----------
export function checkEligibility({ loc, workMode, text = '', company = '' }) {
  const reasons = [];
  let status = 'ok';
  const block = (r) => { status = 'blocked'; reasons.push(r); };
  const warn = (r) => { if (status === 'ok') status = 'warn'; reasons.push(r); };
  const t = text.slice(0, 15000);

  if (loc.nonCanadaOnly) block('Located outside Canada. A Canadian co-op work permit does not authorize work there (US roles need a J-1/other US visa).');
  const CIT = /\b(must be|you are|be) (a )?(canadian citizen|citizen of canada)\b|\bcanadian citizens?,? (and|or|\/) permanent residents?\b|\bcitizenship (is )?required\b|\bopen (only )?to canadian citizens\b|\bpermanent residents? only\b|\bmust (hold|have) (canadian )?(citizenship|permanent residen(ce|cy))\b/gi;
  for (const m of t.matchAll(CIT)) {
    const ctx = t.slice(Math.max(0, m.index - 200), m.index + m[0].length + 200);
    if (/work permit|international students?|study permit|legally (eligible|entitled)|protected person|refugee/i.test(ctx) && !/(swpp|wage subsid|canada summer jobs)/i.test(ctx)) {
      if (/(priority|preference|preferred)/i.test(ctx)) warn('Gives priority to citizens/PRs, but work-permit holders can apply.');
      continue;
    }
    if (/(priority|preference|preferred|given priority)/i.test(ctx)) warn('Gives preference to Canadian citizens/PRs. You can apply, but you may be ranked lower.');
    else block('Posting requires Canadian citizenship or permanent residence.');
    break;
  }
  if (/\b(swpp|student work placement program|canada summer jobs|wage subsid(y|ies|ized)|career launcher|youth employment and skills strategy|yess)\b/i.test(t))
    warn('Mentions a government wage subsidy (SWPP / Canada Summer Jobs / YESS). These programs only cover citizens, PRs and refugees, so ask whether the role still accepts international students.');
  if (/\b(u\.?s\.? citizen(ship)?|us person|itar|export[- ]control(led)?|green card)\b/i.test(t) && !loc.isCanada) block('Requires US citizenship/US-person status.');
  if (/\b(secret|top secret|security) clearance\b/i.test(t)) warn('Mentions a security clearance. These usually require several years of residence in Canada, so check eligibility.');
  if (/\bfswep\b|\bfederal student work experience program\b|\bgovernment of canada\b/i.test(t)) warn('Federal student programs give preference to Canadian citizens/PRs. You can apply, but you may be ranked lower.');
  if (/\b(no|not able to|unable to|cannot|will not|won['’]t) (provide |offer )?(visa |immigration )?sponsor(ship)?\b/i.test(t) && loc.isCanada) reasons.push('Says "no sponsorship". That\'s fine for you: your co-op work permit covers co-op terms.');
  if (workMode === 'remote' && !loc.isCanada) warn('Remote role but the country isn\'t stated. Confirm it can be done from Canada.');
  if (loc.country === 'UNKNOWN' && workMode !== 'remote') warn('Location not stated. Check that it is in Canada.');
  if (/\b(must be|currently) (enrolled|registered) in (a |an )?(accredited )?(u\.?s\.?|american) (university|college)\b/i.test(t)) block('Requires enrollment at a US university.');

  return { status, reasons };
}

// ---------- assemble ----------
export function hashText(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * raw: { source, ats, companyKey, company, extId, title, url, applyUrl, locations[], workModeHint,
 *        descriptionHtml | description, salary (structured {min,max,currency,interval}), salaryText,
 *        postedAt, deadline, employmentType, hints[] }
 */
export function normalizeJob(raw) {
  const description = (raw.description || htmlToText(raw.descriptionHtml || '')).slice(0, 20000);
  const title = decodeEntities(String(raw.title || '').trim());
  const loc = parseLocations(raw.locations);
  const workMode = detectWorkMode({ hint: raw.workModeHint, locations: raw.locations || [], text: description });
  const defCur = loc.isCanada ? 'CAD' : loc.country === 'US' ? 'USD' : 'CAD';
  const salary =
    (raw.salary && makeSalary({ ...raw.salary, currency: raw.salary.currency || defCur })) ||
    parseSalaryFromText(raw.salaryText || '', defCur) ||
    parseSalaryFromText(description, defCur);
  const term = detectTerms(title, description);
  const { categories, categorySource } = categorize(title, description);
  const student = isStudentRole(title, [raw.employmentType, ...(raw.hints || [])]);
  const eligibility = checkEligibility({ loc, workMode, text: description, company: raw.company });
  return {
    id: (raw.companyKey ? `${raw.companyKey}:${raw.extId}` : `${raw.source}:${raw.company}:${raw.extId}`).toLowerCase().replace(/\s+/g, '-'),
    source: raw.source,
    companyKey: raw.companyKey || '',
    company: decodeEntities(raw.company || ''),
    title,
    url: raw.url,
    applyUrl: raw.applyUrl || raw.url,
    location: loc,
    workMode,
    salary,
    term,
    categories,
    categorySource,
    student,
    eligibility,
    employmentType: raw.employmentType || '',
    postedAt: raw.postedAt || '',
    deadline: raw.deadline || '',
    description,
    textHash: hashText(title + description.slice(0, 6000)),
  };
}
