/**
 * A verb lexicon for the cloud's phrase gate (ARCHITECTURE 10.3), in the same
 * spirit as the NEWS_EXTENSION stopword list: hand-curated news vocabulary,
 * because no statistic available on day one can do this job.
 *
 * The problem it solves: the proper-noun gate admits "name + VERB" — "graham
 * advances", "trump slipped", "leaving turkey". Those are CLAUSES, not topics.
 * Their neighbours "medicaid funding", "patriot games", "senate seat" are
 * COMPOUNDS and must survive, so the separation cannot be morphological: -ing
 * and -s appear on both sides. It has to be lexical.
 *
 * The lists below are ordinary high-frequency English news verbs. What decides
 * where a verb goes is one question asked of each INFLECTED form, not of the
 * lemma: has this form become a noun in its own right?
 *
 *   -s   "games", "talks", "cuts", "plans", "funds", "calls" are plural nouns;
 *        "advances", "reflects", "warns", "seeks" are not.
 *   -ing "funding", "spending", "hearing", "building", "meeting", "training",
 *        "shooting", "warning", "ruling" name things; "giving", "leaving",
 *        "arriving", "accusing" do not.
 *   -ed  nothing here is ambiguous. No English plural noun ends in -ed and
 *        "moved", "voted", "called" name nothing — which is why the past tense
 *        is the one route open to every verb in the file.
 *
 * So a lemma lands in VERB_LEMMAS when both live inflections stay verbal, in
 * FINITE_ONLY_LEMMAS when only its -ing has nominalized, and in
 * PAST_ONLY_LEMMAS when its -s has too. Ambiguity is a property of the form,
 * so it is resolved per form.
 *
 * Why this generalises past one day of news: the entries are chosen by
 * frequency in headline writing and filtered by the noun test above — not by
 * which phrases happened to be wrong on the day the file was written. The
 * vocabulary of headline PREDICATES is small, closed in practice and slow to
 * change; the names beside them are what turns over daily. The lexicon is the
 * stable half of the phrase.
 */

/** Both live inflections stay verbal: -s, -ing and -ed all count. */
const VERB_LEMMAS = [
  // saying, claiming, arguing — the largest class in headlines
  "accept", "accuse", "acknowledge", "admit", "allege", "argue", "assert",
  "assure", "clarify", "complain", "concede", "condemn", "confess", "confirm",
  "criticize", "decry", "declare", "denounce", "deny", "describe", "disclose",
  "discuss", "dismiss", "explain", "express", "hail", "highlight", "insist",
  "mention", "mock", "mull", "predict", "pretend", "propose", "recommend",
  "reflect", "refuse", "reiterate", "reject", "represent", "respond", "reveal",
  "slam", "suggest", "suppose", "testify", "threaten", "tout", "urge", "vow",
  // deciding, allowing, requiring
  "achieve", "adopt", "advise", "agree", "allow", "appoint", "approve",
  "authorize", "choose", "decide", "deserve", "determine", "elect", "enable",
  "encourage", "endorse", "enforce", "ensure", "expect", "forbid", "hesitate",
  "implement", "indicate", "instruct", "intend", "justify", "nominate",
  "oppose", "oust", "permit", "persuade", "prefer", "prevent", "prohibit",
  "promote", "quit", "require", "resolve", "select", "settle", "submit",
  // motion and change of state
  "advance", "arrive", "ascend", "become", "begin", "climb", "come", "depart",
  "descend", "disappear", "emerge", "escalate", "escape", "expand", "explode",
  "flee", "float", "fly", "follow", "go", "grow", "halt", "happen", "leave",
  "lean", "leap", "melt", "migrate", "occur", "proceed", "remain", "resume",
  "revive", "rise", "shrink", "sink", "slide", "slip", "stay", "strengthen",
  "swim", "tighten", "topple", "undergo", "vanish", "weaken", "worsen",
  // acting on someone or something
  "abandon", "attend", "attract", "avoid", "await", "betray", "capture",
  "carry", "celebrate", "collect", "combine", "compel", "confront", "connect",
  "consider", "consult", "contain", "continue", "contribute", "convict",
  "convince", "create", "crush", "defend", "defy", "deliver", "deploy",
  "deport", "destroy", "detain", "develop", "devote", "disrupt", "dissolve",
  "distribute", "divide", "dominate", "donate", "downplay", "earn", "educate",
  "eliminate", "embrace", "employ", "enhance", "enter", "erase", "establish",
  "evacuate", "examine", "exceed", "exclude", "execute", "exploit", "explore",
  "expose", "extend", "gather", "generate", "give", "govern", "grab", "greet",
  "hurt", "identify", "ignore", "illustrate", "impose", "impress", "improve",
  "include", "inherit", "initiate", "injure", "insert", "inspect", "inspire",
  "install", "interrupt", "intervene", "introduce", "invade", "invent",
  "investigate", "invite", "involve", "isolate", "join", "knock", "lend",
  "locate", "lose", "maintain", "marry", "modify", "navigate", "neglect",
  "negotiate", "obtain", "occupy", "offend", "organize", "overcome",
  "overturn", "prepare", "preserve", "produce", "prosecute", "protect",
  "provide", "publish", "punish", "pursue", "reach", "rebuild", "receive",
  "recognize", "recover", "reduce", "remove", "renew", "repeat", "replace",
  "rescue", "restore", "restrict", "retain", "reverse", "revise", "satisfy",
  "save", "scare", "scramble", "secure", "seek", "seize", "sell", "send",
  "separate", "serve", "solve", "steal", "sue", "suffer", "surround",
  "survive", "suspend", "sustain", "terminate", "transform", "translate",
  "undermine", "unveil", "vie", "violate", "welcome",
  // mental states, perception, stance
  "apologize", "appear", "assume", "believe", "belong", "calculate", "compare",
  "compete", "comply", "conclude", "consist", "cooperate", "cope", "dare",
  "depend", "differ", "disagree", "discover", "evaluate", "exist", "fail",
  "forget", "forgive", "glance", "imagine", "imply", "keep", "listen", "obey",
  "observe", "owe", "perform", "possess", "postpone", "react", "realize",
  "recall", "refer", "regard", "rely", "remember", "remind", "resemble",
  "resign", "resist", "retire", "seem", "shout", "sing", "sit", "speak",
  "stare", "succeed", "teach", "tend", "thank", "try", "vary", "wait", "wake",
  "wander", "want", "weigh", "wonder", "write",
] as const;

