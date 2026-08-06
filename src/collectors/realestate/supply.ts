/**
 * 공급·입주·미분양 물량 수집기 (한국부동산원 R-ONE 월간 통계).
 *
 * 통계표 ID는 2026-08-06 실측으로 확정했다 (DTACYCLE_CD=MM).
 *   신규 분양세대수  T244633134461863  → 공급물량
 *   주택준공실적     T237273130004614  → 입주물량
 *   미분양주택현황   T237973129847263  → 미분양
 *
 * 월간 통계라 발표 지연이 크다. 최근 달부터 거슬러 올라가며 값이 있는 달을 찾고,
 * 기준 연월을 함께 넘겨 "언제 기준인지"를 브리핑이 밝힐 수 있게 한다.
 */
import { z } from "zod";
import { rOneConfig } from "../../config.js";
import { fetchJson } from "../../http.js";
import { type Collector, type CollectResult, toResult } from "../types.js";

const BASE = "https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do";

/**
 * 전국 합계를 가리키는 이름이 표마다 다르다 (2026-08-06 실측).
 *   신규 분양세대수 → "전국"
 *   주택준공실적    → "총계"
 *   미분양주택현황  → "계"
 * 같은 이름이 여러 행에 반복되므로 그중 가장 큰 값을 전국 합계로 본다.
 */
const TABLES = [
  {
    key: "newSupplyUnits",
    id: "T244633134461863",
    label: "신규 분양세대수",
    nationNames: ["전국"],
  },
  {
    key: "completedUnits",
    id: "T237273130004614",
    label: "주택준공실적",
    nationNames: ["총계", "전국"],
  },
  {
    key: "unsoldUnits",
    id: "T237973129847263",
    label: "미분양주택현황",
    nationNames: ["계", "전국", "총계"],
  },
] as const;
/** 월간 통계는 발표가 늦다. 이만큼 거슬러 올라가며 찾는다 */
const LOOKBACK_MONTHS = 6;
const PAGE_SIZE = 400;

const rowSchema = z.object({
  WRTTIME_IDTFR_ID: z.string(),
  CLS_NM: z.string(),
  DTA_VAL: z.number(),
});

/** 데이터 없는 기간은 배열이 아예 오지 않으므로 형태를 강제하지 않는다 */
const responseSchema = z.record(z.string(), z.unknown());

export interface SupplyData {
  /** 기준 연월 (YYYYMM). 지표마다 다를 수 있어 개별로 담는다 */
  periods: Record<string, string>;
  newSupplyUnits?: number;
  completedUnits?: number;
  unsoldUnits?: number;
}

/** `202606` → `202605`. 1월은 전년 12월로 */
function prevMonth(id: string): string {
  const y = Number(id.slice(0, 4));
  const m = Number(id.slice(4));
  return m > 1 ? `${y}${String(m - 1).padStart(2, "0")}` : `${y - 1}12`;
}

async function fetchMonth(
  key: string,
  statblId: string,
  month: string,
  label: string,
  nationNames: readonly string[],
): Promise<number | undefined> {
  const url =
    `${BASE}?KEY=${encodeURIComponent(key)}&Type=json&pIndex=1&pSize=${PAGE_SIZE}` +
    `&STATBL_ID=${statblId}&DTACYCLE_CD=MM&WRTTIME_IDTFR_ID=${month}`;
  const raw = responseSchema.parse(await fetchJson(url, {}, `rone:${label}:${month}`));
  const blocks = Object.values(raw).find(Array.isArray) ?? [];
  const rows = (blocks as unknown[]).flatMap((b) => {
    const list = (b as { row?: unknown }).row;
    return Array.isArray(list) ? list : [];
  });

  // 전국 합계 후보 중 최댓값을 고른다 — 지역 소계보다 항상 크다
  let best: number | undefined;
  for (const r of rows) {
    const parsed = rowSchema.safeParse(r);
    if (!parsed.success) continue;
    if (!nationNames.includes(parsed.data.CLS_NM)) continue;
    if (best === undefined || parsed.data.DTA_VAL > best) best = parsed.data.DTA_VAL;
  }
  return best === undefined ? undefined : Math.round(best);
}

/** 최근 달부터 거슬러 올라가며 값이 있는 첫 달을 반환한다 */
async function findLatest(
  key: string,
  statblId: string,
  label: string,
  nationNames: readonly string[],
): Promise<{ month: string; value: number } | null> {
  const now = new Date();
  let month = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  for (let i = 0; i < LOOKBACK_MONTHS; i++) {
    const value = await fetchMonth(key, statblId, month, label, nationNames);
    if (value !== undefined) return { month, value };
    month = prevMonth(month);
  }
  return null;
}

export const supplyCollector: Collector<SupplyData> = {
  name: "supply",
  async collect(): Promise<CollectResult<SupplyData>> {
    return toResult(async () => {
      const { RONE_API_KEY } = rOneConfig();

      const settled = await Promise.allSettled(
        TABLES.map(async (t) => ({
          key: t.key,
          label: t.label,
          hit: await findLatest(RONE_API_KEY, t.id, t.label, t.nationNames),
        })),
      );

      const data: SupplyData = { periods: {} };
      const missing: string[] = [];

      for (const [i, r] of settled.entries()) {
        const table = TABLES[i];
        if (!table) continue;
        if (r.status !== "fulfilled" || r.value.hit === null) {
          missing.push(table.label);
          continue;
        }
        data.periods[table.key] = r.value.hit.month;
        data[table.key] = r.value.hit.value;
      }

      if (Object.keys(data.periods).length === 0) {
        throw new Error(`월간 물량 통계 전부 실패: ${missing.join(", ")}`);
      }
      console.log(
        `[supply] ${TABLES.length - missing.length}/${TABLES.length}개 지표` +
          (missing.length > 0 ? ` (실패: ${missing.join(", ")})` : ""),
      );
      return data;
    });
  },
};
