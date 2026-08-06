/**
 * 뉴스 수집기.
 *
 * 1차: 구글뉴스 RSS (인증 없음, 사실상 무제한)
 * 2차: 네이버 검색 API (일 25,000건 무료) — 키가 없거나 실패하면 조용히 건너뛴다
 *
 * 실적 가이던스·컨콜 발언은 무료 구조화 소스가 없어 기사 본문에 의존한다 (DECISIONS #5).
 * 그래서 여기서 모은 기사 제목이 실적·워치리스트·시장반응 섹션의 유일한 근거가 된다.
 *
 * XML 파서를 붙이지 않는 이유: RSS의 item/title/link/pubDate만 쓰므로
 * 의존성을 늘릴 만큼의 복잡도가 아니다.
 */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { BROWSER_UA, fetchJson, fetchWithRetry } from "../http.js";
import { naverConfig } from "../config.js";
import { type Collector, type CollectResult, toResult } from "./types.js";

/** 종목과 무관하게 매일 보는 시장 전반 키워드 */
const MARKET_QUERIES = ["증시", "코스피", "미국증시 마감"] as const;
/** 쿼리당 가져올 기사 수. 요약 입력이 너무 길어지지 않게 제한한다 */
const PER_QUERY = 5;

const watchlistSchema = z.object({
  stocks: z.array(z.object({ ticker: z.string(), nameKo: z.string() })),
});

export interface NewsItem {
  /** 어떤 키워드로 찾았는지 — 워치리스트 매핑에 쓴다 */
  query: string;
  title: string;
  source: string;
  publishedAt: string;
  link: string;
}

export interface NewsData {
  items: NewsItem[];
  /** 실패한 하위 소스 (예: 네이버 키 미설정) */
  skipped: string[];
}

// ─── 구글뉴스 RSS ───────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function tagText(block: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  const raw = m?.[1] ?? "";
  return decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim());
}

async function fetchGoogleNews(query: string): Promise<NewsItem[]> {
  const url =
    "https://news.google.com/rss/search?q=" +
    `${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetchWithRetry(
    url,
    { headers: { "User-Agent": BROWSER_UA } },
    `google-news:${query}`,
  );
  const xml = await res.text();

  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .slice(0, PER_QUERY)
    .map((m) => {
      const block = m[1] ?? "";
      const title = tagText(block, "title");
      return {
        query,
        // 구글뉴스 제목은 "제목 - 언론사" 형태다. 언론사는 source 태그가 더 정확하다.
        title: title.replace(/ - [^-]+$/, ""),
        source: tagText(block, "source"),
        publishedAt: tagText(block, "pubDate"),
        link: tagText(block, "link"),
      };
    })
    .filter((i) => i.title.length > 0);
}

// ─── 네이버 검색 API ────────────────────────────────────────────

const naverNewsSchema = z.object({
  items: z.array(
    z.object({
      title: z.string(),
      originallink: z.string(),
      link: z.string(),
      pubDate: z.string(),
    }),
  ),
});

/** HTML 태그(<b> 하이라이트)를 제거한다 */
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ""));
}

async function fetchNaverNews(query: string): Promise<NewsItem[]> {
  const cfg = naverConfig();
  const url =
    "https://openapi.naver.com/v1/search/news.json?" +
    `query=${encodeURIComponent(query)}&display=${PER_QUERY}&sort=date`;
  const raw = naverNewsSchema.parse(
    await fetchJson(
      url,
      {
        headers: {
          "X-Naver-Client-Id": cfg.NAVER_CLIENT_ID,
          "X-Naver-Client-Secret": cfg.NAVER_CLIENT_SECRET,
        },
      },
      `naver-news:${query}`,
    ),
  );
  return raw.items.map((i) => ({
    query,
    title: stripTags(i.title),
    source: "네이버뉴스",
    publishedAt: i.pubDate,
    link: i.originallink || i.link,
  }));
}

// ─── 수집기 ────────────────────────────────────────────────────

/** 제목 기준 중복 제거. 같은 기사가 여러 쿼리에 걸리는 경우가 잦다 */
function dedupe(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = i.title.replace(/\s+/g, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const newsCollector: Collector<NewsData> = {
  name: "news",
  async collect(): Promise<CollectResult<NewsData>> {
    return toResult(async () => {
      const watchlist = watchlistSchema.parse(
        JSON.parse(await readFile("watchlist.json", "utf8")),
      );
      const queries = [
        ...MARKET_QUERIES,
        ...watchlist.stocks.map((s) => s.nameKo),
      ];

      const skipped: string[] = [];

      const google = await Promise.allSettled(queries.map(fetchGoogleNews));
      const items = google.flatMap((r) =>
        r.status === "fulfilled" ? r.value : [],
      );
      const googleFailed = google.filter((r) => r.status === "rejected").length;
      if (googleFailed > 0) skipped.push(`구글뉴스 ${googleFailed}/${queries.length} 쿼리 실패`);

      // 네이버는 보조 소스다. 키 미설정·인증 실패로 전체를 죽이지 않는다.
      try {
        const naver = await Promise.allSettled(queries.map(fetchNaverNews));
        items.push(
          ...naver.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
        );
        const naverFailed = naver.filter((r) => r.status === "rejected").length;
        if (naverFailed > 0) {
          const first = naver.find((r) => r.status === "rejected");
          skipped.push(
            `네이버뉴스 ${naverFailed}/${queries.length} 쿼리 실패: ${
              first?.status === "rejected" ? String(first.reason).slice(0, 120) : ""
            }`,
          );
        }
      } catch (e) {
        skipped.push(
          `네이버뉴스 건너뜀: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
        );
      }

      const deduped = dedupe(items);
      if (deduped.length === 0) {
        throw new Error(`기사 0건. ${skipped.join(" / ")}`);
      }
      console.log(
        `[news] ${deduped.length}건 (중복 제거 전 ${items.length})` +
          (skipped.length > 0 ? ` — 건너뜀: ${skipped.join(" / ")}` : ""),
      );
      return { items: deduped, skipped };
    });
  },
};
