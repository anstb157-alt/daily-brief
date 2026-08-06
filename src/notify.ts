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
/** " (1/4)" 같은 순번 표기가 차지하는 길이 */
const MARKER_RESERVE = 6;
/** 2통 이후 머리글은 이모지뿐이다 */
const SHORT_HEAD_LEN = 2;
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

/**
 * 카톡용 짧은 라벨. 지표 블록이 한 통을 넘기면 (1/4)(2/4)로 끊겨 읽히므로
 * 라벨을 줄이고 천단위 콤마를 빼서 한 통 안에 넣는다. HTML은 원래 라벨을 쓴다.
 */
const SHORT_LABEL: Record<string, string> = {
  "S&P500": "S&P",
  미10년물: "10Y",
  달러인덱스: "DXY",
  원달러: "환율",
  외국인: "외인",
};

/**
 * 대시보드를 그룹당 한 줄로 압축한다. 톤 없이 숫자와 부호만.
 * 그룹(구분선) 경계는 유지해 눈으로 묶음이 보이게 한다.
 */
function dashboardLines(dashboard: Dashboard): string[] {
  return dashboard.map((group) =>
    group.cells
      .map((c) => {
        const label = SHORT_LABEL[c.label] ?? c.label;
        const value = c.value.replace(/,/g, "");
        return c.delta === "-" ? `${label} ${value}` : `${label} ${value} ${c.delta}`;
      })
      .join(" "),
  );
}

/**
 * 발송 블록. atomic이면 통 경계에서 쪼개지 않는다 —
 * 지표가 (1/4)(2/4)로 끊기면 표로 읽히지 않는다.
 */
interface Block {
  lines: string[];
  atomic: boolean;
}

const splitText = (s: string): string[] =>
  s.split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * 블록 순서: 요약 → 지표 → 오늘 일정 → 어제 스레드 → 이슈 → 내일 질문.
 * 링크는 본문에 넣지 않는다 — 마지막 통의 버튼이 대신한다.
 */
function buildBlocks(p: BriefPayload): Block[] {
  if (!p.brief) return [{ lines: [p.fallbackSummary], atomic: false }];
  const b = p.brief;
  const blocks: Block[] = [];

  blocks.push({
    lines: [b.oneLiner, ...b.headlines.map((h) => `· ${h}`)],
    atomic: false,
  });

  // 지표는 표로 읽혀야 하므로 통 경계에서 쪼개지 않는다.
  // 코멘트는 서술이라 같이 묶지 않는다 — 묶으면 블록이 커져 한 통을 넘긴다.
  blocks.push({ lines: dashboardLines(p.dashboard), atomic: true });
  if (b.dashboardComment.trim()) {
    blocks.push({ lines: [b.dashboardComment.trim()], atomic: false });
  }

  if (b.schedule.trim()) {
    blocks.push({ lines: ["[오늘 일정]", ...splitText(b.schedule)], atomic: false });
  }
  if (b.threadFollowup.trim()) {
    blocks.push({
      lines: ["[어제 스레드]", ...splitText(b.threadFollowup)],
      atomic: false,
    });
  }
  if (b.issues.length > 0) {
    blocks.push({
      lines: [
        "[이슈]",
        ...b.issues.flatMap((i) => [`◆ ${i.title}`, ...splitText(i.body)]),
      ],
      atomic: false,
    });
  }
  blocks.push({
    lines: ["[내일 질문]", ...splitText(b.closingQuestion)],
    atomic: false,
  });

  return blocks;
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

/** `[이슈]` 같은 구획 표시. 내용 없이 통 끝에 홀로 남으면 안 된다 */
function isSectionHeader(line: string): boolean {
  return /^\[.+\]$/.test(line);
}

/**
 * 블록을 200자 이내 메시지 여러 통으로 묶는다.
 * - atomic 블록(지표)은 통 경계에서 쪼개지 않는다
 * - 통수가 maxMessages를 넘으면 뒤를 잘라낸다 (앞쪽이 중요도가 높다)
 * - 링크는 본문에 넣지 않는다. 마지막 통의 버튼이 대신한다.
 */
export function buildMessages(p: BriefPayload, maxMessages: number): string[] {
  // 2통부터는 머리글이 이모지 + 순번뿐이라 훨씬 짧다.
  // 이 짧은 머리글 기준으로 채우고, 1통만 나중에 길이를 맞춘다.
  // 최대치로 잡으면 지표 한 줄이 안 들어가 통이 쪼개진다.
  const budget = MAX_TEXT_LENGTH - SHORT_HEAD_LEN - MARKER_RESERVE - 1;

  const chunks: string[][] = [];
  let current: string[] = [];
  let used = 0;

  /** 줄 배열이 차지하는 길이 (개행 포함) */
  const size = (lines: string[]) =>
    lines.reduce((a, l) => a + textLength(l), 0) + Math.max(0, lines.length - 1);

  const flush = () => {
    // 구획 표시만 남은 채로 끝나면 다음 통으로 넘긴다
    const carry: string[] = [];
    while (current.length > 0 && isSectionHeader(current[current.length - 1] ?? "")) {
      carry.unshift(current.pop() as string);
    }
    if (current.length > 0) chunks.push(current);
    current = carry;
    used = size(carry);
  };

  const push = (line: string) => {
    used += textLength(line) + (current.length > 0 ? 1 : 0);
    current.push(line);
  };

  for (const block of buildBlocks(p)) {
    // 쪼개면 안 되는 블록은 통째로 들어갈 자리가 없으면 새 통에서 시작한다
    if (block.atomic) {
      const need = size(block.lines) + (current.length > 0 ? 1 : 0);
      if (used + need > budget && current.length > 0) flush();
      block.lines.forEach(push);
      continue;
    }

    for (const rawLine of block.lines) {
      let line = rawLine;
      // 한 줄이 남은 자리를 넘으면 문장 끝에서 쪼개 이어붙인다
      for (;;) {
        const room = budget - used - (current.length > 0 ? 1 : 0);
        if (textLength(line) <= room) {
          push(line);
          break;
        }
        if (room >= MIN_FILL && !isSectionHeader(line)) {
          const [head, tail] = splitAt(line, room);
          if (head.length > 0) push(head);
          line = tail;
        }
        flush();
        if (line.length === 0) break;
      }
    }
  }
  if (current.length > 0 && current.some((l) => !isSectionHeader(l))) {
    chunks.push(current);
  }

  const kept = chunks.slice(0, maxMessages);
  if (kept.length === 0) kept.push([p.fallbackSummary]);

  // 1통은 머리글이 길어 예산을 넘을 수 있다. 넘치는 줄은 2통 앞으로 넘긴다.
  const firstBudget =
    MAX_TEXT_LENGTH - textLength(p.heading) - MARKER_RESERVE - 1;
  const first = kept[0];
  if (first) {
    while (first.length > 1 && size(first) > firstBudget) {
      const moved = first.pop() as string;
      if (kept.length < maxMessages && kept.length === 1) kept.push([]);
      kept[1]?.unshift(moved);
    }
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
