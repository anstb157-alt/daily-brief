/**
 * 카카오 토큰 관리.
 *
 * access token 수명은 6시간이라 매 실행마다 refresh token으로 새로 받는다.
 * refresh token 자체도 약 2개월 만료이고, 카카오는 잔여 유효기간이
 * 1개월 미만일 때만 갱신 응답에 새 refresh_token을 함께 준다.
 * 새 값이 오면 GitHub Secrets를 갱신해 회전시킨다 —
 * 이걸 빠뜨리면 두 달쯤 뒤 파이프라인이 조용히 죽는다.
 */
import { z } from "zod";
import { kakaoConfig, kakaoTokenConfig } from "../config.js";
import { fetchJson } from "../http.js";
import { putRepoSecret } from "./github-secret.js";

const TOKEN_ENDPOINT = "https://kauth.kakao.com/oauth/token";
const SECRET_NAME = "KAKAO_REFRESH_TOKEN";

/** 갱신 응답. refresh_token 계열은 조건부로만 내려오므로 optional. */
const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  refresh_token_expires_in: z.number().optional(),
  scope: z.string().optional(),
});
export type KakaoTokenResponse = z.infer<typeof tokenResponseSchema>;

async function postToken(params: Record<string, string>, label: string) {
  return tokenResponseSchema.parse(
    await fetchJson(
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
        body: new URLSearchParams(params).toString(),
      },
      label,
    ),
  );
}

/** 인가 코드 → 최초 토큰 교환. issue-token.ts에서만 쓴다. */
export async function exchangeAuthCode(
  code: string,
): Promise<KakaoTokenResponse> {
  const cfg = kakaoConfig();
  return postToken(
    {
      grant_type: "authorization_code",
      client_id: cfg.KAKAO_REST_API_KEY,
      client_secret: cfg.KAKAO_CLIENT_SECRET,
      redirect_uri: cfg.KAKAO_AUTH_REDIRECT_URI,
      code,
    },
    "kakao:authorization_code",
  );
}

/**
 * refresh token으로 access token을 갱신한다.
 * 새 refresh token이 내려오면 Secrets 회전까지 시도한다.
 * 회전 실패는 이번 실행의 발송을 막지 않는다 (access token은 이미 손에 있음).
 */
export async function getAccessToken(): Promise<string> {
  const cfg = kakaoConfig();
  const { KAKAO_REFRESH_TOKEN } = kakaoTokenConfig();

  const token = await postToken(
    {
      grant_type: "refresh_token",
      client_id: cfg.KAKAO_REST_API_KEY,
      client_secret: cfg.KAKAO_CLIENT_SECRET,
      refresh_token: KAKAO_REFRESH_TOKEN,
    },
    "kakao:refresh_token",
  );

  if (token.refresh_token) {
    const remainDays = token.refresh_token_expires_in
      ? Math.floor(token.refresh_token_expires_in / 86_400)
      : undefined;
    console.log(
      `[kakao] 새 refresh token 수신 (잔여 ${remainDays ?? "?"}일) — Secrets 회전 시도`,
    );
    try {
      await putRepoSecret(SECRET_NAME, token.refresh_token);
      console.log(`[kakao] Secrets ${SECRET_NAME} 회전 완료`);
    } catch (e) {
      // 회전 실패는 치명적이지만 이번 발송은 계속한다. 로그로 반드시 드러낼 것.
      console.error(
        `[kakao] ⚠️ Secrets 회전 실패 — 방치하면 만료 후 파이프라인이 죽는다: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  } else {
    console.log("[kakao] refresh token 갱신 없음 (잔여 1개월 초과 — 정상)");
  }

  return token.access_token;
}
