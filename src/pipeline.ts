/**
 * 도메인 파이프라인.
 *
 * 수집 → 요약 → 렌더 → 발송을 도메인 하나 기준으로 수행한다.
 * 도메인(주식·부동산·청약) 차이는 전부 DomainConfig와 수집기 목록으로 주입된다 (DECISIONS #2).
 * 파이프라인 로직을 도메인별로 복사하지 않는다.
 *
 * 한 도메인의 실패가 다른 도메인에 전파되지 않아야 하므로,
 * 워크플로우 파일 자체를 분리했다. 이 함수는 한 번에 한 도메인만 처리한다.
 *
 * 부동산 워크플로우와는 독립이다 — 하나가 죽어도 나머지는 각자 스케줄대로 돈다.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getAccessToken } from "./auth/kakao.js";
import { calendarCollector } from "./collectors/calendar.js";
import { createEarningsCollector } from "./collectors/earnings.js";
import { flowsCollector } from "./collectors/flows.js";
import { marketCollector } from "./collectors/market.js";
import { createNewsCollector } from "./collectors/news.js";
import { priceCollector } from "./collectors/realestate/price.js";
import { chungyakCollector } from "./collectors/realestate/chungyak.js";
import { applyhomeCollector } from "./collectors/realestate/applyhome.js";
import { supplyCollector } from "./collectors/realestate/supply.js";
import type { Collector } from "./collectors/types.js";
import { httpConfig, siteConfig } from "./config.js";
import {
  buildChungyakDashboard,
  buildRealestateDashboard,
  buildStockDashboard,
  type Dashboard,
} from "./dashboard.js";
import { kstDateString, kstShortDate, lastUsTradingDate } from "./date.js";
import { DOMAINS, type DomainId } from "./domains.js";
import { sendBrief } from "./notify.js";
import { renderHtml } from "./render.js";
import { summarize } from "./summarize.js";
import { loadThread, saveThread } from "./threads.js";
import type { MarketData } from "./collectors/market.js";
import type { FlowsData } from "./collectors/flows.js";
import type { PriceData } from "./collectors/realestate/price.js";
import type { ApplyhomeData } from "./collectors/realestate/applyhome.js";
import type { SupplyData } from "./collectors/realestate/supply.js";

/** Pages 소스 디렉터리. GitHub Pages를 main 브랜치의 /docs로 설정한다 */
const PAGES_DIR = "docs";

function collectorsFor(domain: DomainId): Collector<unknown>[] {
  if (domain === "stock") {
    return [
      marketCollector,
      flowsCollector,
      calendarCollector,
      createNewsCollector("stock"),
      createEarningsCollector(lastUsTradingDate()),
    ];
  }
  if (domain === "realestate") {
    return [
      priceCollector,
      supplyCollector,
      chungyakCollector,
      createNewsCollector("realestate"),
    ];
  }
  // 청약은 공고 데이터가 본체다. 뉴스는 정책 변경 감지용으로만 곁들인다.
  return [applyhomeCollector, createNewsCollector("realestate")];
}

function dashboardFor(
  domain: DomainId,
  collected: Record<string, unknown>,
): Dashboard {
  if (domain === "stock") {
    return buildStockDashboard(
      collected["market"] as MarketData | undefined,
      collected["flows"] as FlowsData | undefined,
    );
  }
  if (domain === "realestate") {
    return buildRealestateDashboard(
      collected["price"] as PriceData | undefined,
      collected["supply"] as SupplyData | undefined,
    );
  }
  return buildChungyakDashboard(collected["applyhome"] as ApplyhomeData | undefined);
}

export interface PipelineOptions {
  /**
   * false면 HTML까지만 만들고 카톡을 보내지 않는다.
   * 프롬프트를 손볼 때 결과만 확인하려고 매번 발송하면
   * 카카오 pair 쿼터(일 20건)가 금방 마른다.
   */
  send?: boolean;
}

