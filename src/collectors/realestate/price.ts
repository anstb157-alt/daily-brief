/**
 * 주간 아파트 가격동향 수집기 (한국부동산원 R-ONE 오픈API).
 *
 * API는 지수(index)만 주고 변동률은 주지 않으므로,
 * 최신 주와 직전 주 지수를 받아 여기서 변동률을 계산한다.
 *
 * 주간 통계라 매일 새 값이 나오지 않는다. 발표일이 아니면 직전 발표치를 그대로 쓰고
 * 며칠 전 기준인지 함께 넘긴다 — 대시보드가 "(n일 전 기준)"을 붙일 수 있어야 한다.
 *
 * 무료. 인증키는 R-ONE 사이트에서 발급하며 쿼터 명시는 없다.
 */
import { z } from "zod";
import { rOneConfig } from "../../config.js";
import { fetchJson } from "../../http.js";
import { type Collector, type CollectResult, toResult } from "../types.js";

const BASE = "https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do";

/** 2026-08-06 실측으로 확정한 주간 통계표 ID */
const TABLES = {
  매매: "T244183132827305",
  전세: "T247713133046872",
} as const;

/** 대시보드에 고정으로 올라가는 지역. 순서를 바꾸지 않는다 */
const REGIONS = ["서울", "수도권", "지방권"] as const;

/** 한 주에 236개 지역이 오므로 넉넉히 받는다 */
const PAGE_SIZE = 400;
/** 최신 주를 못 찾을 때 거슬러 올라갈 최대 주 수 */
const LOOKBACK_WEEKS = 6;

const rowSchema = z.object({
  WRTTIME_IDTFR_ID: z.string(),
  WRTTIME_DESC: z.string(),
  CLS_NM: z.string(),
  DTA_VAL: z.number(),
});

/**
 * 응답 최상위 키가 통계표마다 다르고, 데이터가 없는 주차는
 * `{"RESULT":{...}}` 형태로 배열이 아예 오지 않는다 (2026-08-06 실측).
 * 그래서 형태를 강제하지 않고 받아서 배열만 골라낸다.
 */
const responseSchema = z.record(z.string(), z.unknown());

export interface WeeklyChange {
  region: string;
  /** 전주 대비 변동률 (%) */
  changeRatio: number;
  /** 지수 값 */
  index: number;
}

export interface PriceData {
  /** 조사 기준일 (YYYY-MM-DD) */
  surveyDate: string;
  /** 조사 기준일이 오늘로부터 며칠 전인지 — "(n일 전 기준)" 표기용 */
  daysAgo: number;
  sale: WeeklyChange[];
  lease: WeeklyChange[];
}

async function fetchWeek(
  key: string,
  statblId: string,
  week: string,
): Promise<Map<string, z.infer<typeof rowSchema>>> {
  const url =
    `${BASE}?KEY=${encodeURIComponent(key)}&Type=json&pIndex=1&pSize=${PAGE_SIZE}` +
    `&STATBL_ID=${statblId}&DTACYCLE_CD=WK&WRTTIME_IDTFR_ID=${week}`;
  const raw = responseSchema.parse(await fetchJson(url, {}, `rone:${statblId}:${week}`));

  const blocks = Object.values(raw).find(Array.isArray) ?? [];
  const rows = (blocks as unknown[]).flatMap((b) => {
    const list = (b as { row?: unknown }).row;
    return Array.isArray(list) ? list : [];
  });

  const map = new Map<string, z.infer<typeof rowSchema>>();
  for (const r of rows) {
    const parsed = rowSchema.safeParse(r);
    if (parsed.success) map.set(parsed.data.CLS_NM, parsed.data);
  }
  return map;
}

/** `202631` → 직전 주 `202630`. 연초는 전년도 마지막 주로 넘어간다 */
function prevWeek(id: string): string {
  const year = Number(id.slice(0, 4));
  const week = Number(id.slice(4));
  return week > 1
    ? `${year}${String(week - 1).padStart(2, "0")}`
    : `${year - 1}52`;
}

/** 오늘(UTC 기준 일수 차)로부터 며칠 전인지 */
function daysBetween(isoDate: string): number {
  const then = new Date(`${isoDate}T00:00:00Z`).getTime();
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((today - then) / 86_400_000));
}

/**
 * 발표가 늦어질 수 있으므로 최근 주부터 거슬러 올라가며 데이터가 있는 주를 찾는다.
 * ISO 주차를 직접 계산하지 않고 API가 준 WRTTIME_IDTFR_ID를 그대로 쓴다.
 */
async function findLatestWeek(key: string): Promise<string> {
  const now = new Date();
  const year = now.getUTCFullYear();
  // ISO 주차 근사: 연초부터 며칠 지났는지 / 7
  const startOfYear = Date.UTC(year, 0, 1);
  const approxWeek = Math.floor((now.getTime() - startOfYear) / (7 * 86_400_000)) + 1;

  let candidate = `${year}${String(approxWeek).padStart(2, "0")}`;
  for (let i = 0; i < LOOKBACK_WEEKS; i++) {
    const map = await fetchWeek(key, TABLES.매매, candidate);
    if (map.size > 0) return candidate;
    candidate = prevWeek(candidate);
  }
  throw new Error(`최근 ${LOOKBACK_WEEKS}주 내 주간 가격동향 데이터를 찾지 못했다`);
}

function toChanges(
  latest: Map<string, z.infer<typeof rowSchema>>,
  prev: Map<string, z.infer<typeof rowSchema>>,
): WeeklyChange[] {
  return REGIONS.flatMap((region) => {
    const a = latest.get(region);
    const b = prev.get(region);
    if (!a || !b || b.DTA_VAL === 0) return [];
    return [
      {
        region,
        index: Number(a.DTA_VAL.toFixed(4)),
        changeRatio: Number((((a.DTA_VAL - b.DTA_VAL) / b.DTA_VAL) * 100).toFixed(2)),
      },
    ];
  });
}

export const priceCollector: Collector<PriceData> = {
  name: "price",
  async collect(): Promise<CollectResult<PriceData>> {
    return toResult(async () => {
      const { RONE_API_KEY } = rOneConfig();
      const week = await findLatestWeek(RONE_API_KEY);
      const prior = prevWeek(week);

      const [saleNow, salePrev, leaseNow, leasePrev] = await Promise.all([
        fetchWeek(RONE_API_KEY, TABLES.매매, week),
        fetchWeek(RONE_API_KEY, TABLES.매매, prior),
        fetchWeek(RONE_API_KEY, TABLES.전세, week),
        fetchWeek(RONE_API_KEY, TABLES.전세, prior),
      ]);

      const surveyDate = saleNow.get("서울")?.WRTTIME_DESC ?? "";
      const sale = toChanges(saleNow, salePrev);
      const lease = toChanges(leaseNow, leasePrev);

      if (sale.length === 0 && lease.length === 0) {
        throw new Error(`${week} 주차 지역 데이터를 찾지 못했다`);
      }

      const daysAgo = surveyDate ? daysBetween(surveyDate) : 0;
      console.log(
        `[price] ${week} (${surveyDate}, ${daysAgo}일 전) 매매 ${sale.length}개 / 전세 ${lease.length}개 지역`,
      );

      return { surveyDate, daysAgo, sale, lease };
    });
  },
};
