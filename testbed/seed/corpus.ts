import { deflateSync } from 'node:zlib';

/** Deterministic test data: publishers, readers, and posts built from per-topic phrase lists. */

export type Rng = () => number;

/** mulberry32: small and seedable, so every seed run produces the same data. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
export const between = (r: Rng, min: number, max: number) => min + Math.floor(r() * (max - min + 1));

export function shuffle<T>(r: Rng, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export const sample = <T>(r: Rng, xs: readonly T[], n: number) => shuffle(r, xs).slice(0, n);

/** Standard normal, by Box-Muller. */
export const gauss = (r: Rng) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

export type TopicName = 'news' | 'tech' | 'science' | 'business' | 'sports' | 'culture';

interface Topic {
  /** Base colour of the topic's generated pictures. */
  color: [number, number, number];
  /** Sentences any post on the topic can carry. */
  lines: string[];
}

interface Beat {
  topic: TopicName;
  subjects: string[];
  /** Past tense, so they agree with singular and plural subjects. */
  actions: string[];
  details: string[];
}

export const TOPICS: Record<TopicName, Topic> = {
  news: {
    color: [52, 84, 140],
    lines: [
      'Officials said a fuller statement would follow later in the day.',
      'Residents we spoke to were divided on what should happen next.',
      'The figures have not yet been independently verified.',
      'Opposition members called for a public hearing on the matter.',
      'Similar measures were tried two years ago with mixed results.',
      'A spokesperson declined to comment on the timeline.',
      'Local groups have organised a meeting for later this week.',
      'Several readers wrote in with photos and first-hand accounts.',
    ],
  },
  tech: {
    color: [38, 120, 112],
    lines: [
      'The release notes list several breaking changes, so read them before upgrading.',
      'Early benchmarks look promising, though real workloads may differ.',
      'Pricing has not been announced, and availability is limited to a few regions for now.',
      'Developers on the forums were quick to point out edge cases.',
      'The source code is available, along with a short migration guide.',
      'Security researchers were invited to test it before the wider launch.',
      'Battery life and thermals remain the open questions.',
      'The team says a roadmap for the next quarter will be published soon.',
    ],
  },
  science: {
    color: [96, 64, 150],
    lines: [
      'The study was peer reviewed and the data set has been made public.',
      'The authors caution that the sample size is still small.',
      'Independent teams will need to replicate the result before it is widely accepted.',
      'Observations will continue through the next season.',
      'Funding for the follow-up phase is still under discussion.',
      'The findings line up with models published earlier this year.',
      'Field teams collected samples over several weeks.',
      'Researchers say the next step is a larger, longer trial.',
    ],
  },
  business: {
    color: [150, 112, 40],
    lines: [
      'Trading volumes were above the monthly average.',
      'Analysts were split on whether the move is already priced in.',
      'The company will report full quarterly results next month.',
      'Smaller firms say they are watching costs closely.',
      'Bond yields barely moved on the news.',
      'Regulators said they are monitoring the situation.',
      'Investors will be looking for guidance on margins.',
      'Currency markets reacted within minutes of the announcement.',
    ],
  },
  sports: {
    color: [40, 130, 60],
    lines: [
      "The coach praised the squad's discipline in the closing stages.",
      'Fans packed the stands despite the weather.',
      'The result keeps them in contention heading into the final stretch.',
      'Injury updates are expected before the next fixture.',
      "It was the side's best performance of the season so far.",
      'The numbers show a big jump in chances created.',
      'The rematch is already sold out.',
      'Pundits were quick to call it a turning point.',
    ],
  },
  culture: {
    color: [170, 60, 90],
    lines: [
      'Tickets sold out within hours of going on sale.',
      'Critics have been mostly positive, with a few dissenting voices.',
      "The full list is available on the organisers' site.",
      "It's the kind of thing worth seeing in person if you can.",
      'Fans have already started sharing their favourite moments.',
      'The second half is stronger than the first.',
      'Prices are reasonable and portions are generous.',
      'Bring a jacket: evenings get cool this time of year.',
    ],
  },
};

const ANY_TOPIC = [
  "We'll update this post as more details come in.",
  "Let us know what you're seeing where you are.",
  'Photos and links are in the thread below.',
  'This is a developing story.',
  'Thanks to the readers who sent tips.',
  'More coverage is linked from our front page.',
];

