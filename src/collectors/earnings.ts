/**
 * 미국 실적 발표 수집기.
 *
 * 소스: Nasdaq 비공식 API 2종
 *  - /api/calendar/earnings?date=  → 그날 발표 예정 종목 + 컨센서스 EPS
 *  - /api/company/{sym}/earnings-surprise → 실제 EPS vs 컨센서스 vs 서프라이즈 %
 *
 * 캘린더는 컨센서스만 주고 실제 발표치는 surprise API에만 있어 두 번 호출한다.
 * 가이던스와 컨콜 발언은 어느 쪽에도 없다 — 뉴스 기사에 의존한다 (DECISIONS #5).
 *
 * 무료지만 비공식이다. Akamai가 데이터센터 IP를 차단하는 사례가 있어
 * Actions에서 실패할 수 있다 — 실패 시 "데이터 없음"으로 넘어간다.
 */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { BROWSER_UA, fetchJson } from "../http.js";
import { type Collector, type CollectResult, toResult } from "./types.js";

/** 상세 조회는 종목당 1회 호출이라 상한을 둔다 (워치리스트 + 시총 상위) */
const MAX_DETAIL_LOOKUPS = 8;

const watchlistSchema = z.object({
  stocks: z.array(z.object({ ticker: z.string(), nameKo: z.string() })),
});

const calendarSchema = z.object({
  data: z
    .object({
      rows: z
        .array(
          z.object({
            symbol: z.string(),
            name: z.string(),
            time: z.string().optional(),
            marketCap: z.string().optional(),
            epsForecast: z.string().optional(),
            lastYearEPS: z.string().optional(),
            fiscalQuarterEnding: z.string().optional(),
          }),
        )
        .nullable(),
    })
    .nullable(),
});

const surpriseSchema = z.object({
  data: z
    .object({
      earningsSurpriseTable: z
        .object({
          rows: z.array(
            z.object({
              fiscalQtrEnd: z.string(),
              dateReported: z.string(),
              eps: z.union([z.number(), z.string()]),
              consensusForecast: z.string(),
              percentageSurprise: z.string(),
            }),
          ),
        })
        .nullable(),
    })
    .nullable(),
});

export interface EarningsItem {
  symbol: string;
  name: string;
  /** time-pre-market / time-after-hours 등 */
  time: string;
  marketCap: string;
  /** 컨센서스 EPS (캘린더 기준) */
  epsForecast: string;
  /** 실제 발표 EPS. 아직 발표 전이거나 조회 실패면 null */
  epsActual: number | null;
  /** 서프라이즈 % */
  surprisePct: string | null;
  reportedOn: string | null;
  /** 워치리스트 종목인지 */
  watched: boolean;
}

export interface EarningsData {
  /** 조회 기준일 (미국장, YYYY-MM-DD) */
  date: string;
  /** 그날 발표 예정 전체 건수 */
  totalCount: number;
  /** 상세까지 조회한 종목 */
  items: EarningsItem[];
  /** 가이던스·컨콜 발언은 이 소스에 없음을 요약 단계에 알린다 */
  note: string;
}

const headers = {
  "User-Agent": BROWSER_UA,
  Accept: "application/json, text/plain, */*",
};

/** "$1,050,682,051,846" → 1050682051846. 파싱 실패는 0으로 (정렬용) */
function capValue(s: string | undefined): number {
  const n = Number((s ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 발표일이 조회 기준일과 같은 행만 실제 발표치로 인정한다 */
function sameDay(dateReported: string, isoDate: string): boolean {
  // Nasdaq은 "8/05/2026" 형태로 준다
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateReported.trim());
  if (!m) return false;
  const [, mm, dd, yyyy] = m;
  return (
    `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}` ===
    isoDate
  );
}

async function fetchSurprise(
  symbol: string,
  isoDate: string,
): Promise<Pick<EarningsItem, "epsActual" | "surprisePct" | "reportedOn">> {
  const raw = surpriseSchema.parse(
    await fetchJson(
      `https://api.nasdaq.com/api/company/${encodeURIComponent(symbol)}/earnings-surprise`,
      { headers },
      `nasdaq:surprise:${symbol}`,
    ),
  );
  const rows = raw.data?.earningsSurpriseTable?.rows ?? [];
  const hit = rows.find((r) => sameDay(r.dateReported, isoDate));
  if (!hit) return { epsActual: null, surprisePct: null, reportedOn: null };
  return {
    epsActual: typeof hit.eps === "number" ? hit.eps : Number(hit.eps),
    surprisePct: hit.percentageSurprise,
    reportedOn: hit.dateReported,
  };
}

/**
 * @param isoDate 미국장 기준 조회일 (YYYY-MM-DD).
 *                KST 아침 실행 시점의 "어제 미국장"을 호출부가 계산해 넘긴다.
 */
export function createEarningsCollector(isoDate: string): Collector<EarningsData> {
  return {
    name: "earnings",
    async collect(): Promise<CollectResult<EarningsData>> {
      return toResult(async () => {
        const watchlist = watchlistSchema.parse(
          JSON.parse(await readFile("watchlist.json", "utf8")),
        );
        const watched = new Set(watchlist.stocks.map((s) => s.ticker.toUpperCase()));

        const cal = calendarSchema.parse(
          await fetchJson(
            `https://api.nasdaq.com/api/calendar/earnings?date=${isoDate}`,
            { headers },
            "nasdaq:earnings-calendar",
          ),
        );
        const rows = cal.data?.rows ?? [];
        if (rows.length === 0) {
          return {
            date: isoDate,
            totalCount: 0,
            items: [],
            note: "해당일 실적 발표 없음",
          };
        }

        // 워치리스트를 먼저, 나머지는 시총 순으로 채운다
        const ranked = [...rows].sort((a, b) => {
          const aw = watched.has(a.symbol.toUpperCase()) ? 1 : 0;
          const bw = watched.has(b.symbol.toUpperCase()) ? 1 : 0;
          if (aw !== bw) return bw - aw;
          return capValue(b.marketCap) - capValue(a.marketCap);
        });
        const picked = ranked.slice(0, MAX_DETAIL_LOOKUPS);

        const details = await Promise.allSettled(
          picked.map((r) => fetchSurprise(r.symbol, isoDate)),
        );

        const items = picked.map<EarningsItem>((r, i) => {
          const d = details[i];
          const detail =
            d?.status === "fulfilled"
              ? d.value
              : { epsActual: null, surprisePct: null, reportedOn: null };
          return {
            symbol: r.symbol,
            name: r.name,
            time: r.time ?? "",
            marketCap: r.marketCap ?? "",
            epsForecast: r.epsForecast ?? "",
            watched: watched.has(r.symbol.toUpperCase()),
            ...detail,
          };
        });

        console.log(
          `[earnings] ${isoDate} 전체 ${rows.length}건 중 ${items.length}건 상세 조회` +
            ` (실제치 확보 ${items.filter((i) => i.epsActual !== null).length}건)`,
        );

        return {
          date: isoDate,
          totalCount: rows.length,
          items,
          note: "가이던스·컨콜 발언은 이 소스에 없다. 뉴스 기사에서만 근거를 찾을 것.",
        };
      });
    },
  };
}