/**
 * The BARE form of these has nominalized, even though their -s and -ing did
 * not: a pay RISE, a hail STORM, paid LEAVE, a grand SLAM, a work PERMIT, a
 * product RECALL, a land GRAB, carbon CAPTURE, a nature PRESERVE.
 *
 * They sit in VERB_LEMMAS because that list is decided on the -s and -ing
 * forms ("rises"/"rising", "hails"/"hailing" name nothing), and the bare form
 * is a FOURTH inflection that the file's own question — has this form become a
 * noun in its own right? — has to be asked of separately. It cannot be
 * inherited from the other two: "rise" nominalized and "rises" did not, the
 * same way "funding" nominalized and "funds" did not one list down.
 *
 * The cost of getting it wrong is asymmetric, which is why the entries here
 * are generous. Gating a word that is really a noun refuses a good label
 * outright — "Bitcoin Rise", "Texas Hail", "Product Recall" all become no
 * label at all. Failing to gate one leaves a single clause-shaped fallback
 * that the proper-noun gate above may well refuse anyway. So a lemma lands
 * here whenever its bare form is an ordinary noun or premodifier of news
 * English, and only an unambiguous predicate ("agree", "urge", "confirm")
 * keeps the bare route.
 *
 * Typed to VERB_LEMMAS rather than to `string`, so a lemma misspelled here —
 * which would silently protect nothing — is a compile error rather than a
 * quiet re-run of the bug this list exists to fix.
 */
const BARE_NOUN_LEMMAS: ReadonlySet<(typeof VERB_LEMMAS)[number]> = new Set<
  (typeof VERB_LEMMAS)[number]
>([
  "advance", "capture", "climb", "combine", "convict", "crush", "divide",
  "elect", "escape", "exploit", "express", "float", "fly", "grab", "hail",
  "halt", "highlight", "lean", "leap", "leave", "mock", "neglect", "permit",
  "preserve", "produce", "reach", "rebuild", "recall", "refuse", "rescue",
  "resume", "reveal", "reverse", "rise", "save", "scare", "secure", "select",
  "sink", "slam", "slide", "slip", "stay", "vow", "wait", "wake", "welcome",
  "wonder",
]);