export const BEATS: Record<string, Beat> = {
  world: {
    topic: 'news',
    subjects: ['Delegates at the climate summit', 'Foreign ministers from the region', 'Aid agencies', 'The UN Security Council'],
    actions: ['agreed on a joint statement', 'extended talks by another day', 'called for an immediate ceasefire', 'announced new funding for refugees', 'warned of food shortages'],
    details: ['after overnight negotiations', 'in a closed-door session', 'ahead of the winter months'],
  },
  politics: {
    topic: 'news',
    subjects: ['The finance committee', 'Opposition leaders', 'The new cabinet', 'Backbench members'],
    actions: ['blocked a late amendment', 'published a spending review', 'demanded an independent inquiry', 'unveiled a housing bill', 'clashed over the budget timetable'],
    details: ['during a heated session', 'before the recess', 'after weeks of negotiation'],
  },
  elections: {
    topic: 'news',
    subjects: ['Election officials', 'Both campaigns', 'Pollsters', 'Volunteer groups'],
    actions: ['released early-voting numbers', 'pointed to a tighter race than expected', 'stepped up door-to-door canvassing', 'flagged problems with mail-in ballots', 'scheduled a final televised debate'],
    details: ['in the swing districts', 'with two weeks to go', 'across the northern counties'],
  },
  mumbai: {
    topic: 'news',
    subjects: ['Commuters in Andheri', 'The BMC', 'Residents of Dadar', 'Vendors at Crawford Market'],
    actions: ['reported long delays on the Western line', 'announced a new drainage plan', 'pushed back on proposed parking fees', 'prepared for the festival crowds', 'cleared encroachments along the coast road'],
    details: ['near the Western Express Highway', 'ahead of the civic budget', 'in the island city wards'],
  },
  monsoon: {
    topic: 'news',
    subjects: ['The weather office', 'Farmers in Vidarbha', 'Coastal districts', 'Disaster response teams'],
    actions: ['issued an orange alert', 'welcomed the early onset of rain', 'reported waterlogging in low-lying areas', 'moved boats and pumps into position', 'recorded the wettest week in a decade'],
    details: ['for the next 48 hours', 'along the Konkan coast', 'as reservoirs filled up'],
  },
  london: {
    topic: 'news',
    subjects: ['Transport for London', 'Camden residents', "The Mayor's office", 'Small shops on Oxford Street'],
    actions: ['extended night services on the Elizabeth line', 'objected to a new tower block', 'launched a clean-air consultation', 'reported a busy start to the holiday season', 'unveiled plans for more cycle lanes'],
    details: ['in zones one and two', 'after a public consultation', 'despite the drizzle'],
  },
  nyc: {
    topic: 'news',
    subjects: ['Subway riders in Queens', 'The city council', 'Restaurant owners in the East Village', 'Parks department crews'],
    actions: ['faced weekend service changes', 'passed a new rental-housing rule', 'pushed for permanent outdoor dining', 'planted two thousand street trees', 'tested new congestion-pricing signs'],
    details: ['in lower Manhattan', 'before the holiday rush', 'across all five boroughs'],
  },
  transit: {
    topic: 'news',
    subjects: ['The new metro line', 'Bus drivers', 'Rail operators', 'Cycle-share schemes'],
    actions: ['opened three new stations', 'voted to accept a pay deal', 'trialled contactless fares', 'reported record ridership', 'paused services for track repairs'],
    details: ['during the morning peak', 'for the first time', 'after months of delays'],
  },
  ai: {
    topic: 'tech',
    subjects: ['An open-weights language model', 'A research lab', 'A new coding assistant', 'Chipmakers'],
    actions: ['topped a reasoning benchmark', 'published a paper on model evaluations', 'added support for long-running agents', 'announced a cheaper inference tier', 'shipped a smaller model that runs on laptops'],
    details: ['with a permissive licence', 'alongside a detailed system card', 'after months of private testing'],
  },
  startups: {
    topic: 'tech',
    subjects: ['A two-person startup', 'A climate-tech company', 'A payments startup', 'A seed-stage founder'],
    actions: ['raised a twelve-million-dollar round', 'launched publicly after a long beta', 'laid off a fifth of its staff', 'was acquired by a larger rival', 'opened a first office abroad'],
    details: ['led by a well-known fund', 'with paying customers already signed up', 'after a difficult year'],
  },
  programming: {
    topic: 'tech',
    subjects: ['The TypeScript team', 'A popular web framework', 'Rust maintainers', 'A database driver'],
    actions: ['released a major version', 'deprecated a long-standing API', 'cut build times in half', 'fixed a subtle concurrency bug', 'published a new style guide'],
    details: ['with a migration guide', 'after a long RFC process', 'thanks to community contributions'],
  },
  opensource: {
    topic: 'tech',
    subjects: ['A widely used logging library', 'Maintainers of a JavaScript bundler', 'A software foundation', 'Volunteer contributors'],
    actions: ['changed its licence', 'asked companies for funding', 'shipped a first stable release', 'moved to a new governance model', 'archived an unmaintained package'],
    details: ['after a community vote', 'citing burnout', 'following a security audit'],
  },
  gadgets: {
    topic: 'tech',
    subjects: ['A new folding phone', 'A pair of noise-cancelling earbuds', 'An e-reader', 'A budget laptop'],
    actions: ['went on sale', 'got a major software update', 'was reviewed by our team', 'was recalled over battery problems', 'dropped in price'],
    details: ['in a limited set of colours', 'ahead of the holidays', 'in most markets'],
  },
  cybersecurity: {
    topic: 'tech',
    subjects: ['A ransomware group', 'Researchers', 'A major retailer', 'The national cyber agency'],
    actions: ['claimed responsibility for a data breach', 'disclosed a flaw in popular routers', 'reset millions of customer passwords', 'issued an urgent patch advisory', 'took down a phishing network'],
    details: ['affecting several million accounts', 'before it was widely exploited', 'in a coordinated operation'],
  },
  space: {
    topic: 'science',
    subjects: ['A lunar lander', 'The space telescope', 'A reusable rocket', 'Astronomers'],
    actions: ['touched down near the south pole', 'captured a new image of a distant galaxy', 'landed its booster for the twentieth time', 'detected water vapour on an exoplanet', 'tracked a near-Earth asteroid'],
    details: ['in a first for the agency', 'with remarkable clarity', 'during a rare alignment'],
  },
  climate: {
    topic: 'science',
    subjects: ['A new heat report', 'Offshore wind farms', 'Glaciologists', 'Several cities'],
    actions: ['found last month was the warmest on record', 'supplied a record share of the grid', 'measured faster ice loss than expected', 'adopted heat-action plans', 'pledged to phase out coal power'],
    details: ['by a wide margin', 'over the summer', 'ahead of the climate conference'],
  },
  biology: {
    topic: 'science',
    subjects: ['Marine biologists', 'A gene-editing team', 'Field researchers', 'A new species of frog'],
    actions: ['mapped a deep-sea coral reef', 'reversed a rare inherited disease in mice', 'tracked migrating birds with tiny sensors', 'was described from the cloud forests', 'sequenced an ancient genome'],
    details: ['for the first time', 'using new imaging techniques', 'in a remote valley'],
  },
  health: {
    topic: 'science',
    subjects: ['A large trial', 'Public health officials', 'Doctors', 'A new vaccine'],
    actions: ['found that regular walking cuts heart risk', 'recommended updated flu shots', 'warned about a rise in measles cases', 'cleared its final round of testing', 'linked poor sleep to higher stress'],
    details: ['in adults over fifty', 'ahead of the winter season', 'across several countries'],
  },
  markets: {
    topic: 'business',
    subjects: ['Global stocks', 'Tech shares', 'Oil prices', 'Bank stocks'],
    actions: ['closed at a record high', 'fell after a weak earnings report', 'rose on supply concerns', 'rallied on hopes of a rate cut', 'swung wildly in late trading'],
    details: ['on Friday', 'for a third straight session', 'as investors digested the data'],
  },
  economy: {
    topic: 'business',
    subjects: ['The central bank', 'Inflation', 'Retail sales', 'The jobs report'],
    actions: ['held interest rates steady', 'cooled for a fourth month', 'beat expectations', 'showed slower hiring', 'raised the growth forecast'],
    details: ['in line with forecasts', 'despite higher energy costs', 'heading into the holiday season'],
  },
  crypto: {
    topic: 'business',
    subjects: ['Bitcoin', 'A large stablecoin issuer', 'Regulators', 'A crypto exchange'],
    actions: ['climbed past a key level', 'published a reserve audit', 'proposed new custody rules', 'paused withdrawals for maintenance', 'was fined for compliance failures'],
    details: ['amid heavy trading', 'for the first time this year', 'after a week of volatility'],
  },
  football: {
    topic: 'sports',
    subjects: ['The league leaders', 'A teenage striker', 'The defending champions', 'The national team'],
    actions: ['won a late thriller', 'scored a hat-trick on debut', 'were knocked out in the quarter-finals', 'named a new manager', 'kept a sixth straight clean sheet'],
    details: ['in stoppage time', 'in front of a sell-out crowd', 'away from home'],
  },
  basketball: {
    topic: 'sports',
    subjects: ['The rookie point guard', 'The home side', 'A veteran centre', 'The conference leaders'],
    actions: ['dropped forty points', 'snapped a five-game losing streak', 'announced a retirement', 'clinched a playoff spot', 'won in double overtime'],
    details: ['on the road', 'in the final seconds', 'with a dominant fourth quarter'],
  },
  cricket: {
    topic: 'sports',
    subjects: ['India', 'The Mumbai side', 'A young leg-spinner', 'The touring team'],
    actions: ['chased down a big total', 'won the Ranji Trophy final', 'took a five-wicket haul', 'collapsed on the final morning', 'declared on the second day'],
    details: ['at the Wankhede', 'with an over to spare', 'under lights'],
  },
  tennis: {
    topic: 'sports',
    subjects: ['The world number one', 'A qualifier', 'The doubles pair', 'The defending champion'],
    actions: ['won in straight sets', 'reached a first major semi-final', 'saved three match points', 'withdrew with an injury', 'lifted the trophy'],
    details: ['on centre court', 'in under two hours', 'after a rain delay'],
  },
  f1: {
    topic: 'sports',
    subjects: ['The championship leader', 'A rookie driver', 'The works team', 'The safety car'],
    actions: ['took pole position', 'scored a first podium', 'switched to a two-stop strategy', 'decided the race in the final laps', 'brought upgrades to the car'],
    details: ['in wet conditions', 'at the street circuit', 'by a tenth of a second'],
  },
  music: {
    topic: 'culture',
    subjects: ['A surprise album', 'The festival line-up', 'An indie band from Leeds', 'A classical pianist'],
    actions: ['topped the charts', 'was announced', 'played a secret gig', 'released a live recording', 'sold out a world tour'],
    details: ['in its first week', 'for next summer', 'in a tiny venue'],
  },
  movies: {
    topic: 'culture',
    subjects: ['A low-budget horror film', 'The new space epic', 'A documentary about chess', 'The festival jury'],
    actions: ['beat expectations at the box office', 'drew mixed reviews', 'won the audience award', 'premiered to a standing ovation', 'landed a streaming deal'],
    details: ['on its opening weekend', 'at the film festival', 'after a long wait'],
  },
  books: {
    topic: 'culture',
    subjects: ['A debut novel', 'A memoir by a former diplomat', 'The prize committee', 'A graphic novel'],
    actions: ['made the shortlist', 'became a surprise bestseller', "announced this year's winner", 'was adapted for television', 'was translated into thirty languages'],
    details: ['this autumn', 'after word-of-mouth success', 'in a crowded year'],
  },
  gaming: {
    topic: 'culture',
    subjects: ['A small indie studio', 'The long-awaited sequel', 'A handheld console', 'An esports team'],
    actions: ['shipped a surprise update', 'was delayed until spring', 'sold out on launch day', 'won the world championship', 'added cross-platform saves'],
    details: ['with a free demo', 'after fan feedback', 'in a nail-biting final'],
  },
  food: {
    topic: 'culture',
    subjects: ['A night market stall', 'A neighbourhood bakery', 'A new ramen bar', 'Street vendors near Juhu beach'],
    actions: ['drew queues around the block', 'won a regional award', 'opened a second branch', 'added a vegan menu', 'brought back a seasonal favourite'],
    details: ['on its first weekend', 'for the festive season', 'at friendly prices'],
  },
  travel: {
    topic: 'culture',
    subjects: ['A scenic rail route', 'Budget airlines', 'A mountain village', 'Island ferries'],
    actions: ['reopened after repairs', 'added new winter routes', 'saw a surge in visitors', 'introduced a tourist tax', 'resumed daily sailings'],
    details: ['in time for the holidays', 'after a quiet season', 'with cheaper midweek fares'],
  },
  photography: {
    topic: 'culture',
    subjects: ['Our photographer', 'A reader', 'A street photographer', 'A wildlife photographer'],
    actions: ['captured the city at blue hour', 'shared a shot of the first snowfall', 'documented a busy market morning', 'photographed a rare owl', 'caught a lightning storm over the bay'],
    details: ['from a rooftop', 'on a long exposure', 'with a vintage lens'],
  },
};

