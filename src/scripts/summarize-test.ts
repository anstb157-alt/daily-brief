/**
 * 4단계 확인용 — 수집 → 요약 → HTML 생성을 로컬에서 돌린다.
 * 사용: npm run summarize:test
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { marketCollector } from "../collectors/market.js";
import { calendarCollector } from "../collectors/calendar.js";
import type { Collector } from "../collectors/types.js";
import { DOMAINS } from "../domains.js";
import { summarize } from "../summarize.js";
import { renderHtml } from "../render.js";
import { kstDateString } from "../date.js";

const domain = DOMAINS.stock;
const collectors: Collector<unknown>[] = [marketCollector, calendarCollector];

// 수집 — 실패한 소스는 "데이터 없음"으로 넘기고 목록에 남긴다
const results = await Promise.all(
  collectors.map(async (c) => [c.name, await c.collect()] as const),
);

const collected: Record<string, unknown> = {};
const failedSources: { name: string; reason: string }[] = [];
for (const [name, r] of results) {
  if (r.ok) {
    collected[name] = r.data;
  } else {
    collected[name] = "데이터 없음";
    failedSources.push({ name, reason: r.reason });
  }
}
console.log(
  `[collect] 성공 ${Object.keys(collected).length - failedSources.length} / 실패 ${failedSources.length}`,
);

// 요약
const summary = await summarize(domain, collected);
console.log(
  summary.kind === "structured"
    ? `[summarize] 구조화 성공 — 섹션 ${summary.brief.sections.length}개, 헤드라인 ${summary.brief.headlines.length}개`
    : "[summarize] 원문 폴백",
);
if (summary.kind === "structured") {
  console.log(`  한 줄 요약: ${summary.brief.oneLiner}`);
  summary.brief.headlines.forEach((h) => console.log(`  · ${h}`));
}

// 렌더
const date = kstDateString();
const html = renderHtml({
  domain,
  date,
  summary,
  failedSources,
  generatedAt: new Date().toISOString(),
});

const path = `output/${domain.outputDir}/${date}.html`;
await mkdir(dirname(path), { recursive: true });
await writeFile(path, html, "utf8");
console.log(`\n[render] ${path} (${html.length}바이트)`);
