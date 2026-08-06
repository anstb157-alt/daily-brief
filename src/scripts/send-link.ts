/**
 * 링크 한 통만 다시 보낸다.
 *
 * 카카오는 앱에 등록된 웹 도메인의 링크만 템플릿에서 살리기 때문에,
 * 도메인 미등록 상태에서 발송된 브리핑은 링크·버튼이 빠진 채 도착한다.
 * 브리핑 전체를 다시 보내면 같은 내용이 중복되므로 링크 한 통만 보낸다.
 *
 * 사용: npm run notify:link <stock|realestate|chungyak>
 */
import { getAccessToken } from "../auth/kakao.js";
import { siteConfig } from "../config.js";
import { kstDateString, kstShortDate } from "../date.js";
import { DOMAINS, type DomainId } from "../domains.js";
import { sendBrief } from "../notify.js";

const arg = process.argv[2];
if (arg === undefined || !(arg in DOMAINS)) {
  console.error(`사용법: npm run notify:link <${Object.keys(DOMAINS).join("|")}>`);
  process.exit(1);
}

const domain = DOMAINS[arg as DomainId];
const { PAGES_BASE_URL } = siteConfig();
const date = kstDateString();
const link = `${PAGES_BASE_URL.replace(/\/$/, "")}/${domain.outputDir}/${date}.html`;

const token = await getAccessToken();
await sendBrief(
  token,
  {
    heading: `${domain.emoji} ${kstShortDate()} ${domain.label}`,
    brief: null,
    fallbackSummary: "전문 링크입니다.",
    dashboard: [],
    link,
  },
  1,
);
