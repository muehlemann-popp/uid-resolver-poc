/**
 * Minimal Firecrawl v2 client (REST, no SDK needed).
 * Docs: https://docs.firecrawl.dev
 */

const BASE = "https://api.firecrawl.dev/v2";

function apiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY is not set");
  return key;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firecrawl ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export type SearchResult = {
  url: string;
  title?: string;
  description?: string;
};

type SearchResponse = {
  success: boolean;
  data?: { web?: SearchResult[] };
};

/** Web search. Returns title/snippet/URL - the snippet often already holds the UID. */
export async function firecrawlSearch(
  query: string,
  limit = 5,
): Promise<SearchResult[]> {
  const json = await post<SearchResponse>("/search", {
    query,
    limit,
    sources: ["web"],
    location: "Switzerland",
  });
  return (json.data?.web ?? []).map((r) => ({
    url: r.url,
    title: r.title,
    description: r.description,
  }));
}

type ScrapeResponse = {
  success: boolean;
  data?: {
    markdown?: string;
    metadata?: { title?: string; url?: string; statusCode?: number };
  };
};

/** Fetch a single page as markdown (the "crawl" part - /scrape is enough for one page). */
export async function firecrawlScrape(
  url: string,
  maxChars = 12000,
): Promise<{ url: string; title?: string; markdown: string; truncated: boolean }> {
  const json = await post<ScrapeResponse>("/scrape", {
    url,
    formats: ["markdown"],
    onlyMainContent: true,
    blockAds: true,
    maxAge: 86400000, // 24h cache - saves credits on repeat lookups
    timeout: 30000,
  });
  const md = json.data?.markdown ?? "";
  return {
    url: json.data?.metadata?.url ?? url,
    title: json.data?.metadata?.title,
    markdown: md.slice(0, maxChars),
    truncated: md.length > maxChars,
  };
}
