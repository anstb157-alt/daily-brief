/**
 * 정량 대시보드.
 *
 * 항목 순서와 개수를 코드가 강제한다. 모델에게 맡기지 않는다 —
 * 지시는 어겨질 수 있지만 코드는 어기지 않는다.
 * 값이 없는 날에도 자리를 비우지 않고 "-"로 채워 순서를 유지한다.
 * 자리가 밀리면 매일 눈으로 찾아야 해서 대시보드의 의미가 사라진다.
 *
 * 톤은 넣지 않는다. 형용사·해설 금지, 방향은 부호로만 (상승/하락 같은 단어를 쓰지 않는다).
 */
import type { MarketData, Quote } from "./collectors/market.js";
import type { FlowsData } from "./collectors/flows.js";
import type { PriceData, WeeklyChange } from "./collectors/realestate/price.js";
import type { SupplyData } from "./collectors/realestate/supply.js";
import type { ApplyhomeData } from "./collectors/realestate/applyhome.js";

/** 값이 없을 때 채우는 자리 표시자 */
export const EMPTY = "-";

export interface DashboardCell {
  label: string;
  /** 주값. 없으면 EMPTY */
  value: string;
  /** 전일 대비. 없으면 EMPTY */
  delta: string;
  /** 색·부호 판정용. 값이 없으면 "flat" */
  direction: "up" | "down" | "flat";
}

export interface DashboardGroup {
  cells: DashboardCell[];
}

/** 그룹 = 구분선(---)으로 나뉘는 묶음 */
export type Dashboard = DashboardGroup[];

const emptyCell = (label: string): DashboardCell => ({
  label,
  value: EMPTY,
  delta: EMPTY,
  direction: "flat",
});

function direction(n: number): DashboardCell["direction"] {
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

/** 부호를 항상 붙인다. 색만으로 방향을 표현하지 않는다 (캡처·색맹 대응) */
function signed(n: number, digits: number, suffix = ""): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(digits)}${suffix}`;
}

function num(n: number, digits: number): string {
  return n.toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 지수·금리·환율 한 칸 */
function quoteCell(
  label: string,
  q: Quote | undefined,
  digits: number,
): DashboardCell {
  if (!q) return emptyCell(label);
  return {
    label,
    value: num(q.close, digits),
    delta: signed(q.changeRatio, 2, "%"),
    direction: direction(q.changeRatio),
  };
}

/** 순매수 금액 한 칸 (억원) */
function flowCell(label: string, amount: number | undefined): DashboardCell {
  if (amount === undefined) return emptyCell(label);
  return {
    label,
    value: signed(amount, 0, "억"),
    delta: EMPTY,
    direction: direction(amount),
  };
}

const find = (list: Quote[] | undefined, label: string): Quote | undefined =>
  list?.find((q) => q.label === label);

/**
 * 주식 대시보드. 순서 고정 — 절대 변경 금지.
 *   S&P500 / 나스닥 / 다우
 *   ---
 *   미10년물 / 달러인덱스 / 원달러
 *   ---
 *   코스피 / 코스닥 / 외국인 / 기관 / 개인
 */
export function buildStockDashboard(
  market: MarketData | undefined,
  flows: FlowsData | undefined,
): Dashboard {
  // 코스피 기준 수급을 대표값으로 쓴다 (대시보드는 한 줄 안에서 끝낸다)
  const kospiFlow = flows?.markets.find((m) => m.market === "코스피");

  return [
    {
      cells: [
        quoteCell("S&P500", find(market?.us, "S&P500"), 2),
        quoteCell("나스닥", find(market?.us, "나스닥"), 2),
        quoteCell("다우", find(market?.us, "다우"), 2),
      ],
    },
    {
      cells: [
        quoteCell("미10년물", find(market?.macro, "미10년물"), 3),
        quoteCell("달러인덱스", find(market?.macro, "달러인덱스"), 2),
        quoteCell("원달러", find(market?.macro, "원/달러"), 2),
      ],
    },
    {
      cells: [
        quoteCell("코스피", find(market?.kr, "코스피"), 2),
        quoteCell("코스닥", find(market?.kr, "코스닥"), 2),
        flowCell("외국인", kospiFlow?.foreign),
        flowCell("기관", kospiFlow?.institution),
        flowCell("개인", kospiFlow?.individual),
      ],
    },
  ];
}

/** 주간 변동률 한 칸 */
function weeklyCell(
  label: string,
  change: WeeklyChange | undefined,
): DashboardCell {
  if (!change) return emptyCell(label);
  return {
    label,
    value: signed(change.changeRatio, 2, "%"),
    delta: EMPTY,
    direction: direction(change.changeRatio),
  };
}

/**
 * 부동산 대시보드. 순서 고정 — 절대 변경 금지.
 *   주간 매매 변동률 (서울 / 수도권 / 지방)
 *   주간 전세 변동률 (서울)
 *   ---
 *   공급물량 / 입주물량 / 미분양 / 경매 낙찰가율
 *
 * 낙찰가율은 아직 무료 소스를 확정하지 못해 "-"로 나간다.
 * 값이 없어도 자리를 비우지 않는다 — 자리가 밀리면 매일 눈으로 찾아야 한다.
 */
export function buildRealestateDashboard(
  price: PriceData | undefined,
  supply: SupplyData | undefined,
): Dashboard {
  const sale = (r: string) => price?.sale.find((x) => x.region === r);
  const lease = (r: string) => price?.lease.find((x) => x.region === r);

  return [
    {
      cells: [
        weeklyCell("매매 서울", sale("서울")),
        weeklyCell("매매 수도권", sale("수도권")),
        weeklyCell("매매 지방", sale("지방권")),
        weeklyCell("전세 서울", lease("서울")),
      ],
    },
    {
      cells: [
        countCell("공급물량", supply?.newSupplyUnits, "호"),
        countCell("입주물량", supply?.completedUnits, "호"),
        countCell("미분양", supply?.unsoldUnits, "호"),
        emptyCell("경매 낙찰가율"),
      ],
    },
  ];
}

/** 건수 한 칸. 방향 색은 넣지 않는다 — 물량은 많고 적음이 곧 좋고 나쁨이 아니다 */
function countCell(
  label: string,
  value: number | undefined,
  unit: string,
): DashboardCell {
  if (value === undefined) return emptyCell(label);
  return {
    label,
    value: `${value.toLocaleString("ko-KR")}${unit}`,
    delta: EMPTY,
    direction: "flat",
  };
}

/**
 * 청약 대시보드. 순서 고정.
 *   진행중 / 서울 / 마감임박 / 무순위
 *   ---
 *   최고 경쟁률
 */
export function buildChungyakDashboard(
  data: ApplyhomeData | undefined,
): Dashboard {
  const top = data?.competitionTop[0];
  return [
    {
      cells: [
        countCell("진행·예정", data?.notices.length, "건"),
        countCell("서울", data?.seoul.length, "건"),
        countCell("마감임박", data?.deadlineAlerts.length, "건"),
        countCell(
          "무순위",
          data?.notices.filter((n) => n.kind === "무순위/잔여").length,
          "건",
        ),
      ],
    },
    {
      cells: [
        top
          ? {
              label: "최고 경쟁률",
              value: `${top.rate.toLocaleString("ko-KR")}:1`,
              delta: EMPTY,
              direction: "flat",
            }
          : emptyCell("최고 경쟁률"),
      ],
    },
  ];
}
