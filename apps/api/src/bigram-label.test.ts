import { describe, expect, it } from "vitest";
import { bigramLabel, type PhraseArticle } from "./bigram-label.js";

/**
 * The bigram label: ADR-0011's deterministic floor under the model.
 *
 * Ported from the read-time storyline phrase's tests when S9 retired it. The
 * containment assertions went with it — a phrase had to appear in every article
 * because clicking it ran a SEARCH, and a label is opened by UUID — but the
 * properties of the extractor underneath are unchanged and are what these
 * cover: it names rather than states, it folds plurals, it prefers what more of
 * the coverage actually says, and it is stable across a replay.
 *
 * Issue #100 added a gate: a chosen bigram must contain a word with
 * `properNounEvidence` — capitalized mid-sentence somewhere in the corpus and
 * never seen lowercase — not merely Title Case, which every word in a
 * headline wears for free. So fixtures below give their intended winner a
 * name that earns that evidence (mirroring `headline-tokens.test.ts`'s
 * "Kelowna" pattern: capitalized mid-sentence in a description, never
 * lowercase anywhere), while the words that must NOT win stay ordinary nouns
 * that appear lowercase somewhere in the corpus.
 */

const article = (title: string, description: string | null = null): PhraseArticle => ({
  title,
  description,
});

