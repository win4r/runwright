/**
 * The one tokeniser of learning, used by provenance and by BM25: lower-case the text; every character of a
 * script written without spaces between words (Han, Hiragana, Katakana, Hangul, Thai, Lao, Khmer, Myanmar) is a
 * word of its own; every other maximal run of letters and digits is a word; everything else separates words.
 * `"abc設備def"` → `["abc", "設", "備", "def"]`.
 */
const SPACELESS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}";
const WORD = new RegExp(`[${SPACELESS}]|(?:(?![${SPACELESS}])[\\p{L}\\p{N}])+`, "gu");
const SPACELESS_CHARACTER = new RegExp(`^[${SPACELESS}]$`, "u");

export function words(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

/** True when `word` is one character of a script written without spaces (a whole word by itself). */
export function isSpacelessCharacter(word: string): boolean {
  return SPACELESS_CHARACTER.test(word);
}
