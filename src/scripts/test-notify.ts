/**
 * 2단계 확인용 — 실제 카톡 도착 여부를 검증한다.
 * 사용: npm run notify:test
 */
import { getAccessToken } from "../auth/kakao.js";
import { sendToMe, type BriefMessage } from "../notify.js";

const now = new Date();
const label = `${now.getMonth() + 1}/${now.getDate()}`;

const msg: BriefMessage = {
  heading: `📈 ${label} 증시`,
  summary: "daily-brief 발송 경로 테스트 메시지입니다.",
  headlines: [
    "카카오 토큰 갱신 확인",
    "200자 축약 로직 확인",
    "Pages 링크 연결 확인",
  ],
  link: "https://github.com/",
};

const token = await getAccessToken();
await sendToMe(token, msg);