export interface PublisherSpec {
  username: string;
  host: string;
  beats: string[];
  /** Relative appeal: scales how often they post and how many likes they get. */
  pull: number;
  /** Share of their posts that are pictures. */
  images?: number;
}

export const PUBLISHERS: PublisherSpec[] = [
  { username: 'Mumbai Monitor', host: 'mumbaimonitor', beats: ['mumbai', 'monsoon', 'transit', 'politics'], pull: 1.3 },
  { username: 'World Desk', host: 'worlddesk', beats: ['world', 'politics', 'elections'], pull: 1.6 },
  { username: 'London Loop', host: 'londonloop', beats: ['london', 'transit', 'politics'], pull: 0.9 },
  { username: 'Five Boroughs Daily', host: 'fiveboroughs', beats: ['nyc', 'transit', 'elections'], pull: 1.0 },
  { username: 'Civic Ledger', host: 'civicledger', beats: ['politics', 'elections', 'economy'], pull: 0.8 },
  { username: 'AI Dispatch', host: 'aidispatch', beats: ['ai', 'startups', 'opensource'], pull: 1.8 },
  { username: 'Byte Street', host: 'bytestreet', beats: ['gadgets', 'ai', 'cybersecurity'], pull: 1.1 },
  { username: 'Commit Log', host: 'commitlog', beats: ['programming', 'opensource'], pull: 0.9 },
  { username: 'Founders Notebook', host: 'foundersnotebook', beats: ['startups', 'markets', 'ai'], pull: 0.7 },
  { username: 'Zero Day Weekly', host: 'zerodayweekly', beats: ['cybersecurity'], pull: 0.8 },
  { username: 'Orbit Weekly', host: 'orbitweekly', beats: ['space'], pull: 1.4, images: 0.2 },
  { username: 'Climate Desk', host: 'climatedesk', beats: ['climate', 'monsoon'], pull: 1.0 },
  { username: 'Field Notes', host: 'fieldnotes', beats: ['biology', 'health', 'climate'], pull: 0.8 },
  { username: 'Daily Dose', host: 'dailydose', beats: ['health'], pull: 1.0 },
  { username: 'Market Pulse', host: 'marketpulse', beats: ['markets', 'economy'], pull: 1.2 },
  { username: 'Chain Reaction', host: 'chainreaction', beats: ['crypto', 'markets'], pull: 0.9 },
  { username: 'Pitchside', host: 'pitchside', beats: ['football'], pull: 1.5 },
  { username: 'Courtside', host: 'courtside', beats: ['basketball'], pull: 1.1 },
  { username: 'Silly Point', host: 'sillypoint', beats: ['cricket', 'mumbai'], pull: 1.2 },
  { username: 'Pit Wall', host: 'pitwall', beats: ['f1', 'tennis'], pull: 0.9 },
  { username: 'Reel Talk', host: 'reeltalk', beats: ['movies', 'books'], pull: 1.1 },
  { username: 'Signal and Noise', host: 'signalandnoise', beats: ['music'], pull: 1.0 },
  { username: 'Pixel Post', host: 'pixelpost', beats: ['gaming', 'gadgets'], pull: 1.2 },
  { username: 'Night Market', host: 'nightmarket', beats: ['food', 'travel', 'mumbai'], pull: 1.0, images: 0.25 },
  { username: 'Wanderlog', host: 'wanderlog', beats: ['travel', 'photography'], pull: 0.8, images: 0.4 },
  { username: 'Lens and Light', host: 'lensandlight', beats: ['photography'], pull: 0.9, images: 0.7 },
];

