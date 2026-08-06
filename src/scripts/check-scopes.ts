/**
 * 현재 refresh token이 어떤 동의항목(scope)을 갖고 있는지 조회한다.
 * insufficient scopes 진단용. 사용: npm run kakao:scopes
 */
import { getAccessToken } from "../auth/kakao.js";

const token = await getAccessToken();

for (const [label, url] of [
  ["동의항목", "https://kapi.kakao.com/v2/user/scopes"],
  ["토큰정보", "https://kapi.kakao.com/v1/user/access_token_info"],
] as const) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`[${label}] ${res.status}\n${await res.text()}\n`);
}
