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
import { buildMessages, textLength } from "../notify.js";
import { httpConfig } from "../config.js";
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
const date = kstDateString();
const dashboard = buildStockDashboard(
  collected["market"] as MarketData | undefined,
  collected["flows"] as FlowsData | undefined,
);

if (summary.kind === "structured") {
  const b = summary.brief;
  console.log(`[summarize] 이슈 ${b.issues.length}개`);
  await saveThread("stock", { askedOn: date, question: b.closingQuestion });
} else {
  console.log("[summarize] 원문 폴백");
}

// 실제 발송 없이 카톡 본문만 조립해 확인한다
const messages = buildMessages(
  {
    heading: `${domain.emoji} 8/6 ${domain.label}`,
    brief: summary.kind === "structured" ? summary.brief : null,
    fallbackSummary: "요약 구조화에 실패했습니다.",
    dashboard,
    link: `https://anstb157-alt.github.io/daily-brief/stock/${date}.html`,
  },
  httpConfig().KAKAO_MAX_MESSAGES,
);
console.log(
  `\n[notify:dry] ${messages.length}통, 총 ${messages.reduce((a, m) => a + textLength(m), 0)}자`,
);
messages.forEach((m, i) => {
  console.log(`\n─── ${i + 1}통 (${textLength(m)}/200자) ───\n${m}`);
});

const html = renderHtml({
  domain,
  date,
  dashboard,
  summary,
  failedSources,
  generatedAt: new Date().toISOString(),
});
const path = `docs/${domain.outputDir}/${date}.html`;
await mkdir(dirname(path), { recursive: true });
await writeFile(path, html, "utf8");
console.log(`[render] ${path} (${html.length}바이트)`);
