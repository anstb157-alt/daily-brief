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
const PER_QUERY = 8;
/**
 * 브리핑은 "오늘 아침 기준 최신"이어야 한다.
 * 이 시간을 넘긴 기사는 버린다. 단 전부 걸러지면 필터를 풀어
 * 조용한 날에 뉴스가 0건이 되는 상황을 막는다.
 */
const FRESH_WINDOW_HOURS = 30;
/** 최신 필터 후 이 건수 미만이면 필터를 해제한다 */
const MIN_ITEMS = 5;

const watchlistSchema = z.object({
  stocks: z.array(z.object({ ticker: z.string(), nameKo: z.string() })),
});

export interface NewsItem {
  /** 어떤 키워드로 찾았는지 — 워치리스트 매핑에 쓴다 */
  query: string;
  title: string;
  /**
   * 기사 요약. 제목만으로는 "실적은 호조인데 가이던스가 문제" 같은
   * 인과가 넘어가지 않아 요약 단계가 잘못 판단한다 (2026-08-06 샌디스크 사례).
   */
  summary: string;
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
  // when:1d — 구글뉴스 검색 연산자. 최근 24시간 기사로 제한한다.
  const url =
    "https://news.google.com/rss/search?q=" +
    `${encodeURIComponent(`${query} when:1d`)}&hl=ko&gl=KR&ceid=KR:ko`;
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
        // 구글뉴스 description은 관련 기사 목록 HTML이라 본문 요약이 아니다.
        // 태그를 걷어내고 앞부분만 남긴다.
        summary: stripTags(tagText(block, "description")).slice(0, 200),
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
      /** 기사 앞부분 요약. 인과를 파악하는 데 제목보다 훨씬 유용하다 */
      description: z.string(),
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

/**
 * 네이버 검색 API는 NAVER Cloud Platform의 NAVER API HUB로 이관됐다 (2026-08-06 실측).
 * 구 developers.naver.com 방식(openapi.naver.com + X-Naver-Client-* 헤더)은 401을 준다.
 * 호스트·경로·헤더가 모두 바뀌었으므로 세 가지를 함께 봐야 한다.
 */
const NAVER_NEWS_URL = "https://naverapihub.apigw.ntruss.com/search/v1/news";

async function fetchNaverNews(query: string): Promise<NewsItem[]> {
  const cfg = naverConfig();
  const url =
    `${NAVER_NEWS_URL}?` +
    `query=${encodeURIComponent(query)}&display=${PER_QUERY}&sort=date`;
  const raw = naverNewsSchema.parse(
    await fetchJson(
      url,
      {
        headers: {
          "X-NCP-APIGW-API-KEY-ID": cfg.NAVER_CLIENT_ID,
          "X-NCP-APIGW-API-KEY": cfg.NAVER_CLIENT_SECRET,
        },
      },
      `naver-news:${query}`,
    ),
  );
  return raw.items.map((i) => ({
    query,
    title: stripTags(i.title),
    summary: stripTags(i.description),
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

/** 파싱 불가한 날짜는 0으로 — 정렬에서 뒤로 밀린다 */
function publishedMs(item: NewsItem): number {
  const t = Date.parse(item.publishedAt);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 최신순 정렬 후 오래된 기사를 버린다.
 * 소스마다 정렬 기준이 달라(구글=관련도, 네이버=날짜) 여기서 한 번에 맞춘다.
 */
function freshest(items: NewsItem[]): { items: NewsItem[]; filtered: boolean } {
  const sorted = [...items].sort((a, b) => publishedMs(b) - publishedMs(a));
  const cutoff = Date.now() - FRESH_WINDOW_HOURS * 3_600_000;
  const fresh = sorted.filter((i) => publishedMs(i) >= cutoff);
  // 너무 많이 걸러지면 최신성보다 정보 있음이 낫다
  return fresh.length >= MIN_ITEMS
    ? { items: fresh, filtered: true }
    : { items: sorted, filtered: false };
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
      const { items: fresh, filtered } = freshest(deduped);
      if (!filtered) {
        skipped.push(
          `${FRESH_WINDOW_HOURS}시간 이내 기사가 ${MIN_ITEMS}건 미만이라 최신 필터 해제`,
        );
      }
      console.log(
        `[news] ${fresh.length}건 (중복 제거 전 ${items.length}, 최신순 정렬` +
          `${filtered ? `, ${FRESH_WINDOW_HOURS}h 이내만` : ""})` +
          (skipped.length > 0 ? ` — 건너뜀: ${skipped.join(" / ")}` : ""),
      );
      return { items: fresh, skipped };
    });
  },
};
