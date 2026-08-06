/**
 * 환경변수 로딩·검증의 단일 진입점.
 *
 * 설계: 그룹 단위 검증.
 * 전체 키를 한 번에 강제하면 로컬에서 수집기만 테스트할 때도(3단계)
 * 카카오·Gemini 키까지 요구하게 된다. 그래서 각 모듈은 자기가 쓰는
 * 그룹만 가져오고, 그 그룹의 키가 누락되면 "부팅 시점"(= 해당 그룹의
 * 최초 접근 시점)에 어떤 키가 왜 필요한지 명시한 에러로 죽는다.
 * 근거: DECISIONS.md #6
 */
import { z } from "zod";

/** 누락 키를 사람이 읽을 수 있는 에러로 변환해 zod 파싱을 수행한다. */
function loadGroup<T extends z.ZodRawShape>(
  groupName: string,
  shape: T,
): z.infer<z.ZodObject<T>> {
  const schema = z.object(shape);
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `[config] ${groupName} 환경변수 검증 실패. .env.example을 참고해 설정할 것:\n${missing}`,
    );
  }
  return result.data;
}

/** 빈 문자열도 누락으로 취급한다 (Actions에서 빈 secret이 주입되는 사고 방지). */
const requiredString = (desc: string) =>
  z.string({ required_error: `누락됨 — ${desc}` }).min(1, `빈 값 — ${desc}`);

// ─── 그룹별 설정 ───────────────────────────────────────────────

/** 카카오 앱 자격증명 (notify.ts, auth/kakao.ts, auth/issue-token.ts) */
export const kakaoConfig = () =>
  loadGroup("kakao", {
    KAKAO_REST_API_KEY: requiredString("카카오 앱 REST API 키"),
    KAKAO_CLIENT_SECRET: requiredString(
      "카카오 앱 보안 > Client Secret (활성화 상태 기준)",
    ),
    /** 최초 발급 시 콘솔에 등록한 Redirect URI와 일치해야 한다 */
    KAKAO_AUTH_REDIRECT_URI: z
      .string()
      .url()
      .default("http://localhost:3000/callback"),
  });

/**
 * refresh token은 앱 자격증명과 분리 — 최초 발급 스크립트(issue-token.ts)는
 * 이 값이 없는 상태에서 돌아야 하기 때문이다.
 */
export const kakaoTokenConfig = () =>
  loadGroup("kakaoToken", {
    KAKAO_REFRESH_TOKEN: requiredString(
      "최초 1회 `npm run auth:issue`로 발급. 이후 회전은 auth/kakao.ts가 담당",
    ),
  });

/** Gemini 요약 (summarize.ts) */
export const geminiConfig = () =>
  loadGroup("gemini", {
    GEMINI_API_KEY: requiredString("Google AI Studio API 키 (무료 티어)"),
    GEMINI_MODEL: requiredString(
      "모델명 (예: gemini-2.5-flash). 코드에 하드코딩하지 않고 env로 주입",
    ),
  });

/** 네이버 검색 API — 뉴스 (collectors/news.ts) */
export const naverConfig = () =>
  loadGroup("naver", {
    NAVER_CLIENT_ID: requiredString("developers.naver.com 애플리케이션 Client ID"),
    NAVER_CLIENT_SECRET: requiredString("동 애플리케이션 Client Secret"),
  });

/** Reddit OAuth — script 앱 (collectors/community.ts). 비인증 .json은 2026-05부로 차단 */
export const redditConfig = () =>
  loadGroup("reddit", {
    REDDIT_CLIENT_ID: requiredString("Reddit script 앱 client id"),
    REDDIT_CLIENT_SECRET: requiredString("Reddit script 앱 secret"),
  });

/** 공공데이터포털 (collectors/realestate/chungyak.ts, supply.ts) */
export const dataGoKrConfig = () =>
  loadGroup("dataGoKr", {
    DATA_GO_KR_SERVICE_KEY: requiredString("공공데이터포털 일반 인증키(디코딩)"),
  });

/** 한국부동산원 R-ONE (collectors/realestate/price.ts) */
export const rOneConfig = () =>
  loadGroup("rOne", {
    RONE_API_KEY: requiredString("R-ONE 오픈API 인증키"),
  });

/** GitHub Secrets 회전 (auth/kakao.ts에서 새 refresh token 저장 시) */
export const githubConfig = () =>
  loadGroup("github", {
    GH_SECRETS_PAT: requiredString(
      "fine-grained PAT, 대상 레포 Secrets Read/Write 권한. 기본 GITHUB_TOKEN으로는 불가",
    ),
    GITHUB_REPOSITORY: requiredString(
      "owner/repo 형식. Actions에서는 자동 주입됨",
    ),
  });

/** 발행 링크 (render.ts, notify.ts) */
export const siteConfig = () =>
  loadGroup("site", {
    PAGES_BASE_URL: requiredString(
      "GitHub Pages 베이스 URL (예: https://<owner>.github.io/<repo>)",
    ),
  });

// ─── 공통 상수 (env로 덮어쓰기 가능) ────────────────────────────

/** 외부 호출 공통 정책. 하드코딩 대신 여기서만 정의하고 env로 조정 가능하다. */
export const httpConfig = () =>
  loadGroup("http", {
    HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    HTTP_RETRY_MAX: z.coerce.number().int().min(0).default(3),
    /** 지수 백오프 기본 간격. n회차 대기 = BASE * 2^n */
    HTTP_RETRY_BASE_MS: z.coerce.number().int().positive().default(1_000),
    /** Gemini 무료 티어 RPM 보호용 — 주식/부동산 호출 사이 최소 간격 */
    GEMINI_CALL_GAP_MS: z.coerce.number().int().min(0).default(30_000),
    /** LLM 생성은 일반 API보다 오래 걸린다 (긴 수집데이터일수록 증가) */
    GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    /**
     * 카톡 분할 발송 통수. 템플릿 1통이 200자라 4통이면 최대 800자다.
     * 내용이 모자라면 그만큼만 보낸다 — 800자를 채우려고 늘려 쓰지 않는다.
     * 카카오 쿼터는 발신자/수신자 pair당 일 20건이므로
     * 주식 4 + 부동산 4 = 8건, 상한의 40%다. 재실행 여유를 남긴 값이다.
     */
    KAKAO_MAX_MESSAGES: z.coerce.number().int().min(1).max(8).default(4),
  });

// ─── 검증 전용 CLI ─────────────────────────────────────────────
// `npm run config:check` — 현재 셸에서 어떤 그룹이 충족되는지 출력한다.
// 파이프라인 실행과 무관한 점검용이므로 여기서는 죽지 않고 표로 보여준다.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
  const groups: Record<string, () => unknown> = {
    kakao: kakaoConfig,
    kakaoToken: kakaoTokenConfig,
    gemini: geminiConfig,
    naver: naverConfig,
    reddit: redditConfig,
    dataGoKr: dataGoKrConfig,
    rOne: rOneConfig,
    github: githubConfig,
    site: siteConfig,
    http: httpConfig,
  };
  for (const [name, load] of Object.entries(groups)) {
    try {
      load();
      console.log(`✅ ${name}`);
    } catch (e) {
      const first = e instanceof Error ? e.message.split("\n")[1] ?? "" : "";
      console.log(`❌ ${name}${first ? ` —${first.replace(/^ +-/, "")}` : ""}`);
    }
  }
}
