/**
 * Values that are generated rather than looked up: `{{$uuid}}`,
 * `{{$timestamp -1 d}}`, `{{$datetime "YYYY-MM-DD" 1 w}}`,
 * `{{$random.integer(1, 100)}}`, `{{$random.name.fullName}}` and the rest of
 * the VS Code, JetBrains and httpyac sets.
 */
import { randomInt as cryptoInt, randomUUID } from "node:crypto";

const UNITS: Record<string, (d: Date, n: number) => void> = {
  y: (d, n) => d.setUTCFullYear(d.getUTCFullYear() + n),
  M: (d, n) => d.setUTCMonth(d.getUTCMonth() + n),
  w: (d, n) => d.setTime(d.getTime() + n * 7 * 864e5),
  d: (d, n) => d.setTime(d.getTime() + n * 864e5),
  h: (d, n) => d.setTime(d.getTime() + n * 36e5),
  m: (d, n) => d.setTime(d.getTime() + n * 6e4),
  s: (d, n) => d.setTime(d.getTime() + n * 1e3),
  ms: (d, n) => d.setTime(d.getTime() + n),
};

/** Apply `offset unit` pairs to a date. */
export function offsetDate(base: Date, args: string[]): Date {
  const d = new Date(base.getTime());
  for (let i = 0; i + 1 < args.length; i += 2) {
    const n = Number(args[i]);
    const unit = UNITS[args[i + 1]!];
    if (!Number.isFinite(n) || !unit) throw new Error(`bad date offset "${args[i]} ${args[i + 1]}" (units: y M w d h m s ms)`);
    unit(d, n);
  }
  return d;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number, w = 2): string => String(Math.abs(n)).padStart(w, "0");

/** Day.js format tokens, plus `rfc1123` and `iso8601`. */
export function formatDate(date: Date, format: string, utc: boolean): string {
  if (format === "rfc1123") return date.toUTCString();
  if (format === "iso8601") {
    if (utc) return date.toISOString();
    return formatDate(date, "YYYY-MM-DDTHH:mm:ss.SSSZ", false);
  }
  const get = {
    Y: utc ? date.getUTCFullYear() : date.getFullYear(),
    M: utc ? date.getUTCMonth() : date.getMonth(),
    D: utc ? date.getUTCDate() : date.getDate(),
    d: utc ? date.getUTCDay() : date.getDay(),
    H: utc ? date.getUTCHours() : date.getHours(),
    m: utc ? date.getUTCMinutes() : date.getMinutes(),
    s: utc ? date.getUTCSeconds() : date.getSeconds(),
    S: utc ? date.getUTCMilliseconds() : date.getMilliseconds(),
  };
  const offset = utc ? 0 : -date.getTimezoneOffset();
  const zone = (sep: string): string => `${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}${sep}${pad(Math.abs(offset) % 60)}`;
  const tokens: Record<string, () => string> = {
    YYYY: () => String(get.Y), YY: () => pad(get.Y % 100),
    MMMM: () => MONTHS[get.M]!, MMM: () => MONTHS[get.M]!.slice(0, 3), MM: () => pad(get.M + 1), M: () => String(get.M + 1),
    DD: () => pad(get.D), D: () => String(get.D),
    dddd: () => DAYS[get.d]!, ddd: () => DAYS[get.d]!.slice(0, 3), dd: () => DAYS[get.d]!.slice(0, 2), d: () => String(get.d),
    HH: () => pad(get.H), H: () => String(get.H),
    hh: () => pad(get.H % 12 || 12), h: () => String(get.H % 12 || 12),
    mm: () => pad(get.m), m: () => String(get.m),
    ss: () => pad(get.s), s: () => String(get.s),
    SSS: () => pad(get.S, 3),
    A: () => get.H < 12 ? "AM" : "PM", a: () => get.H < 12 ? "am" : "pm",
    ZZ: () => zone(""), Z: () => zone(":"),
    X: () => String(Math.floor(date.getTime() / 1000)), x: () => String(date.getTime()),
  };
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|SSS|A|a|ZZ|Z|X|x/g, (match, literal: string | undefined) =>
    literal !== undefined ? literal : tokens[match]!());
}

