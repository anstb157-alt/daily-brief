/**
 * 최초 1회 refresh token 발급 스크립트 (로컬 전용).
 *
 * 카카오 refresh token은 콘솔에서 조회할 수 없고 브라우저 인가를 거쳐야만 나온다.
 * 임시 로컬 서버를 띄워 Redirect URI로 돌아오는 인가 코드를 받고,
 * 곧바로 토큰으로 교환해 출력한다.
 *
 * 사용: npm run auth:issue
 */
import { createServer } from "node:http";
import { kakaoConfig } from "../config.js";
import { exchangeAuthCode } from "./kakao.js";

const AUTHORIZE_ENDPOINT = "https://kauth.kakao.com/oauth/authorize";
/** 나에게 보내기에 필요한 동의항목 */
const SCOPE = "talk_message";

const cfg = kakaoConfig();
const redirect = new URL(cfg.KAKAO_AUTH_REDIRECT_URI);
const port = Number(redirect.port || 80);

const authUrl =
  `${AUTHORIZE_ENDPOINT}?` +
  new URLSearchParams({
    response_type: "code",
    client_id: cfg.KAKAO_REST_API_KEY,
    redirect_uri: cfg.KAKAO_AUTH_REDIRECT_URI,
    scope: SCOPE,
    // 기존 세션이 있으면 동의 화면을 건너뛸 수 있어 강제로 다시 띄운다.
    // talk_message는 "선택 동의"라 접힌 영역에 해제 상태로 나타난다.
    prompt: "login",
  }).toString();

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error !== null || code === null) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`인가 실패: ${error ?? "code 없음"}`);
    console.error(
      `[auth] 인가 실패: ${error ?? "code 없음"} — ${url.searchParams.get("error_description") ?? ""}`,
    );
    server.close();
    process.exitCode = 1;
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("인가 완료. 터미널로 돌아가세요.");

  void exchangeAuthCode(code)
    .then((token) => {
      const refreshDays = Math.floor(
        (token.refresh_token_expires_in ?? 0) / 86_400,
      );
      const granted = (token.scope ?? "").split(" ").filter(Boolean);

      console.log("\n[auth] 발급 성공");
      console.log(`  scope: ${granted.length > 0 ? granted.join(", ") : "(없음)"}`);
      console.log(`  refresh token 유효기간: 약 ${refreshDays}일`);

      // 인가 성공과 동의 완료는 다르다. scope가 비면 발송 시 403(-402)이 난다.
      if (!granted.includes(SCOPE)) {
        console.error(
          `\n❌ ${SCOPE} 동의가 빠졌습니다. 이 토큰으로는 발송할 수 없습니다.` +
            "\n   동의 화면의 '선택 동의' 영역을 펼쳐 '카카오톡 메시지 전송'을 체크한 뒤" +
            "\n   npm run auth:issue 를 다시 실행하세요. (.env는 그대로 두세요)\n",
        );
        process.exitCode = 1;
        return;
      }

      console.log("\n아래 값을 .env의 KAKAO_REFRESH_TOKEN에 넣으세요:\n");
      console.log(token.refresh_token ?? "(refresh_token 없음 — 응답 확인 필요)");
      console.log("");
    })
    .catch((e: unknown) => {
      console.error(
        `[auth] 토큰 교환 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
      process.exitCode = 1;
    })
    .finally(() => server.close());
});

server.listen(port, () => {
  console.log(`[auth] 임시 서버 :${port} 대기 중`);
  console.log("\n아래 URL을 브라우저에서 열어 로그인·동의하세요:\n");
  console.log(authUrl);
  console.log("");
});
