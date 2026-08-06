/**
 * Gemini 요약.
 *
 * prompts/{domain}.md를 시스템 프롬프트로 쓰고 [수집데이터] 자리에 수집 결과를 주입한다.
 * 프롬프트 텍스트는 코드에 인라인하지 않는다 — 편집은 md 파일에서만.
 *
 * 역할 분담:
 *   md   = 편집 방침·톤·구성
 *   코드 = 블록 존재 보장, 금지 어휘 차단
 * 모델은 지시를 어길 수 있으므로 어겨서는 안 되는 것만 코드로 막는다.
 *
 * 무료 티어: flash 계열 기준 10 RPM / 250K TPM / 수백 RPD (프로젝트별 배정).
 * 하루 도메인당 1~2콜이라 여유가 크지만, 로컬에서 두 도메인을 연속 실행하면
 * RPM에 걸릴 수 있어 호출 간 최소 간격을 둔다.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { geminiConfig, httpConfig } from "./config.js";
import { HttpError, fetchJson } from "./http.js";
import type { DomainConfig } from "./domains.js";
import type { OpenThread } from "./threads.js";

/** md 안에서 수집 결과로 치환되는 자리 표시자 */
const PLACEHOLDER = "{{COLLECTED}}";
/** 전일 스레드 자리 표시자 (없으면 "없음"이 들어간다) */
const THREAD_PLACEHOLDER = "{{OPEN_THREAD}}";
/** 사용자 프로필 자리 표시자. 청약 프롬프트만 쓴다 */
const PROFILE_PLACEHOLDER = "{{PROFILE}}";
/** 프로필은 코드가 아닌 데이터다 */
const PROFILE_PATH = "profile.json";

/**
 * 실제 변동폭이 값하지 않는데 쓰이면 신뢰가 깨지는 과장 어휘.
 * 프롬프트에도 적지만 코드에서 한 번 더 막는다.
 */
const BANNED_WORDS = ["폭등", "폭락", "붕괴", "충격", "패닉", "초비상"] as const;

// ─── 출력 스키마 ────────────────────────────────────────────────

const briefSchema = z.object({
  /** 카톡 티저용 한 줄 요약 (60자 이내) */
  oneLiner: z.string().min(1),
  /** 카톡 티저용 헤드라인. 본문에 실제로 있는 내용만 */
  headlines: z.array(z.string().min(1)).min(1).max(5),
  /** 대시보드 아래 한 줄 코멘트. 해석이 불필요하면 빈 문자열 */
  dashboardComment: z.string(),
  /** 2) 어제 스레드 후속. 전일 스레드가 없으면 빈 문자열 */
  threadFollowup: z.string(),
  /** 3) 이슈·내러티브. 예상 대비 괴리가 큰 순서 */
  issues: z.array(z.object({ title: z.string().min(1), body: z.string() })),
  /** 오늘 일정 (KST). 대시보드 바로 다음에 온다 */
  schedule: z.string(),
  /** 앞으로 2주간 예정된 지표·실적 발표. 없으면 빈 문자열 */
  upcoming: z.string(),
  /** 5) 마무리 질문. 내일 브리핑의 2번 블록이 된다 */
  closingQuestion: z.string().min(1),
});

export type Brief = z.infer<typeof briefSchema>;

/** 검증에 두 번 실패하면 원문 텍스트를 그대로 렌더한다 */
export type SummaryResult =
  | { kind: "structured"; brief: Brief }
  | { kind: "raw"; text: string };

/** Gemini structured output용 스키마 (OpenAPI 서브셋) */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    oneLiner: { type: "STRING" },
    headlines: { type: "ARRAY", items: { type: "STRING" } },
    dashboardComment: { type: "STRING" },
    threadFollowup: { type: "STRING" },
    issues: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { title: { type: "STRING" }, body: { type: "STRING" } },
        required: ["title", "body"],
      },
    },
    schedule: { type: "STRING" },
    upcoming: { type: "STRING" },
    closingQuestion: { type: "STRING" },
  },
  required: [
    "oneLiner",
    "headlines",
    "dashboardComment",
    "threadFollowup",
    "issues",
    "schedule",
    "upcoming",
    "closingQuestion",
  ],
} as const;

const geminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({ parts: z.array(z.object({ text: z.string() })).min(1) })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .min(1),
});

// ─── RPM 보호 ──────────────────────────────────────────────────
// 모듈 수준으로 마지막 호출 시각을 기억해, 호출부가 어디든 간격이 지켜지게 한다.
let lastCallAt = 0;

async function respectRateLimit(gapMs: number): Promise<void> {
  const waitMs = lastCallAt === 0 ? 0 : gapMs - (Date.now() - lastCallAt);
  if (waitMs > 0) {
    console.log(`[summarize] RPM 보호 — ${Math.ceil(waitMs / 1000)}초 대기`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  lastCallAt = Date.now();
}

// ─── 호출 ──────────────────────────────────────────────────────

/** 무료 일일 한도 소진은 재시도해도 그날 안에 안 풀린다 — 다른 모델로 넘어가야 한다 */
function isQuotaExhausted(e: unknown): boolean {
  return e instanceof HttpError && e.status === 429;
}

async function callOneModel(
  model: string,
  systemPrompt: string,
  note: string,
): Promise<string> {
  const { GEMINI_API_KEY } = geminiConfig();
  const { GEMINI_TIMEOUT_MS } = httpConfig();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent`;

  const raw = geminiResponseSchema.parse(
    await fetchJson(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: note }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.3,
          },
        }),
      },
      `gemini:${model}`,
      GEMINI_TIMEOUT_MS,
    ),
  );

  const text = raw.candidates[0]?.content?.parts[0]?.text;
  if (text === undefined) {
    throw new Error(
      `[summarize] 응답에 텍스트 없음 (finishReason=${raw.candidates[0]?.finishReason ?? "?"})`,
    );
  }
  return text;
}

/** 앞 모델이 일일 한도에 걸리면 다음 모델로 넘어간다 */
async function callGemini(systemPrompt: string, note: string): Promise<string> {
  const { GEMINI_MODEL } = geminiConfig();
  const models = GEMINI_MODEL.split(",").map((m) => m.trim()).filter(Boolean);
  let lastError: unknown;

  for (const [i, model] of models.entries()) {
    try {
      return await callOneModel(model, systemPrompt, note);
    } catch (e) {
      lastError = e;
      if (!isQuotaExhausted(e) || i === models.length - 1) throw e;
      console.warn(`[summarize] ${model} 일일 한도 소진 — 다음 모델로 전환`);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`[summarize] 사용 가능한 모델 없음: ${GEMINI_MODEL}`);
}

/**
 * 모델이 JSON 문자열 안에 실제 줄바꿈 대신 `\n` 두 글자를 넣는 경우가 있다.
 * 그대로 두면 표가 한 줄로 뭉개져 읽을 수 없다 (2026-08-06 실측).
 * 렌더·발송 양쪽이 같은 텍스트를 쓰므로 파싱 직후 한 번만 정규화한다.
 */
function unescapeLiterals(s: string): string {
  return s
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/[ \t]+\n/g, "\n");
}

function normalizeBrief(b: Brief): Brief {
  const f = unescapeLiterals;
  return {
    oneLiner: f(b.oneLiner),
    headlines: b.headlines.map(f),
    dashboardComment: f(b.dashboardComment),
    threadFollowup: f(b.threadFollowup),
    issues: b.issues.map((i) => ({ title: f(i.title), body: f(i.body) })),
    schedule: f(b.schedule),
    upcoming: f(b.upcoming),
    closingQuestion: f(b.closingQuestion),
  };
}

/** 브리핑 전체 텍스트를 한 덩어리로 모은다 (금지 어휘 검사용) */
function allText(brief: Brief): string {
  return [
    brief.oneLiner,
    ...brief.headlines,
    brief.dashboardComment,
    brief.threadFollowup,
    ...brief.issues.flatMap((i) => [i.title, i.body]),
    brief.schedule,
    brief.upcoming,
    brief.closingQuestion,
  ].join("\n");
}

/** 코드로 강제하는 점검. 통과 못 하면 재작성시킨다. */
function checkBrief(brief: Brief): string[] {
  const problems: string[] = [];
  const text = allText(brief);

  const hit = BANNED_WORDS.filter((w) => text.includes(w));
  if (hit.length > 0) {
    problems.push(
      `금지 어휘 사용: ${hit.join(", ")}. 수치가 스스로 말하게 두고 해당 표현을 제거할 것.`,
    );
  }
  if ([...brief.oneLiner].length > 60) {
    problems.push(
      `한 줄 요약이 ${[...brief.oneLiner].length}자다. 60자 이내로 줄일 것.`,
    );
  }
  return problems;
}

/**
 * 수집 결과를 브리핑으로 요약한다.
 * 스키마·점검 실패 시 1회 재요청하고, 그래도 실패하면 원문 텍스트를 반환한다.
 */
export async function summarize(
  domain: DomainConfig,
  collected: unknown,
  openThread: OpenThread | null,
): Promise<SummaryResult> {
  const { GEMINI_CALL_GAP_MS } = httpConfig();
  const template = await readFile(domain.promptPath, "utf8");

  if (!template.includes(PLACEHOLDER)) {
    throw new Error(
      `[summarize] ${domain.promptPath}에 ${PLACEHOLDER} 자리 표시자가 없다`,
    );
  }

  // 프로필을 쓰는 프롬프트에만 주입한다 (파일이 없으면 그 사실을 넘긴다)
  let profileText = "프로필 없음";
  if (template.includes(PROFILE_PLACEHOLDER)) {
    try {
      profileText = await readFile(PROFILE_PATH, "utf8");
    } catch {
      profileText = `${PROFILE_PATH}를 읽지 못했다. 사용자 맞춤 판정을 하지 말 것.`;
    }
  }

  const systemPrompt = template
    .replace(PLACEHOLDER, JSON.stringify(collected, null, 2))
    .replace(PROFILE_PLACEHOLDER, profileText)
    .replace(
      THREAD_PLACEHOLDER,
      openThread
        ? `${openThread.askedOn}에 던진 질문: ${openThread.question}`
        : "없음 (2번 블록은 빈 문자열로 둘 것)",
    );

  let lastText = "";
  let feedback = "위 규칙과 [수집데이터]에 근거해 브리핑을 작성하라.";

  // 최초 1회 + 실패 시 재작성 1회
  for (let attempt = 1; attempt <= 2; attempt++) {
    await respectRateLimit(GEMINI_CALL_GAP_MS);
    lastText = await callGemini(systemPrompt, feedback);

    let brief: Brief;
    try {
      brief = normalizeBrief(briefSchema.parse(JSON.parse(lastText)));
    } catch (e) {
      console.warn(
        `[summarize] 스키마 검증 실패 (${attempt}/2): ${
          e instanceof Error ? e.message.slice(0, 200) : String(e)
        }`,
      );
      feedback =
        "직전 응답이 요구 스키마를 만족하지 못했다. 스키마를 정확히 지켜 다시 작성하라.";
      continue;
    }

    const problems = checkBrief(brief);
    if (problems.length === 0) {
      return { kind: "structured", brief };
    }
    console.warn(`[summarize] 자체 점검 실패 (${attempt}/2): ${problems.join(" ")}`);
    feedback = `직전 응답에 다음 문제가 있다. 고쳐서 다시 작성하라:\n- ${problems.join("\n- ")}`;
  }

  console.error("[summarize] 2회 실패 — 원문 텍스트로 렌더한다");
  return { kind: "raw", text: lastText };
}