/** Split dynamic-variable arguments: words, "quoted strings" and 'quoted strings'. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

const int = (min: number, max: number): number => max <= min ? min : cryptoInt(min, max);
const pick = <T>(list: readonly T[]): T => list[int(0, list.length)]!;
const chars = (alphabet: string, n: number): string => Array.from({ length: Math.max(0, n) }, () => alphabet[int(0, alphabet.length)]).join("");
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const ALPHA = LOWER + LOWER.toUpperCase();

const FIRST = ["James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda", "William", "Elizabeth", "David", "Barbara", "Richard", "Susan", "Joseph", "Jessica", "Thomas", "Sarah", "Ana", "Wei", "Aisha", "Mateo", "Yuki", "Priya", "Lucas", "Sofia", "Omar", "Ingrid"];
const LAST = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Chen", "Nguyen", "Kim", "Patel", "Okafor", "Larsen"];
const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat".split(" ");
const CITIES = ["Springfield", "Riverside", "Fairview", "Madison", "Georgetown", "Salem", "Clinton", "Franklin", "Bristol", "Ashland", "Oakland", "Portland"];
const STATES = ["California", "Texas", "New York", "Florida", "Oregon", "Ohio", "Georgia", "Washington", "Colorado", "Arizona"];
const COUNTRIES = ["United States", "Canada", "Germany", "France", "Japan", "Brazil", "India", "Australia", "Mexico", "Spain", "Norway", "Kenya"];
const STREETS = ["Main", "Oak", "Pine", "Maple", "Cedar", "Elm", "Washington", "Lake", "Hill", "Park"];
const SUFFIX = ["Street", "Avenue", "Road", "Lane", "Drive", "Court", "Way", "Boulevard"];
const INDUSTRIES = ["Software", "Healthcare", "Finance", "Retail", "Manufacturing", "Logistics", "Education", "Energy", "Media", "Agriculture"];
const BUZZ = ["synergy", "paradigm", "scalable", "cloud-native", "holistic", "real-time", "end-to-end", "mission-critical", "frictionless", "agile"];
const PRODUCTS = ["Chair", "Table", "Keyboard", "Lamp", "Shoes", "Backpack", "Watch", "Bottle", "Jacket", "Headphones"];
const ADJ = ["Ergonomic", "Rustic", "Sleek", "Practical", "Handmade", "Incredible", "Refined", "Small", "Durable", "Gorgeous"];
const MATERIALS = ["Steel", "Wooden", "Cotton", "Plastic", "Granite", "Rubber", "Leather", "Bronze", "Glass", "Bamboo"];
const COLORS = ["red", "blue", "green", "black", "white", "orange", "purple", "teal", "silver", "gold"];
const TLDS = ["com", "net", "org", "io", "dev", "app"];
const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "SEK", "INR", "BRL"];
const JOBS = ["Engineer", "Designer", "Manager", "Analyst", "Consultant", "Developer", "Architect", "Specialist", "Director", "Coordinator"];

function luhn(prefix: string, length: number): string {
  let n = prefix + chars("0123456789", length - prefix.length - 1);
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return n + String((10 - (sum % 10)) % 10);
}

const word = (): string => pick(WORDS);
const sentence = (n = int(5, 12)): string => { const s = Array.from({ length: n }, word).join(" "); return `${s[0]!.toUpperCase()}${s.slice(1)}.`; };
const first = (): string => pick(FIRST);
const last = (): string => pick(LAST);
const domain = (): string => `${pick(LAST).toLowerCase()}.${pick(TLDS)}`;

/** The Java Faker categories JetBrains exposes as `$random.<category>.<method>`. */
const FAKER: Record<string, Record<string, () => string>> = {
  name: {
    firstName: first, lastName: last, fullName: () => `${first()} ${last()}`, name: () => `${first()} ${last()}`,
    username: () => `${first().toLowerCase()}.${last().toLowerCase()}${int(1, 99)}`, title: () => `${pick(["Senior", "Lead", "Principal", "Junior"])} ${pick(JOBS)}`,
    prefix: () => pick(["Mr.", "Mrs.", "Ms.", "Dr."]), suffix: () => pick(["Jr.", "Sr.", "II", "III", "PhD"]), nameWithMiddle: () => `${first()} ${first()} ${last()}`,
  },
  address: {
    city: () => pick(CITIES), cityName: () => pick(CITIES), country: () => pick(COUNTRIES), countryCode: () => pick(["US", "CA", "DE", "FR", "JP", "BR", "IN", "AU"]),
    state: () => pick(STATES), stateAbbr: () => pick(["CA", "TX", "NY", "FL", "OR", "OH", "GA", "WA"]), streetName: () => `${pick(STREETS)} ${pick(SUFFIX)}`,
    streetAddress: () => `${int(1, 9999)} ${pick(STREETS)} ${pick(SUFFIX)}`, buildingNumber: () => String(int(1, 9999)), zipCode: () => pad(int(0, 99999), 5),
    postcode: () => pad(int(0, 99999), 5), fullAddress: () => `${int(1, 9999)} ${pick(STREETS)} ${pick(SUFFIX)}, ${pick(CITIES)}, ${pick(STATES)} ${pad(int(0, 99999), 5)}`,
    latitude: () => (Math.random() * 180 - 90).toFixed(6), longitude: () => (Math.random() * 360 - 180).toFixed(6), timeZone: () => pick(["America/New_York", "Europe/Berlin", "Asia/Tokyo", "UTC"]),
  },
  company: {
    name: () => `${last()} ${pick(["Inc", "LLC", "Group", "and Sons", "Labs"])}`, industry: () => pick(INDUSTRIES), buzzword: () => pick(BUZZ),
    catchPhrase: () => `${pick(ADJ)} ${pick(BUZZ)} ${pick(["platform", "solution", "framework", "service"])}`, bs: () => `${pick(["enable", "leverage", "streamline", "scale"])} ${pick(BUZZ)} ${pick(["markets", "channels", "experiences"])}`,
    profession: () => pick(JOBS).toLowerCase(), url: () => `https://www.${domain()}`,
  },
  lorem: {
    word, words: () => Array.from({ length: 3 }, word).join(" "), sentence: () => sentence(), sentences: () => Array.from({ length: 3 }, () => sentence()).join(" "),
    paragraph: () => Array.from({ length: int(3, 6) }, () => sentence()).join(" "), characters: () => chars(LOWER + "0123456789", 255), fixedString: () => chars(LOWER, 10),
  },
  commerce: {
    productName: () => `${pick(ADJ)} ${pick(MATERIALS)} ${pick(PRODUCTS)}`, price: () => (int(100, 100000) / 100).toFixed(2), department: () => pick(["Books", "Electronics", "Garden", "Toys", "Sports", "Home"]),
    color: () => pick(COLORS), material: () => pick(MATERIALS), promotionCode: () => `${pick(ADJ)}${pick(["Deal", "Sale", "Code"])}${int(10, 99)}`,
  },
  finance: {
    creditCard: () => luhn("4", 16), creditCardNumber: () => luhn("4", 16), iban: () => `DE${pad(int(10, 99))}${chars("0123456789", 18)}`, bic: () => `${chars(LOWER.toUpperCase(), 4)}DE${chars("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", 2)}`,
    currencyCode: () => pick(CURRENCIES), accountNumber: () => chars("0123456789", 10), routingNumber: () => chars("0123456789", 9),
  },
  internet: {
    emailAddress: () => `${first().toLowerCase()}.${last().toLowerCase()}@${domain()}`, safeEmailAddress: () => `${first().toLowerCase()}@example.com`, domainName: domain, domainWord: () => last().toLowerCase(),
    url: () => `https://www.${domain()}/${word()}`, ipV4Address: () => [int(1, 255), int(0, 256), int(0, 256), int(1, 255)].join("."),
    ipV6Address: () => Array.from({ length: 8 }, () => chars("0123456789abcdef", 4)).join(":"), macAddress: () => Array.from({ length: 6 }, () => chars("0123456789abcdef", 2)).join(":"),
    password: () => chars(ALPHA + "0123456789!@#$%", 14), uuid: () => randomUUID(), slug: () => `${word()}-${word()}`,
    userAgentAny: () => "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36", image: () => `https://picsum.photos/seed/${int(1, 9999)}/640/480`,
  },
  phoneNumber: {
    phoneNumber: () => `(${int(200, 999)}) ${int(200, 999)}-${pad(int(0, 9999), 4)}`, cellPhone: () => `${int(200, 999)}-${int(200, 999)}-${pad(int(0, 9999), 4)}`,
    subscriberNumber: () => pad(int(0, 9999), 4), extension: () => String(int(100, 9999)),
  },
  number: {
    randomDigit: () => String(int(0, 10)), randomNumber: () => String(int(0, 1_000_000)), digit: () => String(int(0, 10)),
  },
  bool: { bool: () => String(Math.random() < 0.5) },
  color: { name: () => pick(COLORS), hex: () => `#${chars("0123456789abcdef", 6)}` },
  book: { title: () => `The ${pick(ADJ)} ${pick(PRODUCTS)}`, author: () => `${first()} ${last()}`, publisher: () => `${last()} Press`, genre: () => pick(["Fantasy", "Mystery", "Science fiction", "Romance", "History"]) },
  job: { title: () => `${pick(["Senior", "Lead", "Junior"])} ${pick(JOBS)}`, field: () => pick(INDUSTRIES), position: () => pick(JOBS) },
  idNumber: { valid: () => `${pad(int(1, 899), 3)}-${pad(int(1, 99))}-${pad(int(1, 9999), 4)}`, ssnValid: () => `${pad(int(1, 899), 3)}-${pad(int(1, 99))}-${pad(int(1, 9999), 4)}` },
};