const FIRST = [
  'maya', 'liam', 'aisha', 'noah', 'priya', 'diego', 'sofia', 'kenji', 'amara', 'lucas', 'zara', 'omar', 'elena', 'ravi',
  'chloe', 'mateo', 'nina', 'arjun', 'leah', 'samir', 'ivy', 'tomas', 'yuki', 'grace', 'felix', 'ines', 'kofi', 'hana',
  'jonah', 'mira', 'theo', 'anya', 'ben', 'lola', 'dev', 'rosa', 'sam', 'tara', 'eli', 'nora',
];
const LAST = [
  'chen', 'patel', 'okafor', 'garcia', 'kim', 'silva', 'nguyen', 'mehta', 'rossi', 'khan',
  'dubois', 'sato', 'novak', 'adeyemi', 'larsen', 'costa', 'ali', 'murphy', 'iyer', 'park',
];

/** Unique reader handles such as "maya_chen". */
export function readerNames(r: Rng, n: number): string[] {
  const names = new Set<string>();
  while (names.size < n) {
    const name = `${pick(r, FIRST)}_${pick(r, LAST)}`;
    names.add(names.has(name) ? `${name}${between(r, 2, 99)}` : name);
  }
  return [...names];
}

/** A reader's interests: two or three beats from one or two topics, sometimes a broad topic tag too. */
export function interests(r: Rng): string[] {
  const beats = Object.keys(BEATS);
  const topics = sample(r, Object.keys(TOPICS) as TopicName[], between(r, 1, 2));
  const near = beats.filter((b) => topics.includes(BEATS[b]!.topic));
  const picked = new Set([...sample(r, near, between(r, 2, 3)), pick(r, beats)]);
  if (r() < 0.4) picked.add(topics[0]!);
  return [...picked];
}

