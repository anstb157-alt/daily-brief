/**
 * 3단계 확인용 — 수집기를 돌려 결과를 콘솔과 output/raw/에 출력한다.
 * 사용: npm run collect:test
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { marketCollector } from "../collectors/market.js";
import { calendarCollector } from "../collectors/calendar.js";
import { flowsCollector } from "../collectors/flows.js";
import { newsCollector } from "../collectors/news.js";
import { createEarningsCollector } from "../collectors/earnings.js";
import { kstDateString, lastUsTradingDate } from "../date.js";
import type { Collector } from "../collectors/types.js";

const collectors: Collector<unknown>[] = [
  marketCollector,
  calendarCollector,
  flowsCollector,
  newsCollector,
  createEarningsCollector(lastUsTradingDate()),
];

// 한 수집기가 죽어도 나머지는 계속 — 파이프라인과 동일한 규칙
const settled = await Promise.allSettled(
  collectors.map(async (c) => [c.name, await c.collect()] as const),
);

const raw: Record<string, unknown> = {};
for (const [i, r] of settled.entries()) {
  const name = collectors[i]?.name ?? `#${i}`;
  if (r.status === "rejected") {
    // toResult가 감싸므로 여기 오면 수집기 밖의 버그다
    raw[name] = { ok: false, reason: `수집기 예외: ${String(r.reason)}` };
    console.error(`❌ ${name} — 예상치 못한 예외: ${String(r.reason)}`);
    continue;
  }
  const [, result] = r.value;
  raw[name] = result;
  console.log(
    result.ok ? `✅ ${name}` : `❌ ${name} — ${result.reason.slice(0, 200)}`,
  );
}

const path = `output/raw/${kstDateString()}.json`;
await mkdir(dirname(path), { recursive: true });
await writeFile(path, JSON.stringify(raw, null, 2), "utf8");

console.log(`\n--- ${path} ---`);
console.log(JSON.stringify(raw, null, 2));