describe("bigramLabel", () => {
  it("has nothing to name for an empty storyline", () => {
    expect(bigramLabel([])).toBeNull();
  });

  describe("the outlet's name is not the story's name", () => {
    it("ignores the attribution the outlet left on its own headline", () => {
      // The shape that produced "Manitoba Beekeepers": every Global News
      // Winnipeg headline ends "- Winnipeg | Globalnews.ca", so the dateline
      // is the only phrase the whole storyline shares.
      expect(
        bigramLabel([
          article(
            "Kelowna beekeepers feel sting of tariff - Winnipeg | Globalnews.ca",
            "Beekeepers in Kelowna face the tariff deadline.",
          ),
          article(
            "Kelowna beekeepers count losses - Winnipeg | Globalnews.ca",
            "The beekeepers in Kelowna counted their losses.",
          ),
        ]),
      ).toBe("Kelowna Beekeepers");
    });

    it("keeps a tail that is the headline's own, not the outlet's", () => {
      // Four words is the ceiling and a verb is disqualifying, so a headline
      // whose dash carries content keeps it.
      expect(
        bigramLabel([
          article(
            "Kelowna chiefs sign accord - and faster than expected",
            "The chiefs in Kelowna signed sooner than the province expected.",
          ),
          article(
            "Kelowna chiefs accord holds",
            "Officials in Kelowna said the chiefs accord holds.",
          ),
        ]),
      ).toBe("Kelowna Chiefs");
    });
  });

  describe("the support floor (a pile has no name)", () => {
    // Five members, five subjects, and the only thing any two of them share is
    // the province. Every candidate is said once, so there is nothing to name.
    const pile = [
      article("Kelowna abduction arrest made", "Police in Kelowna arrested a man."),
      article("Kelowna cocaine seizure announced", "Officers in Kelowna seized cocaine."),
      article("Kelowna grenade found in river", "An angler near Kelowna found a grenade."),
      article("Kelowna toddlers drown in lake", "Two toddlers drowned near Kelowna."),
      article("Kelowna beekeepers face tariff", "Beekeepers near Kelowna face a tariff."),
    ];

    it("declines rather than crowning a phrase one headline in five says", () => {
      expect(bigramLabel(pile)).toBeNull();
    });

    it("still names a storyline whose coverage genuinely shares a phrase", () => {
      expect(
        bigramLabel([
          ...pile.slice(0, 4),
          article(
            "Kelowna abduction charges laid",
            "The Kelowna abduction case went to court.",
          ),
        ]),
      ).toBe("Kelowna Abduction");
    });

    it("does not apply the floor to coverage too small to have a majority", () => {
      // Two outlets wording one story differently is ordinary, not a pile.
      expect(
        bigramLabel([
          article("Kelowna abduction arrest made", "Police in Kelowna arrested a man."),
          article("Man held after Kelowna incident", "The man was held in Kelowna."),
        ]),
      ).toBe("Kelowna Abduction");
    });
  });

  describe("ties are broken on the arc's origin, not the alphabet", () => {
    it("names the storyline after its earliest headline", () => {
      // Both phrases are said once and both open their headline. The corpus
      // arrives oldest first, so the older headline names the arc — and keeps
      // naming it when tomorrow's coverage adds another one-off phrase.
      const origin = article(
        "Kelowna wildfire evacuates valley",
        "The wildfire near Kelowna forced an evacuation.",
      );
      const later = article(
        "Kelowna airport reopens",
        "The airport in Kelowna reopened on Tuesday.",
      );
      expect(bigramLabel([origin, later])).toBe("Kelowna Wildfire");
      expect(
        bigramLabel([
          origin,
          later,
          article("Kelowna bakery donates bread", "A bakery in Kelowna donated bread."),
        ]),
      ).toBe("Kelowna Wildfire");
    });
  });

  it("names the story with two adjacent words from a headline", () => {
    expect(
      bigramLabel([
        article(
          "Kelowna chiefs urge minister to block release",
          "Officials in Kelowna said the chiefs oppose the closure.",
        ),
        article(
          "What the Kelowna chiefs letter actually asks for",
          "The letter names Kelowna and the chiefs directly.",
        ),
      ]),
    ).toBe("Kelowna Chiefs");
  });

  it("names the story rather than stating it", () => {
    // "letter urges" leads the headline and both articles carry both words; it
    // loses anyway, because a predicate is a headline with its middle removed
    // (ADR-0006's verb lexicon), and a label has to be a name.
    expect(
      bigramLabel([
        article(
          "Letter urges Kelowna chiefs rethink",
          "Officials in Kelowna say the chiefs will not budge.",
        ),
        article(
          "The letter that urges a Kelowna chiefs rethink",
          "Residents of Kelowna asked the chiefs to reconsider.",
        ),
      ]),
    ).toBe("Kelowna Chiefs");
  });

  it("prefers the phrase more of the coverage actually says", () => {
    // Only the first headline ever puts "budget committee" together, while both
    // other pieces say "kelowna cut" — which is what the day is calling this.
    expect(
      bigramLabel([
        article("Budget committee Kelowna cut", "The cut was debated in Kelowna."),
        article(
          "What the Kelowna cut means",
          "The cut was approved by a committee. Officials met in Kelowna.",
        ),
        article(
          "Kelowna cut clears the committee",
          "Budget lines shift again. The committee is based in Kelowna.",
        ),
      ]),
    ).toBe("Kelowna Cut");
  });

  it("folds plurals, so one article's singular does not split the count", () => {
    // "Kelowna chief" (singular) never proposes its own candidate — it sits
    // only in the second article's description — but it still has to count
    // toward "Kelowna chiefs"'s support under the fold, or the plural would
    // wrongly look like the only article that ever said it.
    expect(
      bigramLabel([
        article("Kelowna chiefs write to minister", "Officials in Kelowna received the letter."),
        article(
          "City council meets over budget",
          "The Kelowna chief spoke about the letter; officials in Kelowna said little.",
        ),
      ]),
    ).toBe("Kelowna Chiefs");
  });

  it("Title Cases, because a label is read rather than typed into a search", () => {
    // The one thing that changed when the phrase became a label: it stopped
    // being a query, so it stopped having to survive canonicalization —
    // "crash" is lowercase on the way in and capitalized on the way out.
    expect(
      bigramLabel([
        article(
          "Kelowna crash inquiry opens",
          "The inquiry into the Kelowna crash opens today. Officials met in Kelowna.",
        ),
      ]),
    ).toBe("Kelowna Crash");
  });

  it("is stable across a replayed read", () => {
    const storyline = [
      article("Kelowna funding cut clears committee", "Officials in Kelowna confirmed the cut."),
      article("The Kelowna funding cut, explained", "Residents of Kelowna reacted to the news."),
    ];
    expect(bigramLabel(storyline)).toBe(bigramLabel(storyline));
  });

  it("no longer requires every article to carry the words", () => {
    // ADR-0010's superset guarantee is deliberately dead (ADR-0011): the label
    // is not a search, so an outlier in the coverage cannot veto the name.
    expect(
      bigramLabel([
        article("Kelowna chiefs write to minister", "Officials in Kelowna received the letter."),
        article("Unrelated volcano erupts overnight"),
      ]),
    ).toBe("Kelowna Chiefs");
  });

  describe("the proper-noun gate (issue #100)", () => {
    it("refuses a bigram grounded in the coverage but naming nothing", () => {
      // Every word here is lifted straight from the headlines — the shape and
      // vocabulary contract a model answer has to pass — but none of them is
      // ever capitalized mid-sentence, so none earns properNounEvidence. A
      // vocabulary pair is not a name, and a null label still renders.
      expect(
        bigramLabel([
          article(
            "Eps estimate beats second quarter forecast",
            "Analysts raised the eps estimate after the second quarter closed.",
          ),
          article(
            "Second quarter eps estimate revised again",
            "The eps estimate for the second quarter moved higher.",
          ),
        ]),
      ).toBeNull();
    });

    it("still requires the gate even when a name sits elsewhere uninvolved", () => {
      // "Kelowna" earns proper-noun evidence, but it never stands adjacent to
      // "eps", "estimate", "price" or "target" in either headline — a real
      // word always separates them — so every candidate the titles can
      // propose is a vocabulary pair, and the gate refuses all of them.
      expect(
        bigramLabel([
          article(
            "Eps estimate tops price target",
            "Analysts based in Kelowna said the eps estimate beat the price target by a wide margin.",
          ),
          article(
            "Price target raised as eps estimate climbs",
            "The Kelowna office confirmed the price target increase after the eps estimate report.",
          ),
        ]),
      ).toBeNull();
    });

    it("admits a bigram the instant one of its two words is a name", () => {
      expect(
        bigramLabel([
          article(
            "Kelowna eps estimate beats forecast",
            "Analysts in Kelowna raised the eps estimate.",
          ),
          article(
            "The Kelowna eps estimate, explained",
            "Officials in Kelowna confirmed the estimate.",
          ),
        ]),
      ).toBe("Kelowna Eps");
    });
  });

  describe("true adjacency, not filtered-list adjacency (issue #100)", () => {
    it("does not fabricate a bigram out of words a stopword separated", () => {
      // "agree" and "deal" never stood next to each other — "to a" sat between
      // them — but both survive the stopword filter, so a caller walking the
      // FILTERED token list for adjacent pairs would read "agree deal" as a
      // bigram the headline never wrote. It also lacks proper-noun evidence,
      // so this exercises both fixes: no fabricated pair, and no bare name.
      expect(
        bigramLabel([
          article(
            "Kelowna royals reportedly agree to a deal",
            "The Kelowna royals reportedly agree to a deal, sources in Kelowna say.",
          ),
          article(
            "Kelowna royals said to agree to a deal",
            "Officials in Kelowna confirm the royals agree to a deal.",
          ),
        ]),
      ).toBe("Kelowna Royals");
    });
  });

  describe("the bare-verb-lemma gate (issue #100)", () => {
    it("gates a past participle the deriver used to misspell (agreed)", () => {
      // The other half of the "agree deal" story issue #100 filed. The bare
      // and -s/-ing forms of "agree" were gated, but `participles` built the
      // past as "agreeed", so "agreed" itself was in no set at all and this
      // corpus yielded "Kelowna Agreed" — a clause wearing a name's clothes.
      // Nothing else here earns proper-noun evidence, so the right answer is
      // no label: ADR-0011's "prefer none to a misleading one".
      expect(
        bigramLabel([
          article(
            "Kelowna agreed a new deal",
            "The terms were agreed in Kelowna on Tuesday.",
          ),
          article(
            "Terms agreed, Kelowna confirms",
            "Kelowna said the terms were agreed overnight.",
          ),
        ]),
      ).toBe(null);
    });

    it("gates a bare verb lemma beside a name, not only its -s/-ing forms", () => {
      // "urge" (bare) is ungated by the -s/-ing-only lexicon before this fix:
      // "urges"/"urging" were caught, but the bare form beside a name was not.
      // "Kelowna urge" must lose to "Kelowna chiefs" for the same reason
      // "Kelowna urges" already did.
      expect(
        bigramLabel([
          article(
            "Kelowna chiefs urge inquiry",
            "Officials in Kelowna said the chiefs will not relent.",
          ),
          article(
            "Chiefs in Kelowna urge a rethink",
            "The chiefs in Kelowna want the inquiry reopened.",
          ),
        ]),
      ).toBe("Kelowna Chiefs");
    });

    it("does not gate a bare lemma that is also an ordinary noun", () => {
      // "deal" is PAST_ONLY: its own bare form is a common noun ("a trade
      // deal"), not only its -ed form, so it must survive beside a name.
      //
      // Both headlines say it, so the winner is decided by SUPPORT. It used to
      // be decided by the alphabet — "kelowna deal" beating "kelowna trade" on
      // its second letter, with one headline behind each — which meant this
      // test passed for a reason that had nothing to do with the verb gate.
      expect(
        bigramLabel([
          article("Kelowna deal signed", "The Kelowna deal was signed today."),
          article("Details of the Kelowna deal emerge", "Kelowna officials confirmed the deal."),
        ]),
      ).toBe("Kelowna Deal");
    });

    // The bare form is a FOURTH inflection, and VERB_LEMMAS membership is
    // decided on the other two. "rises"/"rising" and "hails"/"hailing" name
    // nothing, so both lemmas belong there — but "a pay rise" and "a hail
    // storm" are nouns, so their bare forms cannot ride along. Gating them
    // does not merely rank the phrase lower; it takes the whole label away
    // (BARE_NOUN_LEMMAS in verb-lexicon.ts).
    it.each([
      [
        "rise",
        "Bitcoin Rise",
        [
          article(
            "Bitcoin rise continues",
            "The Bitcoin rise continued overnight. Traders watched Bitcoin closely.",
          ),
          article("Analysts explain the Bitcoin rise", "A sharp Bitcoin rise followed the news."),
        ],
      ],
      [
        "hail",
        "Kelowna Hail",
        [
          article(
            "Kelowna hail storm damages homes",
            "A hail storm hit Kelowna overnight. Crews across Kelowna cleared debris.",
          ),
          article(
            "Kelowna hail storm cleanup begins",
            "The hail storm left Kelowna towns without power.",
          ),
        ],
      ],
      [
        "leave",
        "Kelowna Leave",
        [
          article(
            "Kelowna leave policy challenged",
            "The leave policy in Kelowna drew criticism. Workers in Kelowna objected.",
          ),
          article(
            "Court hears Kelowna leave case",
            "Officials in Kelowna defended the leave policy.",
          ),
        ],
      ],
    ])("keeps %s, a VERB_LEMMAS entry whose bare form nominalized", (_lemma, label, corpus) => {
      expect(bigramLabel(corpus as PhraseArticle[])).toBe(label);
    });
  });

  describe("the verb gate's case override needs more than one member", () => {
    /**
     * `isVerb` refuses to read a word as a verb when the corpus's own case says
     * it is a name — that is what keeps "Ken Burns" and "Patriot Games". On a
     * storyline of two or three members the evidence it wants is nearly free,
     * and free in one shape especially — see `minMembers` in
     * headline-tokens.ts. So the OVERRIDE (not the grounding test) counts
     * members, and this pins the bar at two.
     */

    it("refuses a verb a press release capitalized in its own body", () => {
      // The real thing, trimmed. `brings` has been in the lexicon since the
      // first gap fill, and `Gigabyte Brings` was live anyway: the release
      // repeats its headline mid-description, the sentence split glues that
      // Title Case run onto the prose sentence after it, and one article
      // supplies both the mid-segment capital and the lowercase word that
      // makes the segment count as prose.
      const label = bigramLabel([
        article(
          "GIGABYTE Brings AORUS INFINITY to Gamescom 2026 with an Immersive Gaming Playground",
          "TAIPEI, Aug. 2026 /PRNewswire/ -- GIGABYTE AORUS is heading to Gamescom under the AORUS INFINITY theme. GIGABYTE Brings AORUS INFINITY to Gamescom 2026 with an Immersive Gaming Playground The AORUS INFINITY Series delivers a high-performance build with a distinctive visual identity.",
        ),
        article(
          "Can ANYBODY stop Arsenal from winning the Premier League again?",
          "Adam Clery explores Arsenal's chances of retaining their title.",
        ),
        article(
          "Pressure-free Weir targets Rogers Charity Classic breakthrough",
          "Canadian golf icon says his game feels sharper heading into the Calgary tournament.",
        ),
      ]);
      expect(label).not.toBe("Gigabyte Brings");
      expect(label).toBe("Aorus Infinity");
    });

    it("still lets two members' case overrule the lexicon", () => {
      // The other half of the trade, and what pins the bar at two rather than
      // three: `rose` is in IRREGULAR_PAST, so a golfer's surname survives
      // only by the override — and both members carry "Rose" mid-prose.
      expect(
        bigramLabel([
          article(
            "Justin Rose arrives in Memphis 'bucking the trend'",
            "At 46 years old, the defending FedEx St. Jude Championship winner Justin Rose's game still looks as sharp as ever.",
          ),
          article(
            "Defending St Jude champ Justin Rose, 46, still pushing to stay 'elite'",
            "The Englishman arrives at the FedEx St Jude Championship as the defending champion.",
          ),
        ]),
      ).toBe("Justin Rose");
    });

    it("leaves the GROUNDING gate on one member's evidence", () => {
      // The two bars are deliberately different. Grounding asks "is either
      // word a name?", where a wrong refusal costs the label outright, so it
      // keeps the cheap answer: "Kelowna" is capitalized mid-prose in ONE
      // member's description and that is still enough to ground the phrase.
      expect(
        bigramLabel([
          article("Kelowna beekeepers count losses", "Beekeepers in Kelowna counted the cost."),
          article("Beekeepers count losses", null),
        ]),
      ).toBe("Kelowna Beekeepers");
    });
  });

  describe("the clause-shaped labels of 2026-08-21", () => {
    // Four live storylines whose bigram label stated something instead of
    // naming it. Two were lexicon gaps, two were the case override above.

    it("does not name a storyline after a bare verb with a plural subject", () => {
      // `Brewers Place`: "place" is the finite verb of "Brewers", and its own
      // description says "placed" lowercase, so no case evidence was involved
      // — the lexicon simply classified `place` as past-tense-only.
      const label = bigramLabel([
        article(
          "Brewers place RHP Abner Uribe (forearm) on 15-day IL",
          "LOS ANGLEES (AP) — The Milwaukee Brewers placed right-hander Abner Uribe on the 15-day injured list Friday due to a forearm flexor strain.",
        ),
        article(
          "Royals' Maikel Garcia likely headed back to the IL with hamstring strain",
          "KANSAS CITY, Mo. (AP) — Kansas City Royals third baseman Maikel Garcia is likely headed back to the injured list.",
        ),
      ]);
      expect(label).not.toBe("Brewers Place");
    });

    it("does not name a storyline after a lowercase verb in its own headline", () => {
      // `Neto Homers`: "homers" is lowercase in the title it came from, which
      // is what rules the case override out and the lexicon in — `homer` was
      // absent from every list.
      const label = bigramLabel([
        article(
          "Neto homers in 5-hit, 7-RBI night to help the Angels rout the Astros 18-3",
          "HOUSTON (AP) — Zach Neto was 5-for-6 with his 21st homer and a career-high seven RBIs and the Los Angeles Angels scored their most runs in three years to rout the Houston Astros 18-3 on Thursday night.",
        ),
        article(
          "Angel Reese has stunning perfect shooting night in the Dream's 124-88 romp over the Sparks",
          "LOS ANGELES (AP) — Angel Reese had a stunning perfect shooting night and the Atlanta Dream set a franchise record for points in a game.",
        ),
      ]);
      expect(label).not.toBe("Neto Homers");
    });

    it("does not keep a verb one member capitalized inside a name", () => {
      // `Lufthansa Discover` is the honest loss in this change: "Discover
      // Airline" really is the carrier's name, and `discover` really is in
      // VERB_LEMMAS, so the override was doing its job — on one member's word.
      // The storyline is a pile of two unrelated airline stories either way,
      // and a label naming one member is what it gets.
      expect(
        bigramLabel([
          article(
            "Lufthansa's Discover Airline says jet fuel shortage affects flights from Namibia to Europe",
            "Lufthansa's Discover Airline said on Thursday that a temporary jet fuel shortage at Namibia's Windhoek airport was disrupting its flights to Europe.",
          ),
          article(
            "Alaska Airlines launches 2 more nonstop intercontinental routes from Seattle",
            "Alaska Airlines will offer new nonstop flights from Seattle to Europe, adding to its growing list of intercontinental destinations.",
          ),
        ]),
      ).toBe("Alaska Airlines");
    });
  });
});