/** VERB_LEMMAS minus the ones whose bare form is a noun. */
const BARE_VERBAL_LEMMAS = VERB_LEMMAS.filter((lemma) => !BARE_NOUN_LEMMAS.has(lemma));

/**
 * Only the -ing has nominalized: a WARNING, a HEARING, the SPENDING, a
 * BUILDING, a MEETING. The -s form of each is still purely verbal ("Trump
 * warns", "court hears"), so these fire on -s and -ed but never on -ing.
 */
const FINITE_ONLY_LEMMAS = [
  "build", "ease", "heal", "hear", "hire", "kill", "learn", "meet", "plead",
  "shoot", "spend", "warn",
] as const;

/**
 * The -s form is an ordinary plural noun too — "funds", "plans", "calls",
 * "games", "talks", "cuts", "votes". These are why "medicaid funding" and
 * "patriot games" cannot be judged morphologically. Past tense only.
 */
const PAST_ONLY_LEMMAS = [
  "arrest", "attack", "back", "ban", "bar", "blast", "block", "boost", "break",
  "buy", "call", "cause", "challenge", "change", "charge", "claim", "clash",
  "collapse", "control", "cost", "count", "cover", "crash", "cross", "cut",
  "deal", "debate", "decline", "defeat", "delay", "demand", "doubt", "drag",
  "draw", "drive", "drop", "end", "exercise", "face", "fall", "favor", "fear",
  "feed", "fight", "file", "fill", "finance", "fire", "fix", "flow", "focus",
  "fold", "force", "form", "fund", "gain", "grant", "guarantee", "guide",
  "hand", "handle", "hang", "harm", "head", "help", "hide", "hit", "hold",
  "hope", "host", "hunt", "import", "increase", "influence", "invest", "issue",
  "judge", "jump", "kick", "lack", "land", "last", "launch", "lead", "lift",
  "limit", "link", "list", "live", "load", "lock", "look", "love", "manage",
  "mark", "match", "matter", "mean", "measure", "mind", "miss", "mix",
  "monitor", "move", "murder", "name", "note", "notice", "object", "offer",
  "open", "operate", "order", "pass", "pause", "pay", "pick", "place", "plan",
  "play", "pledge", "point", "pour", "pray", "praise", "present", "press",
  "protest", "prove", "pull", "purchase", "push", "question", "quote", "raise",
  "rally", "record", "reform", "register", "regret", "relate", "release",
  "remark", "rent", "repair", "reply", "report", "request", "respect",
  "result", "return", "review", "ride", "risk", "roll", "rule", "run", "rush",
  "sail", "scan", "search", "shake", "shape", "share", "shift", "shine",
  "show", "shut", "sign", "signal", "sleep", "smile", "sound", "spill",
  "split", "spot", "spread", "stand", "start", "state", "step", "stick",
  "stop", "store", "stress", "stretch", "strike", "struggle", "study",
  "supply", "support", "surge", "surprise", "surrender", "suspect", "sweep",
  "switch", "talk", "target", "tear", "test", "touch", "trade", "train",
  "transfer", "travel", "treat", "trigger", "trust", "turn", "understand",
  "use", "value", "veto", "view", "visit", "vote", "walk", "wash", "waste",
  "wear", "win", "wish", "witness", "work", "worry", "yield",
] as const;

/**
 * Irregular pasts and participles, which suffix-stripping cannot derive.
 * Forms that are common nouns in their own right are deliberately absent —
 * "shot", "cut", "run", "set", "hit", "thought", "wound", "ground" — as is
 * "born", which in practice reaches us inside names and fixed phrases.
 */
const IRREGULAR_PAST = [
  "arose", "arisen", "awoke", "became", "began", "begun", "bent", "blew",
  "blown", "bought", "bred", "brought", "built", "burnt", "came", "caught",
  "chose", "chosen", "clung", "crept", "dealt", "drawn", "drew", "driven",
  "drove", "dug", "fallen", "fell", "fled", "flew", "flown", "forgave",
  "forgot", "forgotten", "fought", "froze", "frozen", "gave", "given", "grew",
  "grown", "heard", "held", "hid", "hidden", "hung", "kept", "knelt", "knew",
  "laid", "lain", "lay", "leapt", "led", "left", "lent", "lost", "meant",
  "met", "overcame", "overtook", "paid", "rang", "ridden", "rode", "risen",
  "rose", "rung", "sang", "sank", "sat", "sold", "sought", "spent", "spoke",
  "spoken", "stole", "stolen", "stood", "struck", "stuck", "sung", "sunk",
  "swept", "swore", "sworn", "taught", "threw", "thrown", "tore", "torn",
  "underwent", "withdrawn", "withdrew", "wore", "worn", "written", "wrote",
] as const;

