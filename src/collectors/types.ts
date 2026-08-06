/**
 * 수집기 공통 인터페이스.
 *
 * 개별 수집기의 실패가 파이프라인 전체를 멈추면 안 된다.
 * 그래서 예외를 던지는 대신 실패를 값으로 표현한다.
 * 실패한 소스는 요약 단계에 "데이터 없음"으로 넘어가고,
 * 브리핑 하단에 어떤 소스가 실패했는지 표시된다.
 */

export type CollectResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

export interface Collector<T> {
  /** 로그·실패 표시에 쓰는 식별자 */
  readonly name: string;
  collect(): Promise<CollectResult<T>>;
}

/** 예외를 CollectResult로 변환한다. 수집기 본문을 감쌀 때 쓴다. */
export async function toResult<T>(
  fn: () => Promise<T>,
): Promise<CollectResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
