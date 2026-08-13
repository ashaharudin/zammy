import type { Reference, TopicQuery } from "./api.js";

/**
 * The filter defaults the command bar starts on, read from the browser (§8.1).
 *
 * The browser's readings come in as arguments rather than off `navigator`, so
 * the rules are testable without a DOM and the caller owns the one place that
 * touches globals.
 */

/**
 * The language chip's starting code: the browser's most-preferred language the
 * upstream list actually offers (§2 — codes, never names).
 */
export function defaultLanguage(
  locales: readonly string[],
  languages: Record<string, string>,
): string {
  const offered = new Set(Object.values(languages));
  for (const locale of locales) {
    const code = locale.split("-")[0]?.toLowerCase();
    if (code && offered.has(code)) return code;
  }
  return "en";
}

/**
 * The location chip's starting code, or undefined for Worldwide — the honest
 * answer when the browser's readings name nowhere upstream covers.
 *
 * A browser cannot see its own IP, so "where is this reader" is answered from
 * the locale's region subtag first (`en-CA` → CA), which is what a reader who
 * has set their region is telling us.
 */
export function defaultCountry(
  browser: { locales: readonly string[]; timeZone: string | undefined },
  regions: Record<string, string>,
): string | undefined {
  const offered = new Set(Object.values(regions));
  for (const locale of browser.locales) {
    const region = locale.split("-")[1]?.toUpperCase();
    if (region && offered.has(region)) return region;
  }
  const zoned = browser.timeZone ? COUNTRY_BY_ZONE.get(browser.timeZone) : undefined;
  return zoned && offered.has(zoned) ? zoned : undefined;
}

/**
 * The topic to actually search, once the browser's own settings have filled in
 * what the URL left unsaid.
 *
 * The two filters take different rules, because only one of them can state
 * "no filter": language has `all` (ANY_LANGUAGE), so an absent language is
 * always an unanswered question and defaulting it can never overrule a reader.
 * An absent country is ambiguous — picked Worldwide, or never picked — so the
 * country default applies only to a topic that states no filters at all, which
 * is what arriving from the hero or a bare `?q=` link looks like.
 */
export function defaultedTopic(
  topic: TopicQuery,
  browser: { locales: readonly string[]; timeZone: string | undefined },
  reference: Reference,
): TopicQuery {
  const untouched =
    topic.language === undefined && topic.country === undefined && topic.category === undefined;
  const next = { ...topic };
  if (next.language === undefined) next.language = defaultLanguage(browser.locales, reference.languages);
  if (untouched) next.country = defaultCountry(browser, reference.regions);
  return next;
}

/**
 * Principal IANA zones per country upstream covers, deliberately partial: it
 * exists to place the common reader, and a zone it does not carry lands on
 * Worldwide, which is a correct answer rather than a wrong guess.
 */
const ZONES_BY_COUNTRY: Record<string, string[]> = {
  AE: ["Asia/Dubai"],
  AF: ["Asia/Kabul"],
  AR: ["America/Argentina/Buenos_Aires", "America/Buenos_Aires"],
  AT: ["Europe/Vienna"],
  AU: [
    "Australia/Sydney",
    "Australia/Melbourne",
    "Australia/Brisbane",
    "Australia/Perth",
    "Australia/Adelaide",
    "Australia/Hobart",
    "Australia/Darwin",
  ],
  BA: ["Europe/Sarajevo"],
  BD: ["Asia/Dhaka"],
  BE: ["Europe/Brussels"],
  BO: ["America/La_Paz"],
  BR: [
    "America/Sao_Paulo",
    "America/Bahia",
    "America/Fortaleza",
    "America/Recife",
    "America/Manaus",
  ],
  CA: [
    "America/Toronto",
    "America/Montreal",
    "America/Vancouver",
    "America/Edmonton",
    "America/Winnipeg",
    "America/Halifax",
    "America/St_Johns",
    "America/Regina",
  ],
  CH: ["Europe/Zurich"],
  CL: ["America/Santiago"],
  CN: ["Asia/Shanghai", "Asia/Chongqing", "Asia/Urumqi"],
  CO: ["America/Bogota"],
  CZ: ["Europe/Prague"],
  DE: ["Europe/Berlin"],
  DK: ["Europe/Copenhagen"],
  EC: ["America/Guayaquil"],
  EE: ["Europe/Tallinn"],
  EG: ["Africa/Cairo"],
  ES: ["Europe/Madrid", "Atlantic/Canary"],
  FI: ["Europe/Helsinki"],
  FR: ["Europe/Paris"],
  GB: ["Europe/London"],
  GH: ["Africa/Accra"],
  GR: ["Europe/Athens"],
  HK: ["Asia/Hong_Kong"],
  HU: ["Europe/Budapest"],
  ID: ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura"],
  IE: ["Europe/Dublin"],
  IL: ["Asia/Jerusalem", "Asia/Tel_Aviv"],
  IN: ["Asia/Kolkata", "Asia/Calcutta"],
  IQ: ["Asia/Baghdad"],
  IR: ["Asia/Tehran"],
  IT: ["Europe/Rome"],
  JP: ["Asia/Tokyo"],
  KE: ["Africa/Nairobi"],
  KH: ["Asia/Phnom_Penh"],
  KR: ["Asia/Seoul"],
  KW: ["Asia/Kuwait"],
  LB: ["Asia/Beirut"],
  LU: ["Europe/Luxembourg"],
  MM: ["Asia/Yangon", "Asia/Rangoon"],
  MX: ["America/Mexico_City", "America/Monterrey", "America/Tijuana"],
  MY: ["Asia/Kuala_Lumpur", "Asia/Kuching"],
  NG: ["Africa/Lagos"],
  NK: ["Asia/Pyongyang"],
  NL: ["Europe/Amsterdam"],
  NO: ["Europe/Oslo"],
  NP: ["Asia/Kathmandu"],
  NZ: ["Pacific/Auckland"],
  PA: ["America/Panama"],
  PE: ["America/Lima"],
  PH: ["Asia/Manila"],
  PK: ["Asia/Karachi"],
  PL: ["Europe/Warsaw"],
  PS: ["Asia/Gaza", "Asia/Hebron"],
  PT: ["Europe/Lisbon"],
  PY: ["America/Asuncion"],
  QA: ["Asia/Qatar"],
  RO: ["Europe/Bucharest"],
  RS: ["Europe/Belgrade"],
  RU: [
    "Europe/Moscow",
    "Europe/Kaliningrad",
    "Asia/Yekaterinburg",
    "Asia/Novosibirsk",
    "Asia/Krasnoyarsk",
    "Asia/Vladivostok",
  ],
  SA: ["Asia/Riyadh"],
  SE: ["Europe/Stockholm"],
  SG: ["Asia/Singapore"],
  SI: ["Europe/Ljubljana"],
  TH: ["Asia/Bangkok"],
  TR: ["Europe/Istanbul", "Asia/Istanbul"],
  TW: ["Asia/Taipei"],
  US: [
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Phoenix",
    "America/Detroit",
    "America/Anchorage",
    "Pacific/Honolulu",
  ],
  UY: ["America/Montevideo"],
  VE: ["America/Caracas"],
  VN: ["Asia/Ho_Chi_Minh", "Asia/Saigon"],
  ZW: ["Africa/Harare"],
};

const COUNTRY_BY_ZONE = new Map(
  Object.entries(ZONES_BY_COUNTRY).flatMap(([country, zones]) =>
    zones.map((zone) => [zone, country] as const),
  ),
);
