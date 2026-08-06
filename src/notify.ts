/**
 * 카카오톡 "나에게 보내기" 발송.
 *
 * 기본 텍스트 템플릿의 text는 200자 제한이라 브리핑 전문이 한 통에 안 들어간다.
 * 그래서 여러 통으로 쪼개 순서대로 보낸다 (DECISIONS #15).
 * 첫 통은 요약(한 줄 + 헤드라인), 이후는 프롬프트가 정한 블록 순서를 따른다.
 * 링크는 마지막 통에만 넣고 어떤 경우에도 자르지 않는다.
 *
 * 쿼터: "나에게 보내기"는 발신자/수신자 pair당 일 20건이 실질 상한이다 (DECISIONS #2-1).
 * 주식 4통 + 부동산 4통 = 8건으로 상한의 40%다. 통수를 더 늘리면 재실행 여유가 사라진다.
 */
import { z } from "zod";
import type { Dashboard } from "./dashboard.js";
import { fetchJson } from "./http.js";
import type { Brief } from "./summarize.js";

const SEND_ENDPOINT = "https://kapi.kakao.com/v2/api/talk/memo/default/send";

/** 카카오 기본 텍스트 템플릿 제한 */
export const MAX_TEXT_LENGTH = 200;
/** "(1/4)\n" 같은 순번 표기가 차지하는 최대 길이 */
const MARKER_RESERVE = 8;
/** 연속 발송 시 순서가 뒤집히지 않도록 두는 간격 */
const SEND_GAP_MS = 400;

const sendResponseSchema = z.object({ result_code: z.number() });

export interface BriefPayload {
  /** "📈 8/6 증시" */
  heading: string;
  /** 구조화 실패 시 null — 그때는 요약 문구만 보낸다 */
  brief: Brief | null;
  /** 구조화 실패 시 대체 문구 */
  fallbackSummary: string;
  dashboard: Dashboard;
  link: string;
}

/** 이모지·한글을 코드포인트 단위로 세어 카카오 기준 길이에 맞춘다 */
export function textLength(s: string): number {
  return [...s].length;
}

function cut(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

// ─── 본문 조립 ─────────────────────────────────────────────────

/** 대시보드를 한 줄씩 문자열로. 톤 없이 숫자와 부호만. */
function dashboardLines(dashboard: Dashboard): string[] {
  return dashboard.flatMap((group) =>
    group.cells.map((c) =>
      c.delta === "-" ? `${c.label} ${c.value}` : `${c.label} ${c.value} ${c.delta}`,
    ),
  );
}

/**
 * 발송할 줄 목록을 프롬프트 블록 순서대로 만든다.
 * 1) 요약  2) 대시보드  3) 어제 스레드  4) 이슈  5) 오늘 일정  6) 내일 질문
 */
function buildLines(p: BriefPayload): string[] {
  const lines: string[] = [];

  if (!p.brief) {
    lines.push(p.fallbackSummary);
    return lines;
  }
  const b = p.brief;

  lines.push(b.oneLiner);
  lines.push(...b.headlines.map((h) => `· ${h}`));

  lines.push("", "[지표]");
  lines.push(...dashboardLines(p.dashboard));
  if (b.dashboardComment.trim()) lines.push(b.dashboardComment.trim());

  if (b.threadFollowup.trim()) {
    lines.push("", "[어제 스레드]", b.threadFollowup.trim());
  }

  if (b.issues.length > 0) {
    lines.push("", "[이슈]");
    for (const i of b.issues) {
      lines.push(`◆ ${i.title}`);
      lines.push(...i.body.split("\n").map((l) => l.trim()).filter(Boolean));
    }
  }

  if (b.schedule.trim()) {
    lines.push("", "[오늘 일정]");
    lines.push(...b.schedule.split("\n").map((l) => l.trim()).filter(Boolean));
  }

  lines.push("", "[내일 질문]", b.closingQuestion.trim());

  return lines;
}

/**
 * 남은 자리에 넣을 수 있는 만큼만 잘라 [앞, 뒤]로 돌려준다.
 * 문장 끝 → 공백 순으로 자를 곳을 찾고, 없으면 글자 단위로 자른다.
 * 이렇게 이어붙이지 않으면 긴 문장이 통째로 다음 통에 밀려 빈자리가 생긴다.
 */
function splitAt(line: string, room: number): [string, string] {
  const chars = [...line];
  if (chars.length <= room) return [line, ""];

  const head = chars.slice(0, room).join("");
  // 문장 끝(. ! ? 다. 음. 함.)에서 자르는 게 가장 자연스럽다
  const sentence = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
  );
  const cutAt =
    sentence > room * 0.4
      ? sentence + 1
      : head.lastIndexOf(" ") > room * 0.4
        ? head.lastIndexOf(" ")
        : room;

  return [
    chars.slice(0, cutAt).join("").trimEnd(),
    chars.slice(cutAt).join("").trimStart(),
  ];
}

/** 이어붙일 가치가 있는 최소 잔여 공간. 이보다 적게 남으면 그냥 다음 통으로 넘긴다 */
const MIN_FILL = 40;

/**
 * 줄 목록을 200자 이내 메시지 여러 통으로 묶는다.
 * - 통수가 maxMessages를 넘으면 뒤를 잘라낸다 (앞쪽이 중요도가 높다)
 * - 링크는 마지막 통에만, 절대 자르지 않는다
 */
