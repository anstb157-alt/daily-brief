/**
 * 외부 호출 공통 래퍼. 타임아웃 + 지수 백오프 재시도.
 *
 * 재시도 대상은 "다시 하면 될 수도 있는" 실패로 한정한다.
 * 4xx(429 제외)는 요청 자체가 틀린 것이므로 재시도해도 같은 결과다.
 */
import { httpConfig } from "./config.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string,
  ) {
    super(`HTTP ${status} — ${url} :: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

/** 재시도 가치가 있는 상태 코드인가 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * fetch + 타임아웃 + 재시도. 최종 실패 시 throw 한다.
 * 수집기는 이걸 try/catch로 감싸 `{ ok: false, reason }`으로 바꿔야 한다.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  label = url,
): Promise<Response> {
  const { HTTP_TIMEOUT_MS, HTTP_RETRY_MAX, HTTP_RETRY_BASE_MS } = httpConfig();
  let lastError: unknown;

  // 최초 시도 1회 + 재시도 HTTP_RETRY_MAX회
  for (let attempt = 0; attempt <= HTTP_RETRY_MAX; attempt++) {
    if (attempt > 0) {
      const waitMs = HTTP_RETRY_BASE_MS * 2 ** (attempt - 1);
      console.warn(
        `[http] ${label} 재시도 ${attempt}/${HTTP_RETRY_MAX} — ${waitMs}ms 대기`,
      );
      await sleep(waitMs);
    }

    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (res.ok) return res;

      const body = await res.text();
      const err = new HttpError(res.status, body, label);
      if (!isRetryableStatus(res.status)) throw err; // 재시도 무의미 — 즉시 중단
      lastError = err;
    } catch (e) {
      // 재시도 불가로 판정한 HttpError는 그대로 올린다
      if (e instanceof HttpError && !isRetryableStatus(e.status)) throw e;
      lastError = e; // 네트워크 오류·타임아웃은 재시도 대상
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`[http] ${label} 실패: ${String(lastError)}`);
}

/** JSON 응답을 받아 unknown으로 반환한다. 스키마 검증은 호출부에서 zod로. */
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  label = url,
): Promise<unknown> {
  const res = await fetchWithRetry(url, init, label);
  return res.json();
}