export interface PipelineResult {
  /** 발송까지 마쳤는지. 스킵이면 false */
  sent: boolean;
  /** 스킵 사유 (Actions 로그에 남긴다) */
  skipReason?: string;
  pageUrl: string;
}

export async function runPipeline(
  domainId: DomainId,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const { send = true } = options;
  const domain = DOMAINS[domainId];
  const { PAGES_BASE_URL } = siteConfig();
  const date = kstDateString();
  const pageUrl = `${PAGES_BASE_URL.replace(/\/$/, "")}/${domain.outputDir}/${date}.html`;

  // ── 수집 ── 개별 실패가 전체를 멈추지 않는다
  const collectors = collectorsFor(domainId);
  const settled = await Promise.allSettled(
    collectors.map(async (c) => [c.name, await c.collect()] as const),
  );

  const collected: Record<string, unknown> = {};
  const failedSources: { name: string; reason: string }[] = [];

  settled.forEach((r, i) => {
    const name = collectors[i]?.name ?? `#${i}`;
    if (r.status === "rejected") {
      // toResult가 감싸므로 여기 오면 수집기 밖의 버그다
      collected[name] = "데이터 없음";
      failedSources.push({ name, reason: `수집기 예외: ${String(r.reason)}` });
      return;
    }
    const [, result] = r.value;
    if (result.ok) {
      collected[name] = result.data;
    } else {
      collected[name] = "데이터 없음";
      failedSources.push({ name, reason: result.reason });
    }
  });

  const okCount = collectors.length - failedSources.length;
  console.log(`[pipeline:${domainId}] 수집 성공 ${okCount} / 실패 ${failedSources.length}`);

  // 수집 원문 보존 (디버깅·재현용)
  const rawPath = `output/raw/${domainId}-${date}.json`;
  await mkdir(dirname(rawPath), { recursive: true });
  await writeFile(rawPath, JSON.stringify(collected, null, 2), "utf8");

  // ── 발송 스킵 판정 ──
  // 신규 항목이 0건인 날은 보내지 않는다. 매일 같은 화면을 받으면 열지 않게 된다.
  if (okCount === 0) {
    const skipReason = "모든 수집기 실패 — 신규 항목 0건";
    console.log(`[pipeline:${domainId}] 발송 스킵: ${skipReason}`);
    return { sent: false, skipReason, pageUrl };
  }

  // ── 요약 ──
  const openThread = await loadThread(domainId);
  console.log(
    `[pipeline:${domainId}] 전일 스레드: ${openThread ? openThread.question : "없음"}`,
  );
  const summary = await summarize(domain, collected, openThread);

  // ── 렌더 ──
  const dashboard = dashboardFor(domainId, collected);
  const html = renderHtml({
    domain,
    date,
    dashboard,
    summary,
    failedSources,
    generatedAt: new Date().toISOString(),
  });
  const htmlPath = `${PAGES_DIR}/${domain.outputDir}/${date}.html`;
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(htmlPath, html, "utf8");
  console.log(`[pipeline:${domainId}] ${htmlPath} (${html.length}바이트)`);

  // 다음 실행이 이어받을 스레드 저장
  if (summary.kind === "structured") {
    await saveThread(domainId, {
      askedOn: date,
      question: summary.brief.closingQuestion,
    });
  }

  if (!send) {
    console.log(`[pipeline:${domainId}] --no-send — 발송 생략`);
    return { sent: false, skipReason: "--no-send", pageUrl };
  }

  // ── 발송 ── 200자 템플릿을 여러 통으로 나눠 보낸다
  const token = await getAccessToken();
  await sendBrief(
    token,
    {
      heading: `${domain.emoji} ${kstShortDate()} ${domain.label}`,
      brief: summary.kind === "structured" ? summary.brief : null,
      fallbackSummary: "요약 구조화에 실패했습니다. 본문 링크를 확인하세요.",
      dashboard,
      link: pageUrl,
    },
    httpConfig().KAKAO_MAX_MESSAGES,
  );

  return { sent: true, pageUrl };
}
