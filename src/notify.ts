/**
 * 카카오톡 "나에게 보내기" 발송.
 *
 * 기본 텍스트 템플릿의 text는 200자 제한이다.
 * 초과 시 (1) 헤드라인을 뒤에서부터 잘라내고 (2) 그래도 넘으면 한 줄 요약을 축약한다.
 * 링크는 어떤 경우에도 자르지 않는다.
 *
 * 쿼터: "나에게 보내기"는 발신자당 일 100건. 하루 2통(주식·부동산)은 여유 있다.
 */
import { z } from "zod";
import { fetchJson } from "./http.js";

const SEND_ENDPOINT = "https://kapi.kakao.com/v2/api/talk/memo/default/send";

/** 카카오 기본 텍스트 템플릿 제한 */
export const MAX_TEXT_LENGTH = 200;
/** 요약 축약 시 말줄임 표기 */
const ELLIPSIS = "…";

const sendResponseSchema = z.object({ result_code: z.number() });

export interface BriefMessage {
  /** 도메인 아이콘 + 날짜 + 라벨. 예: "📈 8/6 증시" */
  heading: string;
  /** 한 줄 요약 */
  summary: string;
  /** 헤드라인 (뒤에서부터 잘릴 수 있음) */
  headlines: string[];
  /** Pages 링크. 절대 잘리지 않는다 */
  link: string;
}

/** 이모지·한글을 코드포인트 단위로 세어 카카오 기준 길이에 맞춘다. */
export function textLength(s: string): number {
  return [...s].length;
}

function compose(
  heading: string,
  summary: string,
  headlines: string[],
  link: string,
): string {
  return [
    heading,
    summary,
    ...headlines.map((h) => `· ${h}`),
    `→ ${link}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * 200자에 맞춘 본문을 만든다.
 * 반환값의 dropped/truncated는 호출부가 로그로 남기기 위한 것이다.
 */
export function buildText(msg: BriefMessage): {
  text: string;
  length: number;
  droppedHeadlines: number;
  summaryTruncated: boolean;
} {
  const headlines = [...msg.headlines];

  // 1단계: 헤드라인을 뒤에서부터 제거
  let text = compose(msg.heading, msg.summary, headlines, msg.link);
  let dropped = 0;
  while (textLength(text) > MAX_TEXT_LENGTH && headlines.length > 0) {
    headlines.pop();
    dropped++;
    text = compose(msg.heading, msg.summary, headlines, msg.link);
  }

  // 2단계: 그래도 넘으면 요약을 축약
  let summaryTruncated = false;
  if (textLength(text) > MAX_TEXT_LENGTH) {
    const overflow = textLength(text) - MAX_TEXT_LENGTH;
    const chars = [...msg.summary];
    const keep = Math.max(0, chars.length - overflow - textLength(ELLIPSIS));
    const shortSummary = keep > 0 ? chars.slice(0, keep).join("") + ELLIPSIS : "";
    summaryTruncated = true;
    text = compose(msg.heading, shortSummary, headlines, msg.link);
  }

  return {
    text,
    length: textLength(text),
    droppedHeadlines: dropped,
    summaryTruncated,
  };
}

/** 나에게 보내기 실행. 전송 직전 실제 길이를 로그로 남긴다. */
export async function sendToMe(
  accessToken: string,
  msg: BriefMessage,
): Promise<void> {
  const built = buildText(msg);

  console.log(
    `[notify] 발송 길이 ${built.length}/${MAX_TEXT_LENGTH}자` +
      (built.droppedHeadlines > 0
        ? `, 헤드라인 ${built.droppedHeadlines}개 제거`
        : "") +
      (built.summaryTruncated ? ", 요약 축약됨" : ""),
  );

  if (built.length > MAX_TEXT_LENGTH) {
    // 링크만으로도 200자를 넘는 비정상 상황 — 자르지 않고 실패시킨다.
    throw new Error(
      `[notify] 축약 후에도 ${built.length}자로 한도 초과. 링크 길이를 확인할 것`,
    );
  }

  const templateObject = {
    object_type: "text",
    text: built.text,
    link: { web_url: msg.link, mobile_web_url: msg.link },
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
  console.log("[notify] 발송 성공");
}
