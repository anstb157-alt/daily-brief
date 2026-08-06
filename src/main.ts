/**
 * 엔트리포인트. 도메인 하나를 실행한다.
 * 사용: tsx src/main.ts stock | realestate
 */
import { DOMAINS, type DomainId } from "./domains.js";
import { runPipeline } from "./pipeline.js";

const arg = process.argv[2];
if (arg === undefined || !(arg in DOMAINS)) {
  console.error(
    `사용법: tsx src/main.ts <${Object.keys(DOMAINS).join("|")}>\n받은 값: ${arg ?? "(없음)"}`,
  );
  process.exit(1);
}

const result = await runPipeline(arg as DomainId);
console.log(
  result.sent
    ? `✅ 발송 완료 — ${result.pageUrl}`
    : `⏭️  발송 스킵 — ${result.skipReason ?? ""}`,
);
