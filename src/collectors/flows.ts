/**
 * 투자자별 순매수 금액 수집기 (코스피·코스닥, 외국인·기관).
 *
 * 소스: 네이버 금융 투자자별 매매동향(일별) HTML. 단위는 억원.
 * KRX 정보데이터시스템도 검토했으나 세션 쿠키를 넣어도 LOGOUT을 반환해 제외했다 (DECISIONS #12).
 *
 * HTML 파싱이라 마크업이 바뀌면 깨진다 — 실패 시 "데이터 없음"으로 넘어간다.
 * 페이지가 EUC-KR이라 바이트를 직접 디코딩한다.
 */
import { BROWSER_UA, fetchWithRetry } from "../http.js";
import { recentKrTradingDates } from "../date.js";
import { type Collector, type CollectResult, toResult } from "./types.js";

const MARKETS = [
  { sosok: "01", label: "코스피" },
  { sosok: "02", label: "코스닥" },
] as const;

export interface MarketFlow {
  market: string;
  /** 순매수 금액 (억원). 음수면 순매도 */
  individual: number;
  foreign: number;
  institution: number;
  /** 소스 표기 날짜 (YY.MM.DD) */
  tradeDate: string;
}

export interface FlowsData {
  unit: "억원";
  markets: MarketFlow[];
}

/** "-11,844" → -11844 */
function toNumber(s: string): number {
  const n = Number(s.replace(/,/g, "").trim());
  if (!Number.isFinite(n)) throw new Error(`숫자 아님: ${s}`);
  return n;
}

/**
 * 일별 표의 첫 데이터 행에서 날짜·개인·외국인·기관계를 뽑는다.
 * 열 순서: 날짜 | 개인 | 외국인 | 기관계 | (기관 세부 6열) | 기타법인
 */
function parseFirstRow(html: string, market: string): MarketFlow {
  const dateMatch = /<td class="date2">([^<]+)<\/td>/.exec(html);
  if (!dateMatch?.[1]) throw new Error(`${market}: 날짜 셀을 찾지 못함`);

  // 날짜 셀 이후의 숫자 셀 3개가 개인·외국인·기관계
  const after = html.slice(dateMatch.index + dateMatch[0].length);
  const cells = [...after.matchAll(/<td class="rate_(?:up|down)\d*">([^<]*)<\/td>/g)]
    .slice(0, 3)
    .map((m) => m[1] ?? "");

  if (cells.length < 3) {
    throw new Error(`${market}: 숫자 셀이 ${cells.length}개뿐 (3개 필요)`);
  }

  return {
    market,
    tradeDate: dateMatch[1].trim(),
    individual: toNumber(cells[0] ?? ""),
    foreign: toNumber(cells[1] ?? ""),
    institution: toNumber(cells[2] ?? ""),
  };
}

/**
 * bizdate는 필수다 — 빼면 빈 표가 온다 (2026-08-06 실측).
 * 공휴일이면 그 날짜의 표가 비므로 다음 후보 날짜로 재시도한다.
 */
async function fetchMarketFlow(
  sosok: string,
  label: string,
  candidates: string[],
): Promise<MarketFlow> {
  const errors: string[] = [];
  for (const bizdate of candidates) {
    const res = await fetchWithRetry(
      "https://finance.naver.com/sise/investorDealTrendDay.naver" +
        `?bizdate=${bizdate}&sosok=${sosok}`,
      { headers: { "User-Agent": BROWSER_UA } },
      `naver:flows:${label}:${bizdate}`,
    );
    // 네이버 금융은 EUC-KR로 응답한다. res.text()는 UTF-8로 가정하므로 직접 디코딩한다.
    const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
    try {
      return parseFirstRow(html, label);
    } catch (e) {
      errors.push(`${bizdate}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`${label} 전 후보일 실패 — ${errors.join(" / ")}`);
}

export const flowsCollector: Collector<FlowsData> = {
  name: "flows",
  async collect(): Promise<CollectResult<FlowsData>> {
    return toResult(async () => {
      const candidates = recentKrTradingDates();
      const settled = await Promise.allSettled(
        MARKETS.map((m) => fetchMarketFlow(m.sosok, m.label, candidates)),
      );
      const markets = settled
        .filter((r): r is PromiseFulfilledResult<MarketFlow> => r.status === "fulfilled")
        .map((r) => r.value);

      if (markets.length === 0) {
        const reasons = settled
          .map((r) => (r.status === "rejected" ? String(r.reason) : ""))
          .filter(Boolean)
          .join("; ");
        throw new Error(`전 시장 실패: ${reasons}`);
      }
      return { unit: "억원", markets };
    });
  },
};