/** -s / -es / -ies. */
function thirdPerson(lemma: string): string[] {
  if (/(?:s|x|z|ch|sh|o)$/.test(lemma)) return [`${lemma}es`];
  if (/[^aeiou]y$/.test(lemma)) return [`${lemma.slice(0, -1)}ies`];
  return [`${lemma}s`];
}

/**
 * -ing and -ed. Consonant doubling ("slip" → "slipped", "commit" →
 * "committed") depends on stress, which spelling does not record, so short
 * lemmas get BOTH spellings and the one that is not a word simply never
 * matches a token. Over-generating here is safe in a way that under-generating
 * is not: every form produced is still verb-shaped.
 */
function participles(lemma: string): { ing: string[]; ed: string[] } {
  if (lemma.endsWith("e") && !/[eoy]e$/.test(lemma)) {
    return { ing: [`${lemma.slice(0, -1)}ing`], ed: [`${lemma}d`] };
  }
  if (/[^aeiou]y$/.test(lemma)) {
    return { ing: [`${lemma}ing`], ed: [`${lemma.slice(0, -1)}ied`] };
  }
  const ing = [`${lemma}ing`];
  const ed = [`${lemma}ed`];
  if (lemma.length <= 6 && /[aeiou][bdglmnprt]$/.test(lemma)) {
    const doubled = lemma + lemma.slice(-1);
    ing.push(`${doubled}ing`);
    ed.push(`${doubled}ed`);
  }
  return { ing, ed };
}

function inflect(
  lemmas: readonly string[],
  routes: readonly ("s" | "ing" | "ed")[],
): string[] {
  const forms: string[] = [];
  for (const lemma of lemmas) {
    const { ing, ed } = participles(lemma);
    if (routes.includes("s")) forms.push(...thirdPerson(lemma));
    if (routes.includes("ing")) forms.push(...ing);
    if (routes.includes("ed")) forms.push(...ed);
  }
  return forms;
}

/**
 * Forms that are verbal WHEREVER they stand in a phrase: the bare lemma and
 * third person singular of a verb whose every inflection stays verbal, and
 * the present participle of a verb that has not nominalized.
 *
 * The bare lemma comes only from VERB_LEMMAS, and only after BARE_NOUN_LEMMAS
 * is taken back out of it. FINITE_ONLY_LEMMAS and PAST_ONLY_LEMMAS are
 * excluded wholesale: they are separate lists precisely because some
 * inflection of them IS a common noun ("funding", "plans", "talks", "cuts"),
 * and the bare form sits on that side of the ambiguity — "plan", "talk",
 * "cut" are nouns as often as verbs, so gating them here would cost "Trade
 * Plan" and "Border Deal" to fix a headline like "Royals Agree Deal" that the
 * bare VERB_LEMMAS form alone already reaches. Membership of VERB_LEMMAS is
 * not by itself enough either: it is decided on the -s and -ing forms, and a
 * bare form nominalizes on its own schedule ("a pay rise", "paid leave").
 */
export const VERB_FORMS: ReadonlySet<string> = new Set([
  ...BARE_VERBAL_LEMMAS,
  ...inflect(VERB_LEMMAS, ["s", "ing"]),
  ...inflect(FINITE_ONLY_LEMMAS, ["s"]),
]);

/**
 * Past tenses and participles, from every list. Read only in non-initial
 * position — see the caller: "armed forces" and "planned parenthood" are
 * premodifiers, but nothing follows a name as a participle except a predicate.
 */
export const PAST_FORMS: ReadonlySet<string> = new Set([
  ...inflect(VERB_LEMMAS, ["ed"]),
  ...inflect(FINITE_ONLY_LEMMAS, ["ed"]),
  ...inflect(PAST_ONLY_LEMMAS, ["ed"]),
  ...IRREGULAR_PAST,
]);
