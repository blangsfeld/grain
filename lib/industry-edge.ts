/**
 * Industry Edge — web search seeded by atom themes.
 *
 * Extracts top themes from recent atoms, runs targeted searches,
 * returns raw results for the briefing prompt to interpret.
 *
 * Uses Google Custom Search API (free tier: 100 queries/day).
 * Requires GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_ENGINE_ID in env.
 */

import { queryAtoms } from "@/lib/atom-db";
import type { DxAtom } from "@/types/atoms";

interface SearchResult {
  title: string;
  snippet: string;
  link: string;
}

interface EdgeContext {
  themes: string[];
  results: Array<{ query: string; items: SearchResult[] }>;
}

/**
 * Gather industry edge context based on atom themes.
 * Returns null if search API is not configured.
 */
export async function gatherIndustryEdge(): Promise<string | null> {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const engineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

  if (!apiKey || !engineId) return null;

  try {
    // Extract themes from recent atoms
    const themes = await extractThemes();
    if (themes.length === 0) return null;

    // Run searches (max 3 to stay within free tier)
    const searchQueries = themes.slice(0, 3);
    const results = await Promise.all(
      searchQueries.map((q) => searchGoogle(q, apiKey, engineId))
    );

    const edge: EdgeContext = {
      themes,
      results: searchQueries.map((query, i) => ({
        query,
        items: results[i],
      })),
    };

    return formatEdgeContext(edge);
  } catch {
    return null;
  }
}

/**
 * Extract top themes from recent atoms.
 * Looks at:
 * - Most frequent topics in recent beliefs/tensions
 * - Emerging beliefs (confidence = "emerging")
 * - Recurring domains
 */
async function extractThemes(): Promise<string[]> {
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];

  const [beliefs, tensions] = await Promise.all([
    queryAtoms({ type: "belief", since: fourteenDaysAgo, archived: false, limit: 50 }),
    queryAtoms({ type: "tension", since: fourteenDaysAgo, archived: false, limit: 30 }),
  ]);

  // Count word frequency across belief statements and tension gaps
  const wordCounts = new Map<string, number>();
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "about", "through",
    "that", "this", "it", "its", "not", "but", "or", "and", "if", "than",
    "they", "them", "their", "we", "our", "you", "your", "he", "she",
    "more", "most", "just", "also", "both", "each", "all", "any", "much",
    "very", "too", "how", "what", "when", "where", "who", "which",
  ]);

  const extractWords = (text: string) => {
    return text.toLowerCase()
      .replace(/[^a-z\s-]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));
  };

  for (const atom of beliefs) {
    const c = atom.content as unknown as Record<string, unknown>;
    const statement = (c.statement as string) ?? "";
    for (const word of extractWords(statement)) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }

  for (const atom of tensions) {
    const c = atom.content as unknown as Record<string, unknown>;
    const gap = (c.gap as string) ?? "";
    for (const word of extractWords(gap)) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }

  // Find bigrams and common phrases
  const phrases = new Map<string, number>();
  const allTexts = [
    ...beliefs.map((a) => ((a.content as unknown as Record<string, unknown>).statement as string) ?? ""),
    ...tensions.map((a) => ((a.content as unknown as Record<string, unknown>).gap as string) ?? ""),
  ];

  for (const text of allTexts) {
    const words = extractWords(text);
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      phrases.set(bigram, (phrases.get(bigram) ?? 0) + 1);
    }
  }

  // Top bigrams that appear 3+ times become search themes
  const topPhrases = Array.from(phrases.entries())
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phrase]) => phrase);

  // If not enough bigrams, fall back to top single words
  if (topPhrases.length < 3) {
    const topWords = Array.from(wordCounts.entries())
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);

    // Combine into search queries
    const searchThemes = [...topPhrases];
    for (let i = 0; i < topWords.length - 1 && searchThemes.length < 5; i += 2) {
      searchThemes.push(`${topWords[i]} ${topWords[i + 1]} creative industry`);
    }
    return searchThemes;
  }

  // Add "creative industry" or "creative services" context to make searches more relevant
  return topPhrases.map((p) => `${p} creative services 2026`);
}

async function searchGoogle(
  query: string,
  apiKey: string,
  engineId: string,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    key: apiKey,
    cx: engineId,
    q: query,
    num: "3",
    dateRestrict: "m1", // last month
  });

  const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
  if (!res.ok) return [];

  const data = await res.json();
  return (data.items ?? []).slice(0, 3).map((item: { title: string; snippet: string; link: string }) => ({
    title: item.title,
    snippet: item.snippet,
    link: item.link,
  }));
}

function formatEdgeContext(edge: EdgeContext): string {
  const lines: string[] = [];
  lines.push(`Themes extracted from recent atoms: ${edge.themes.join(", ")}`);
  lines.push("");

  for (const result of edge.results) {
    if (result.items.length === 0) continue;
    lines.push(`Search: "${result.query}"`);
    for (const item of result.items) {
      lines.push(`  - ${item.title}`);
      lines.push(`    ${item.snippet.slice(0, 150)}`);
    }
  }

  return lines.join("\n");
}
