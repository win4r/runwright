import { isSpacelessCharacter, words } from "./words.ts";

export interface Bm25Document { id: string; title: string; description: string; body: string }
export interface Bm25Score { id: string; score: number }

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const TITLE_WEIGHT = 3;
/** Only the first this many distinct words of a query are scored. */
export const MAX_QUERY_TERMS = 256;

/**
 * The words of learning's one tokeniser (`words`, `src/learning/words.ts`), without one-character tokens, except a
 * character of a script written without spaces, which is a word by itself.
 */
export function tokenize(text: string): string[] {
  return words(text).filter((word) => [...word].length > 1 || isSpacelessCharacter(word));
}

interface Indexed { id: string; tf: Map<string, number>; length: number }

function index(document: Bm25Document): Indexed {
  const tf = new Map<string, number>();
  let length = 0;
  const add = (text: string, weight: number): void => {
    for (const token of tokenize(text)) {
      tf.set(token, (tf.get(token) ?? 0) + weight);
      length += weight;
    }
  };
  add(document.title, TITLE_WEIGHT);
  add(document.description, 1);
  add(document.body, 1);
  return { id: document.id, tf, length };
}

/**
 * Okapi BM25 (k1 1.2, b 0.75, idf ln(1 + (N - n + 0.5) / (n + 0.5))) over one weighted term frequency built from
 * title ×3, description and body, for the first MAX_QUERY_TERMS distinct words of the query. Sorted by score
 * descending; equal scores keep the input order. Pure.
 */
export function rankBm25(query: string, documents: readonly Bm25Document[]): Bm25Score[] {
  const indexed = documents.map(index);
  const terms = [...new Set(tokenize(query))].slice(0, MAX_QUERY_TERMS);
  const total = indexed.length;
  const averageLength = total === 0 ? 0 : indexed.reduce((sum, d) => sum + d.length, 0) / total;
  const idf = new Map<string, number>();
  for (const term of terms) {
    const n = indexed.filter((d) => d.tf.has(term)).length;
    idf.set(term, Math.log(1 + (total - n + 0.5) / (n + 0.5)));
  }
  const scored = indexed.map((d, position) => {
    let score = 0;
    const norm = averageLength === 0 ? 1 : 1 - BM25_B + BM25_B * (d.length / averageLength);
    for (const term of terms) {
      const tf = d.tf.get(term) ?? 0;
      if (tf === 0) continue;
      score += (idf.get(term) as number) * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
    }
    return { id: d.id, score, position };
  });
  scored.sort((a, b) => b.score - a.score || a.position - b.position);
  return scored.map(({ id, score }) => ({ id, score }));
}
