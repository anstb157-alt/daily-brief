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

/** HH:mm (KST 기준) — 일정 표시용 */
export function kstTimeString(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: KST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}
