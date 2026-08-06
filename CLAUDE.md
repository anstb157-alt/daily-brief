# daily-brief

매일 평일 아침 주식·부동산 브리핑을 생성해 카카오톡으로 발송하는 서버리스 파이프라인.
GitHub Actions(cron) → 수집(무료 API/RSS) → Gemini 요약 → Pages 발행 → 카톡 티저+링크.

## 절대 제약

- **유료 API 크레딧 사용 금지.** 무료 티어 초과 가능성이 있으면 코드 주석으로 명시
- TypeScript strict, `any` 금지, 모든 외부 응답은 zod로 파싱·검증
- 모든 키·설정값은 `src/config.ts` 경유 (process.env 직접 접근 금지)
- 외부 호출은 전부 타임아웃 + 지수 백오프 재시도 최대 3회
- 주석은 한국어
- 프롬프트 텍스트를 코드에 인라인하지 말 것 (`prompts/*.md`에서 로드)

## 명령

- `npm run typecheck` — tsc --noEmit
- `npm run config:check` — 현재 셸의 env 그룹별 충족 여부 표시
- 실행은 `tsx` (빌드 없음)

## 구조 규칙

- 수집기는 `Collector<T>` 구현, `{ ok: true, data } | { ok: false, reason }` 반환.
  개별 수집기 실패가 파이프라인을 중단시키면 안 된다 (allSettled)
- 주식/부동산 도메인은 완전 분리: 독립 실행·독립 커밋·독립 발송.
  파이프라인 로직은 `runPipeline(domain)` 하나, 차이는 설정 객체로 주입
- 수집 원문은 `output/raw/YYYY-MM-DD.json`으로 보존 (디버깅·재현용)
- 추적 종목·관심 지역은 `watchlist.json` (코드가 아닌 데이터)

## 설계 결정

결정과 사유는 [DECISIONS.md](DECISIONS.md). 새 결정을 내리면 반드시 거기 기록.
