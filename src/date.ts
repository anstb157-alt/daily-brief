/**
 * KST 기준 날짜 유틸.
 *
 * 파이프라인은 GitHub Actions(UTC)에서 돌지만 브리핑의 "오늘"은 항상 KST다.
 * 서버 로컬 타임존에 의존하지 않도록 Intl로 명시 변환한다.
 */

export const KST = "Asia/Seoul";

/** YYYY-MM-DD (KST 기준) */
export function kstDateString(at: Date = new Date()): string {
  // en-CA 로케일이 YYYY-MM-DD 형식을 준다
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** M/D (카톡 헤딩용) */
export function kstShortDate(at: Date = new Date()): string {
  const [, m, d] = kstDateString(at).split("-") as [string, string, string];
  return `${Number(m)}/${Number(d)}`;
}

/**
 * 직전 미국 거래일 (YYYY-MM-DD, 미 동부 기준).
 * KST 아침에 실행하면 미국장은 이미 마감했고, 그 마감일이 브리핑 대상이다.
 * 주말은 금요일로 당긴다. 공휴일은 보정하지 않는다 — 그날은 실적 0건으로 나온다.
 */
export function lastUsTradingDate(at: Date = new Date()): string {
  const et = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  // ET 기준 오늘부터 거슬러 올라가며 첫 평일을 찾는다
  for (let back = 0; back < 5; back++) {
    const d = new Date(at.getTime() - back * 86_400_000);
    const parts = et.formatToParts(d);
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
    if (weekday !== "Sat" && weekday !== "Sun") {
      const y = parts.find((p) => p.type === "year")?.value ?? "";
      const m = parts.find((p) => p.type === "month")?.value ?? "";
      const dd = parts.find((p) => p.type === "day")?.value ?? "";
      return `${y}-${m}-${dd}`;
    }
  }
  throw new Error("[date] 직전 미국 거래일을 찾지 못했다");
}

/**
 * 직전 국내 거래일 후보를 최근 순으로 돌려준다 (YYYYMMDD).
 * 08:40 실행 시점의 "전일 종가"가 대상이므로 오늘은 제외하고 하루 전부터 센다.
 * 공휴일 달력이 없으므로 주말만 걸러내고, 데이터가 없으면 호출부가 다음 후보로 넘어간다.
 */
export function recentKrTradingDates(count = 5, at: Date = new Date()): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const out: string[] = [];
  for (let back = 1; back <= count + 4 && out.length < count; back++) {
    const parts = fmt.formatToParts(new Date(at.getTime() - back * 86_400_000));
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
    if (weekday === "Sat" || weekday === "Sun") continue;
    const y = parts.find((p) => p.type === "year")?.value ?? "";
    const m = parts.find((p) => p.type === "month")?.value ?? "";
    const d = parts.find((p) => p.type === "day")?.value ?? "";
    out.push(`${y}${m}${d}`);
  }
  return out;
}

/** HH:mm (KST 기준) — 일정 표시용 */
export function kstTimeString(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: KST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}
