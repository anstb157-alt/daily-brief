/**
 * GitHub Actions Secrets 쓰기.
 *
 * Secrets는 레포 공개키로 봉인(sealed box)해서 올려야 한다.
 * Node 내장 crypto에는 sealed box가 없어 libsodium-wrappers(무료·WASM)를 쓴다.
 *
 * 주의 1: 기본 GITHUB_TOKEN으로는 Secrets 쓰기가 불가하다.
 *         Secrets Read/Write 권한을 준 fine-grained PAT(GH_SECRETS_PAT)이 필요하다.
 * 주의 2: libsodium-wrappers 0.7.15의 ESM 빌드는 깨져 있다
 *         (dist/modules-esm/libsodium-wrappers.mjs가 옆 패키지 파일을
 *          "./libsodium.mjs" 상대경로로 import → ERR_MODULE_NOT_FOUND).
 *         정상 동작하는 CJS 빌드를 createRequire로 불러온다.
 */
import { createRequire } from "node:module";
import type sodiumTypes from "libsodium-wrappers";
import { z } from "zod";
import { githubConfig } from "../config.js";
import { fetchJson, fetchWithRetry } from "../http.js";

const sodium = createRequire(import.meta.url)(
  "libsodium-wrappers",
) as typeof sodiumTypes;

const publicKeySchema = z.object({
  key_id: z.string(),
  key: z.string(),
});

const API = "https://api.github.com";

function headers(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "daily-brief",
  };
}

/** 레포 Actions secret을 생성·갱신한다. */
export async function putRepoSecret(
  name: string,
  value: string,
): Promise<void> {
  const { GH_SECRETS_PAT, GITHUB_REPOSITORY } = githubConfig();
  const base = `${API}/repos/${GITHUB_REPOSITORY}/actions/secrets`;

  const pubkey = publicKeySchema.parse(
    await fetchJson(
      `${base}/public-key`,
      { headers: headers(GH_SECRETS_PAT) },
      "github:public-key",
    ),
  );

  await sodium.ready;
  const encrypted = sodium.crypto_box_seal(
    sodium.from_string(value),
    sodium.from_base64(pubkey.key, sodium.base64_variants.ORIGINAL),
  );

  await fetchWithRetry(
    `${base}/${name}`,
    {
      method: "PUT",
      headers: { ...headers(GH_SECRETS_PAT), "Content-Type": "application/json" },
      body: JSON.stringify({
        encrypted_value: sodium.to_base64(
          encrypted,
          sodium.base64_variants.ORIGINAL,
        ),
        key_id: pubkey.key_id,
      }),
    },
    `github:put-secret:${name}`,
  );
}