export const topicOf = (beat: string) => BEATS[beat]!.topic;

export interface Article {
  title: string;
  /** The first sentence: the title plus a detail. It opens the first paragraph. */
  lead: string;
  paragraphs: string[];
}

/** A text post of roughly 90 to 200 words, with its hashtags appended about half the time. */
export function article(r: Rng, beat: string, tags: string[]): Article {
  const b = BEATS[beat]!;
  const topic = TOPICS[b.topic];
  const subject = pick(r, b.subjects);
  const action = pick(r, b.actions);
  const detail = pick(r, b.details);
  const title = `${subject} ${action}`;
  const lead = `${title} ${detail}.`;
  const lines = sample(r, topic.lines, between(r, 4, 7));
  const extra = sample(r, ANY_TOPIC, between(r, 1, 2));
  const paragraphs = [`${lead} ${lines[0]} ${lines[1]}`, lines.slice(2, 4).join(' '), [...lines.slice(4), ...extra].join(' ')];
  if (r() < 0.5) paragraphs.push(tags.map((t) => `#${t}`).join(' '));
  return { title, lead, paragraphs };
}

export const articleText = (a: Article) => a.paragraphs.join('\n\n');

/** The title as a heading, so the first paragraph drops the lead sentence that repeats it. */
export function articleHtml(a: Article): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = [a.paragraphs[0]!.slice(a.lead.length).trim(), ...a.paragraphs.slice(1)];
  return `<!doctype html><html><head><title>${esc(a.title)}</title></head><body><article><h1>${esc(a.title)}</h1>${paragraphs
    .map((p) => `<p>${esc(p)}</p>`)
    .join('')}</article></body></html>`;
}