/** Parenthesised args: `(1, 100)` or `("fr")`. */
function parenArgs(text: string): string[] {
  const m = /\(([^)]*)\)\s*$/.exec(text);
  if (!m) return [];
  return m[1]!.split(",").map((a) => a.trim().replace(/^["']|["']$/g, "")).filter((a) => a !== "");
}

/**
 * Synchronous dynamic variables. Returns undefined when `expr` is not one of
 * them (the resolver then tries the prompting and token variables).
 */
export function dynamicValue(expr: string, ctx: { now?: Date; env: (name: string) => string | undefined; dotenv: (name: string) => string | undefined; lookup: (name: string) => string | undefined; root: string }): string | undefined {
  const trimmed = expr.trim();
  const name = /^\$[\w.-]+/.exec(trimmed)?.[0] ?? "";
  const rest = trimmed.slice(name.length).trim();
  const args = splitArgs(rest);
  const now = ctx.now ?? new Date();
  const indirect = (arg: string | undefined): string => arg?.startsWith("%") ? ctx.lookup(arg.slice(1)) ?? "" : arg ?? "";

  switch (name) {
    case "$guid": case "$uuid": case "$random.uuid": return randomUUID();
    case "$randomInt": {
      if (args.length >= 2) return String(int(Math.ceil(Number(args[0])), Math.floor(Number(args[1]))));
      return String(int(0, 1001));
    }
    case "$timestamp": return String(Math.floor(offsetDate(now, args).getTime() / 1000));
    case "$isoTimestamp": return offsetDate(now, args).toISOString();
    case "$datetime": case "$localDatetime": {
      const format = args[0] ?? "iso8601";
      return formatDate(offsetDate(now, args.slice(1)), format, name === "$datetime");
    }
    case "$processEnv": return ctx.env(indirect(args[0])) ?? "";
    case "$dotenv": return ctx.dotenv(indirect(args[0])) ?? "";
    case "$projectRoot": return ctx.root;
    case "$exampleServer": return "http://localhost:63342";
  }
  if (name.startsWith("$env.")) return ctx.env(name.slice(5)) ?? "";
  if (name.startsWith("$random.") || trimmed.startsWith("$random.")) {
    const path = trimmed.slice(8).replace(/\(.*\)\s*$/, "");
    const pargs = parenArgs(trimmed);
    switch (path) {
      case "integer": return String(int(Number(pargs[0] ?? 0), Number(pargs[1] ?? 1000)));
      case "float": { const lo = Number(pargs[0] ?? 0); const hi = Number(pargs[1] ?? 1000); return String(lo + Math.random() * (hi - lo)); }
      case "alphabetic": return chars(ALPHA, Number(pargs[0] ?? 10));
      case "alphanumeric": return chars(`${ALPHA}0123456789_`, Number(pargs[0] ?? 10));
      case "hexadecimal": return chars("0123456789abcdef", Number(pargs[0] ?? 10));
      case "email": return FAKER.internet!.emailAddress!();
    }
    // $random.locale.name.fullName("fr"): locale data is English here; the shape still resolves.
    const parts = path.split(".").filter((p) => p !== "locale");
    const fn = FAKER[parts[0] ?? ""]?.[parts[1] ?? ""];
    if (fn) return fn();
    throw new Error(`unknown random generator $random.${path}`);
  }
  return undefined;
}

export const FAKER_CATEGORIES = Object.fromEntries(Object.entries(FAKER).map(([k, v]) => [k, Object.keys(v)]));
