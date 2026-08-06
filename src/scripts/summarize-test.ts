/**
 * 발송 없이 수집 → 요약 → HTML 생성까지만 로컬에서 돌린다.
 * 카톡 쿼터(발신자/수신자 pair당 일 20건)를 아끼기 위한 드라이런.
 * 사용: npm run brief:dry [stock|realestate]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { calendarCollector } from "../collectors/calendar.js";
import { createEarningsCollector } from "../collectors/earnings.js";
import { flowsCollector } from "../collectors/flows.js";
import { marketCollector } from "../collectors/market.js";
import { newsCollector } from "../collectors/news.js";
import type { Collector } from "../collectors/types.js";
import type { FlowsData } from "../collectors/flows.js";
import type { MarketData } from "../collectors/market.js";
import { buildStockDashboard } from "../dashboard.js";
import { kstDateString, lastUsTradingDate } from "../date.js";
import { DOMAINS } from "../domains.js";
import { buildText } from "../notify.js";
import { renderHtml } from "../render.js";
import { summarize } from "../summarize.js";
import { loadThread, saveThread } from "../threads.js";

const domain = DOMAINS.stock;
const collectors: Collector<unknown>[] = [
  marketCollector,
  flowsCollector,
  calendarCollector,
  newsCollector,
  createEarningsCollector(lastUsTradingDate()),
];

const settled = await Promise.all(
  collectors.map(async (c) => [c.name, await c.collect()] as const),
);

const collected: Record<string, unknown> = {};
const failedSources: { name: string; reason: string }[] = [];
for (const [name, r] of settled) {
  if (r.ok) collected[name] = r.data;
  else {
    collected[name] = "데이터 없음";
    failedSources.push({ name, reason: r.reason });
  }
}
console.log(
  `[collect] 성공 ${collectors.length - failedSources.length} / 실패 ${failedSources.length}`,
);

const openThread = await loadThread("stock");
console.log(`[thread] 전일: ${openThread ? openThread.question : "없음"}`);

const summary = await summarize(domain, collected, openThread);
if (summary.kind === "structured") {
  const b = summary.brief;
  console.log(`[summarize] 이슈 ${b.issues.length}개`);
  console.log(`  한 줄: ${b.oneLiner}`);
  b.headlines.forEach((h) => console.log(`  · ${h}`));
  console.log(`  코멘트: ${b.dashboardComment || "(없음)"}`);
  console.log(`  스레드 후속: ${b.threadFollowup || "(생략)"}`);
  console.log(`  마무리 질문: ${b.closingQuestion}`);
  await saveThread("stock", { askedOn: kstDateString(), question: b.closingQuestion });

  const built = buildText({
    heading: `${domain.emoji} 8/6 ${domain.label}`,
    summary: b.oneLiner,
    headlines: b.headlines,
    link: "https://anstb157-alt.github.io/daily-brief/stock/2026-08-06.html",
  });
  console.log(
    `[notify:dry] ${built.length}/200자, 헤드라인 ${built.droppedHeadlines}개 제거, 요약축약 ${built.summaryTruncated}`,
  );
} else {
  console.log("[summarize] 원문 폴백");
}

const date = kstDateString();
const html = renderHtml({
  domain,
  date,
  dashboard: buildStockDashboard(
    collected["market"] as MarketData | undefined,
    collected["flows"] as FlowsData | undefined,
  ),
  summary,
  failedSources,
  generatedAt: new Date().toISOString(),
});
const path = `docs/${domain.outputDir}/${date}.html`;
await mkdir(dirname(path), { recursive: true });
await writeFile(path, html, "utf8");
console.log(`[render] ${path} (${html.length}바이트)`);