export function updateNote(r: Rng): string {
  return pick(r, [
    'Update: corrected a figure in the second paragraph.',
    'Update: added a statement received after publication.',
    'Update: this post has been revised with new details.',
    'Update: clarified the timeline after reader feedback.',
  ]);
}

/** A soft gradient with a few translucent circles, tinted by topic: a stand-in photo. */
export function picture(r: Rng, topic: TopicName, width = 480, height = 270): Buffer {
  const [br, bg, bb] = TOPICS[topic].color;
  const accent = [between(r, 120, 255), between(r, 120, 255), between(r, 120, 255)] as const;
  const circles = Array.from({ length: between(r, 3, 7) }, () => ({
    x: r() * width,
    y: r() * height,
    rad: 20 + r() * 90,
    c: [between(r, 160, 255), between(r, 160, 255), between(r, 160, 255)] as const,
  }));
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      let px = [br + (accent[0] - br) * t, bg + (accent[1] - bg) * t, bb + (accent[2] - bb) * t];
      for (const c of circles) {
        const d = Math.hypot(x - c.x, y - c.y);
        if (d < c.rad) {
          const a = 0.35 * (1 - d / c.rad);
          px = px.map((v, i) => v + (c.c[i]! - v) * a);
        }
      }
      raw.set(px.map((v) => Math.round(v)), row + 1 + x * 3);
    }
  }
  return encodePng(width, height, raw);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** 8-bit RGB PNG from rows that each start with a filter byte (0, none). */
function encodePng(width: number, height: number, raw: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