/** `[이슈]` 같은 구획 표시. 내용 없이 통 끝에 홀로 남으면 안 된다 */
function isSectionHeader(line: string): boolean {
  return /^\[.+\]$/.test(line);
}

export function buildMessages(p: BriefPayload, maxMessages: number): string[] {
  const linkLine = `→ ${p.link}`;
  const linkCost = textLength(linkLine) + 1; // 앞 개행 포함

  // 머리글(제목 + 순번)이 차지할 최대 길이를 먼저 빼둔다.
  // 1통 머리글이 가장 길므로 그걸 기준으로 잡아야 어떤 통도 200자를 넘지 않는다.
  const headerReserve =
    textLength(p.heading) + MARKER_RESERVE + 1; // +1 = 머리글 뒤 개행
  const budget = MAX_TEXT_LENGTH - headerReserve;

  const chunks: string[][] = [];
  let current: string[] = [];
  let used = 0;

  const flush = () => {
    // 구획 표시만 남은 채로 끝나면 다음 통으로 넘긴다
    const carry: string[] = [];
    while (current.length > 0 && isSectionHeader(current[current.length - 1] ?? "")) {
      carry.unshift(current.pop() as string);
    }
    if (current.length > 0) chunks.push(current);
    current = carry;
    used = carry.reduce((a, l) => a + textLength(l) + 1, 0);
  };

  const push = (line: string) => {
    current.push(line);
    used += textLength(line) + (current.length > 1 ? 1 : 0);
  };

  for (const rawLine of buildLines(p)) {
    let line = rawLine;
    while (line.length > 0 || rawLine === "") {
      const gap = current.length > 0 ? 1 : 0;
      const room = budget - used - gap;

      if (textLength(line) <= room) {
        // 빈 줄로 시작하는 통은 만들지 않는다
        if (!(current.length === 0 && line === "")) push(line);
        break;
      }
      // 구획 표시는 쪼개지 않는다 — 통째로 다음 통으로 넘긴다
      if (room >= MIN_FILL && !isSectionHeader(line)) {
        const [head, tail] = splitAt(line, room);
        if (head.length > 0) push(head);
        line = tail;
      }
      flush();
      if (current.length === 0 && used === 0 && line.length === 0) break;
    }
  }
  if (current.length > 0 && current.some((l) => !isSectionHeader(l))) {
    chunks.push(current);
  }

  const kept = chunks.slice(0, maxMessages);
  if (kept.length === 0) kept.push([p.fallbackSummary]);

  // 마지막 통에 링크를 넣는다. 링크는 절대 자르지 않으므로 자리가 없으면 줄을 덜어낸다.
  const last = kept[kept.length - 1];
  if (last) {
    while (
      last.length > 0 &&
      textLength(last.join("\n")) + linkCost > budget
    ) {
      last.pop();
    }
    last.push(linkLine);
  }

  const total = kept.length;
  return kept.map((chunkLines, i) => {
    const marker = total > 1 ? ` (${i + 1}/${total})` : "";
    const head = i === 0 ? `${p.heading}${marker}` : `${p.heading.slice(0, 2)}${marker}`;
    // 예약을 정확히 계산했으므로 여기서 잘릴 일은 없다 (방어용)
    return cut([head, ...chunkLines].join("\n"), MAX_TEXT_LENGTH);
  });
}

// ─── 발송 ──────────────────────────────────────────────────────

/**
 * @param withButton 마지막 통에만 버튼을 단다. 중간 통까지 버튼이 붙으면 화면이 지저분해진다.
 *
 * 주의: 텍스트 템플릿에서 `link`는 필수다.
 *       빼면 400 `failed to parse parameter. name=template_object`가 난다 (2026-08-06 실측).
 */
async function sendOne(
  accessToken: string,
  text: string,
  link: string,
  withButton: boolean,
): Promise<void> {
  const templateObject = {
    object_type: "text",
    text,
    link: { web_url: link, mobile_web_url: link },
    ...(withButton ? { button_title: "브리핑 전문" } : {}),
  };
  const res = sendResponseSchema.parse(
    await fetchJson(
      SEND_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
        body: new URLSearchParams({
          template_object: JSON.stringify(templateObject),
        }).toString(),
      },
      "kakao:memo/default/send",
    ),
  );
  if (res.result_code !== 0) {
    throw new Error(`[notify] 발송 실패 result_code=${res.result_code}`);
  }
}

/**
 * 브리핑을 여러 통으로 나눠 순서대로 보낸다.
 * 중간 통이 실패하면 즉시 중단한다 — 조각난 브리핑을 계속 밀어넣지 않는다.
 */
export async function sendBrief(
  accessToken: string,
  payload: BriefPayload,
  maxMessages: number,
): Promise<void> {
  const messages = buildMessages(payload, maxMessages);
  console.log(
    `[notify] ${messages.length}통 발송 예정 — 길이 ${messages.map(textLength).join(", ")}자`,
  );

  for (const [i, text] of messages.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    await sendOne(accessToken, text, payload.link, i === messages.length - 1);
    console.log(`[notify] ${i + 1}/${messages.length} 발송 성공 (${textLength(text)}자)`);
  }
}
