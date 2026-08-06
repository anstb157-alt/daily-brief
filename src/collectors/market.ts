/**
 * 지수·금리·환율 수집기.
 *
 * 소스는 네이버 증권 비공식 API 단일이다 (DECISIONS #3).
 * 2026-08-06 실측 기준 Yahoo Finance는 비인증 요청에 상시 429, stooq도 사용 불가라
 * 폴백이 없다. 대신 항목 단위로 실패를 격리해, 한 지수가 깨져도 나머지는 살린다.
 *
 * 주의: 비공식 API라 예고 없이 스키마가 바뀔 수 있다.
 *       zod 파싱 실패도 해당 항목만 unavailable로 떨어진다.
 */
import { z } from "zod";
import { BROWSER_UA, fetchJson } from "../http.js";
import { type Collector, type CollectResult, toResult } from "./types.js";

/** 네이버 미지원 (2026-08-06 실측). 러셀2000은 무료 소스를 찾지 못해 제외 — DECISIONS #8 */
const US_INDEX_CODES = [
  { code: ".INX", label: "S&P500" },
  { code: ".IXIC", label: "나스닥" },
  { code: ".DJI", label: "다우" },
] as const;

const KR_INDEX_CODES = [
  { code: "KOSPI", label: "코스피" },
  { code: "KOSDAQ", label: "코스닥" },
] as const;

/** 시장지표(금리·환율). category와 reutersCode 조합은 실측으로 확정했다. */
const MACRO_CODES = [
  { category: "bond", code: "US10YT=RR", label: "미10년물", unit: "%" },
  { category: "exchange", code: ".DXY", label: "달러인덱스", unit: "" },
  { category: "exchange", code: "FX_USDKRW", label: "원/달러", unit: "KRW" },
] as const;

export interface Quote {
  label: string;
  /** 종가·현재가 */
  close: number;
  /** 전일 대비 절대 변동 */
  change: number;
  /** 전일 대비 % */
  changeRatio: number;
  /** 표기 단위 (없으면 지수 포인트) */
  unit: string;
  /** 시장 상태 — OPEN이면 장중값이라 "전일 종가"가 아님을 요약에 반영해야 한다 */
  marketStatus: string;
  /** 소스가 준 체결 시각 (ISO, 원문 타임존 유지) */
  asOf: string;
}

export interface MarketData {
  us: Quote[];
  kr: Quote[];
  macro: Quote[];
  /** 개별 항목 실패 목록. 브리핑 하단 표시용 */
  unavailable: { label: string; reason: string }[];
}

// ─── 응답 스키마 ────────────────────────────────────────────────
// 숫자가 "6,304.75" 형태의 문자열로 온다. 콤마를 제거해 파싱한다.

const numeric = z.string().transform((s, ctx) => {
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `숫자 아님: ${s}` });
    return z.NEVER;
  }
  return n;
});

/** 해외지수 (api.stock.naver.com) */
const usIndexSchema = z.object({
  closePrice: numeric,
  compareToPreviousClosePrice: numeric,
  fluctuationsRatio: numeric,
  marketStatus: z.string(),
  localTradedAt: z.string(),
});

/** 국내지수 (m.stock.naver.com) — 해외지수와 필드명은 같으나 호스트·경로가 다르다 */
const krIndexSchema = usIndexSchema;

/** 시장지표 — 변동폭 필드명이 지수와 다르다 (fluctuations) */
const macroSchema = z.object({
  result: z.object({
    closePrice: numeric,
    fluctuations: numeric,
    fluctuationsRatio: numeric,
    marketStatus: z.string(),
    localTradedAt: z.string(),
  }),
});

const headers = { "User-Agent": BROWSER_UA, Accept: "application/json" };

async function fetchUsIndex(code: string, label: string): Promise<Quote> {
  const raw = usIndexSchema.parse(
    await fetchJson(
      `https://api.stock.naver.com/index/${encodeURIComponent(code)}/basic`,
      { headers },
      `naver:us-index:${label}`,
    ),
  );
  return {
    label,
    close: raw.closePrice,
    change: raw.compareToPreviousClosePrice,
    changeRatio: raw.fluctuationsRatio,
    unit: "",
    marketStatus: raw.marketStatus,
    asOf: raw.localTradedAt,
  };
}

async function fetchKrIndex(code: string, label: string): Promise<Quote> {
  const raw = krIndexSchema.parse(
    await fetchJson(
      `https://m.stock.naver.com/api/index/${encodeURIComponent(code)}/basic`,
      { headers },
      `naver:kr-index:${label}`,
    ),
  );
  return {
    label,
    close: raw.closePrice,
    change: raw.compareToPreviousClosePrice,
    changeRatio: raw.fluctuationsRatio,
    unit: "",
    marketStatus: raw.marketStatus,
    asOf: raw.localTradedAt,
  };
}

async function fetchMacro(
  category: string,
  code: string,
  label: string,
  unit: string,
): Promise<Quote> {
  const url =
    "https://m.stock.naver.com/front-api/marketIndex/productDetail" +
    `?category=${encodeURIComponent(category)}&reutersCode=${encodeURIComponent(code)}`;
  const raw = macroSchema.parse(
    await fetchJson(url, { headers }, `naver:macro:${label}`),
  );
  return {
    label,
    close: raw.result.closePrice,
    change: raw.result.fluctuations,
    changeRatio: raw.result.fluctuationsRatio,
    unit,
    marketStatus: raw.result.marketStatus,
    asOf: raw.result.localTradedAt,
  };
}

/** 항목별로 성공/실패를 갈라 담는다. 하나가 죽어도 나머지는 남긴다. */
function partition(
  settled: PromiseSettledResult<Quote>[],
  labels: readonly string[],
): { quotes: Quote[]; failed: { label: string; reason: string }[] } {
  const quotes: Quote[] = [];
  const failed: { label: string; reason: string }[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      quotes.push(r.value);
    } else {
      failed.push({
        label: labels[i] ?? `#${i}`,
        reason: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });
  return { quotes, failed };
}

export const marketCollector: Collector<MarketData> = {
  name: "market",
  async collect(): Promise<CollectResult<MarketData>> {
    return toResult(async () => {
      const [us, kr, macro] = await Promise.all([
        Promise.allSettled(
          US_INDEX_CODES.map((c) => fetchUsIndex(c.code, c.label)),
        ),
        Promise.allSettled(
          KR_INDEX_CODES.map((c) => fetchKrIndex(c.code, c.label)),
        ),
        Promise.allSettled(
          MACRO_CODES.map((c) => fetchMacro(c.category, c.code, c.label, c.unit)),
        ),
      ]);

      const usPart = partition(us, US_INDEX_CODES.map((c) => c.label));
      const krPart = partition(kr, KR_INDEX_CODES.map((c) => c.label));
      const macroPart = partition(macro, MACRO_CODES.map((c) => c.label));

      const unavailable = [
        ...usPart.failed,
        ...krPart.failed,
        ...macroPart.failed,
      ];

      // 전부 실패했다면 소스 자체가 죽은 것이므로 수집기 실패로 올린다.
      if (
        usPart.quotes.length === 0 &&
        krPart.quotes.length === 0 &&
        macroPart.quotes.length === 0
      ) {
        throw new Error(
          `네이버 증권 API 전체 실패: ${unavailable.map((u) => `${u.label}(${u.reason})`).join(", ")}`,
        );
      }

      return {
        us: usPart.quotes,
        kr: krPart.quotes,
        macro: macroPart.quotes,
        unavailable,
      };
    });
  },
};
