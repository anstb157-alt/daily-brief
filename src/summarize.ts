/**
 * Gemini 요약.
 *
 * prompts/{domain}.md를 시스템 프롬프트로 쓰고 [수집데이터] 자리에 수집 결과를 주입한다.
 * 프롬프트 텍스트는 코드에 인라인하지 않는다 — 편집은 md 파일에서만.
 *
 * 구조 보장은 코드가, 편집 방침은 md가 담당한다.
 * md는 섹션 구성을 자유롭게 바꿀 수 있고, 코드는 카톡 티저에 반드시 필요한
 * 한 줄 요약·헤드라인만 스키마로 강제한다.
 *
 * 무료 티어: gemini-2.5-flash 기준 10 RPM / 250K TPM / 250~500 RPD (프로젝트별 배정).
 * 하루 도메인당 1~2콜이라 여유가 크지만, 로컬에서 두 도메인을 연속 실행하면
 * RPM에 걸릴 수 있어 호출 간 최소 간격을 둔다.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { geminiConfig, httpConfig } from "./config.js";
import { fetchJson } from "./http.js";
import type { DomainConfig } from "./domains.js";

/** md 안에서 수집 결과로 치환되는 자리 표시자 */
const PLACEHOLDER = "{{COLLECTED}}";

// ─── 출력 스키마 ────────────────────────────────────────────────

const briefSchema = z.object({
  /** 60자 이내 한 줄 요약 (카톡 티저용) */
  oneLiner: z.string().min(1),
  /** 카톡 티저에 들어갈 헤드라인 */
  headlines: z.array(z.string().min(1)).min(1).max(5),
  /** 본문 섹션. 구성은 프롬프트가 정한다 */
  sections: z
    .array(z.object({ title: z.string().min(1), body: z.string() }))
    .min(1),
});

export type Brief = z.infer<typeof briefSchema>;

/** 스키마 검증에 두 번 실패하면 원문 텍스트를 그대로 렌더한다 */
export type SummaryResult =
  | { kind: "structured"; brief: Brief }
  | { kind: "raw"; text: string };

/** Gemini structured output용 스키마 (OpenAPI 서브셋) */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    oneLiner: { type: "STRING" },
    headlines: { type: "ARRAY", items: { type: "STRING" } },
    sections: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { title: { type: "STRING" }, body: { type: "STRING" } },
        required: ["title", "body"],
      },
    },
  },
  required: ["oneLiner", "headlines", "sections"],
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

async function callGemini(systemPrompt: string, note: string): Promise<string> {
  const { GEMINI_API_KEY, GEMINI_MODEL } = geminiConfig();
  const { GEMINI_TIMEOUT_MS } = httpConfig();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_MODEL)}:generateContent`;

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
      `gemini:${GEMINI_MODEL}`,
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

function parseBrief(text: string): Brief {
  return briefSchema.parse(JSON.parse(text));
}

/**
 * 수집 결과를 브리핑으로 요약한다.
 * 스키마 검증 실패 시 1회 재요청하고, 그래도 실패하면 원문 텍스트를 반환한다.
 */
export async function summarize(
  domain: DomainConfig,
  collected: unknown,
): Promise<SummaryResult> {
  const { GEMINI_CALL_GAP_MS } = httpConfig();
  const template = await readFile(domain.promptPath, "utf8");

  if (!template.includes(PLACEHOLDER)) {
    throw new Error(
      `[summarize] ${domain.promptPath}에 ${PLACEHOLDER} 자리 표시자가 없다`,
    );
  }
  const systemPrompt = template.replace(
    PLACEHOLDER,
    JSON.stringify(collected, null, 2),
  );

  let lastText = "";
  // 최초 1회 + 검증 실패 시 재요청 1회
  for (let attempt = 1; attempt <= 2; attempt++) {
    await respectRateLimit(GEMINI_CALL_GAP_MS);
    lastText = await callGemini(
      systemPrompt,
      attempt === 1
        ? "위 규칙과 [수집데이터]에 근거해 브리핑을 작성하라."
        : "직전 응답이 요구 스키마를 만족하지 못했다. 스키마를 정확히 지켜 다시 작성하라.",
    );

    try {
      return { kind: "structured", brief: parseBrief(lastText) };
    } catch (e) {
      console.warn(
        `[summarize] 스키마 검증 실패 (${attempt}/2): ${
          e instanceof Error ? e.message.slice(0, 200) : String(e)
        }`,
      );
    }
  }

  console.error("[summarize] 스키마 검증 2회 실패 — 원문 텍스트로 렌더한다");
  return { kind: "raw", text: lastText };
}
