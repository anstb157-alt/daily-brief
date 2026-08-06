/**
 * 브리핑 → 정적 HTML.
 *
 * 카톡 본문이 200자라 전문은 여기서 읽는다 (DECISIONS #1).
 * 외부 CSS·폰트·스크립트를 쓰지 않는다 — GitHub Pages에 파일 하나만 올리면 되고,
 * 네트워크가 느린 모바일에서도 즉시 뜬다.
 *
 * 어떤 소스가 실패했는지 하단에 반드시 표시한다. 빠진 정보를 조용히 감추지 않는다.
 */
import type { DomainConfig } from "./domains.js";
import type { SummaryResult } from "./summarize.js";

export interface RenderInput {
  domain: DomainConfig;
  /** KST YYYY-MM-DD */
  date: string;
  summary: SummaryResult;
  /** 실패한 수집 소스 */
  failedSources: { name: string; reason: string }[];
  /** 생성 시각 표기 (KST) */
  generatedAt: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 섹션 본문을 문단/목록으로 바꾼다.
 * 마크다운 파서를 쓰지 않는 이유: 의존성을 늘릴 만큼 복잡한 문법을 쓰지 않는다.
 * 줄 앞의 `-` `·` `*` 만 목록으로 인식한다.
 */
function renderBody(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const bullet = /^[-·*]\s+/.exec(trimmed);

    if (bullet) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${escapeHtml(trimmed.slice(bullet[0].length))}</li>`);
      continue;
    }

    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    if (trimmed.length > 0) out.push(`<p>${escapeHtml(trimmed)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

function renderSummary(summary: SummaryResult): string {
  if (summary.kind === "raw") {
    // 스키마 검증 실패 폴백 — 가공하지 않고 원문 그대로 보여준다
    return [
      '<p class="warn">구조화에 실패해 모델 응답 원문을 그대로 표시합니다.</p>',
      `<pre>${escapeHtml(summary.text)}</pre>`,
    ].join("\n");
  }

  const { oneLiner, sections } = summary.brief;
  return [
    `<p class="lede">${escapeHtml(oneLiner)}</p>`,
    ...sections.map(
      (s) =>
        `<section><h2>${escapeHtml(s.title)}</h2>\n${renderBody(s.body)}</section>`,
    ),
  ].join("\n");
}

/** 실패 사유에 에러 페이지 HTML이 통째로 실려오는 경우가 있어 한 줄로 줄인다 */
function compactReason(reason: string): string {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

function renderFailures(failed: RenderInput["failedSources"]): string {
  if (failed.length === 0) return "";
  return [
    '<section class="failures">',
    "<h2>수집 실패 소스</h2>",
    "<ul>",
    ...failed.map(
      (f) =>
        `<li><strong>${escapeHtml(f.name)}</strong> — ${escapeHtml(compactReason(f.reason))}</li>`,
    ),
    "</ul>",
    "</section>",
  ].join("\n");
}

const STYLE = `
:root { color-scheme: light dark; --fg:#1a1a1a; --muted:#666; --line:#e3e3e3; --accent:#0b6; --warn:#b45309; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8e8e8; --muted:#9a9a9a; --line:#333; --accent:#3d9; --warn:#fbbf24; }
}
* { box-sizing: border-box; }
body { margin:0; padding:1.5rem 1.25rem 4rem; max-width:44rem; margin-inline:auto;
  font:16px/1.7 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;
  color:var(--fg); word-break:keep-all; overflow-wrap:anywhere; }
header { border-bottom:2px solid var(--fg); padding-bottom:.75rem; margin-bottom:1.5rem; }
h1 { font-size:1.5rem; margin:0; }
.date { color:var(--muted); font-size:.9rem; margin-top:.25rem; }
.lede { font-size:1.15rem; font-weight:600; line-height:1.6; margin:0 0 2rem;
  padding-left:.75rem; border-left:3px solid var(--accent); }
section { margin-bottom:2rem; }
h2 { font-size:1.05rem; margin:0 0 .6rem; padding-bottom:.3rem; border-bottom:1px solid var(--line); }
p { margin:.5rem 0; }
ul { margin:.5rem 0; padding-left:1.2rem; }
li { margin:.3rem 0; }
pre { white-space:pre-wrap; background:rgba(127,127,127,.1); padding:1rem; border-radius:6px; font-size:.9rem; }
.warn { color:var(--warn); font-weight:600; }
.failures { border:1px solid var(--line); border-radius:6px; padding:1rem; }
.failures h2 { border:0; color:var(--warn); }
.failures li { color:var(--muted); font-size:.9rem; }
footer { color:var(--muted); font-size:.8rem; border-top:1px solid var(--line); padding-top:1rem; }
`.trim();

export function renderHtml(input: RenderInput): string {
  const title = `${input.date} ${input.domain.label} 브리핑`;
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>${input.domain.emoji} ${escapeHtml(input.domain.label)} 브리핑</h1>
<div class="date">${escapeHtml(input.date)} (KST)</div>
</header>
<main>
${renderSummary(input.summary)}
${renderFailures(input.failedSources)}
</main>
<footer>생성 ${escapeHtml(input.generatedAt)} · 자동 생성된 요약이며 투자 권유가 아닙니다.</footer>
</body>
</html>
`;
}
