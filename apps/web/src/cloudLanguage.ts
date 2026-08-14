import { ENGLISH } from "./browserDefaults.js";
import { ANY_LANGUAGE } from "./filterChips.js";

/**
 * Which language the trending cloud is built for.
 *
 * A timeline can be unfiltered; the cloud cannot. Terms are ranked inside one
 * language's 24-hour corpus against that language's own baseline (§10.1), and
 * the service caches and samples per language — so "any language" is not a
 * cloud that can be built, only a chip state the cloud has to answer for.
 * English answers it, as the corpus upstream covers most deeply.
 */
export function cloudLanguage(language: string | undefined): string {
  return language && language !== ANY_LANGUAGE ? language : ENGLISH;
}
