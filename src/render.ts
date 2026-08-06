/**
 * 브리핑 → 정적 HTML.
 *
 * 카톡 본문이 200자라 전문은 여기서 읽는다 (DECISIONS #1).
 * 외부 CSS·폰트·스크립트를 쓰지 않는다 — 파일 하나만 올리면 되고 모바일에서 즉시 뜬다.
 *
 * 블록 순서는 코드가 고정한다 (모델이 바꿀 수 없다):
 *   1) 정량 대시보드  2) 어제 스레드 후속  3) 이슈·내러티브  4) 오늘 일정  5) 마무리 질문
 * 정렬은 3번 블록 안에서만 일어나고, 그건 모델이 이미 정렬해서 준다.
 *
 * 어떤 소스가 실패했는지 하단에 반드시 표시한다. 빠진 정보를 조용히 감추지 않는다.
 */
import type { Dashboard } from "./dashboard.js";
import type { DomainConfig } from "./domains.js";
import type { SummaryResult } from "./summarize.js";

export interface RenderInput {
  domain: DomainConfig;
  /** KST YYYY-MM-DD */
  date: string;
  dashboard: Dashboard;
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

/** `| a | b |` 형태의 표 행인가 */
function isTableRow(line: string): boolean {
  return line.startsWith("|") && line.endsWith("|") && line.length > 2;
}

/** `|---|---|` 구분행인가 */
function isTableDivider(line: string): boolean {
  return isTableRow(line) && /^\|[\s:|-]+\|$/.test(line);
}

function splitCells(line: string): string[] {
  return line
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
}

/**
 * 링크는 마크다운 `[텍스트](URL)`만 인식한다.
 * URL은 http(s)만 허용한다 — 모델 출력이 그대로 앵커가 되므로 스킴을 제한한다.
 */
function renderInline(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) =>
      `<a href="${url}" target="_blank" rel="noopener">${label}</a>`,
  );
}

/** 표 블록을 <table>로. 넓은 표는 가로 스크롤 컨테이너에 넣는다 */
function renderTable(rows: string[]): string {
  const [headRow, ...rest] = rows;
  if (!headRow) return "";
  const bodyRows = rest.filter((r) => !isTableDivider(r));

  const head = splitCells(headRow)
    .map((c) => `<th>${renderInline(c)}</th>`)
    .join("");
  const body = bodyRows
    .map(
      (r) =>
        `<tr>${splitCells(r)
          .map((c) => `<td>${renderInline(c)}</td>`)
          .join("")}</tr>`,
    )
    .join("\n");

  return `<div class="tw"><table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`;
}

/**
 * 본문을 표/문단/목록으로 바꾼다.
 * 마크다운 파서를 쓰지 않는 이유: 의존성을 늘릴 만큼 복잡한 문법을 쓰지 않는다.
 * 인식하는 것: `| a | b |` 표, 줄 앞의 `-` `·` `*` 목록, `[텍스트](URL)` 링크.
 */
function renderBody(body: string): string {
  const out: string[] = [];
  let list: string[] = [];
  let table: string[] = [];

  const flushList = () => {
    if (list.length > 0) out.push(`<ul>\n${list.join("\n")}\n</ul>`);
    list = [];
  };
  const flushTable = () => {
    if (table.length > 0) out.push(renderTable(table));
    table = [];
  };

  for (const line of body.split("\n")) {
    const trimmed = line.trim();

    if (isTableRow(trimmed)) {
      flushList();
      table.push(trimmed);
      continue;
    }
    flushTable();

    const bullet = /^[-·*]\s+/.exec(trimmed);
    if (bullet) {
      list.push(`<li>${renderInline(trimmed.slice(bullet[0].length))}</li>`);
      continue;
    }
    flushList();
    if (trimmed.length > 0) out.push(`<p>${renderInline(trimmed)}</p>`);
  }
  flushList();
  flushTable();
  return out.join("\n");
}

// ─── 1) 정량 대시보드 ───────────────────────────────────────────

function renderDashboard(dashboard: Dashboard): string {
  const groups = dashboard.map((group) => {
    const cells = group.cells.map(
      (c) => `<div class="cell ${c.direction}">
<div class="k">${escapeHtml(c.label)}</div>
<div class="v">${escapeHtml(c.value)}</div>
<div class="d">${escapeHtml(c.delta)}</div>
</div>`,
    );
    return `<div class="grid">\n${cells.join("\n")}\n</div>`;
  });
  return `<section class="dash">\n${groups.join('\n<hr class="sep">\n')}\n</section>`;
}

// ─── 2~5) 서술 블록 ────────────────────────────────────────────

function block(title: string, inner: string): string {
  if (inner.trim().length === 0) return "";
  return `<section><h2>${escapeHtml(title)}</h2>\n${inner}</section>`;
}

function renderNarrative(summary: SummaryResult): string {
  if (summary.kind === "raw") {
    // 검증 실패 폴백 — 가공하지 않고 원문 그대로 보여준다
    return [
      '<p class="warn">구조화에 실패해 모델 응답 원문을 그대로 표시합니다.</p>',
      `<pre>${escapeHtml(summary.text)}</pre>`,
    ].join("\n");
  }

  const b = summary.brief;
  const issues = b.issues
    .map(
      (i) =>
        `<article><h3>${escapeHtml(i.title)}</h3>\n${renderBody(i.body)}</article>`,
    )
    .join("\n");

  return [
    // 일정이 맨 앞이다 — 장 열리기 전에 "오늘 뭘 봐야 하나"가 먼저다
    block("오늘 일정", renderBody(b.schedule)),
    block("예정 일정", renderBody(b.upcoming)),
    // 스레드가 없는 날은 블록 자체가 생략된다
    block("어제 스레드 후속", renderBody(b.threadFollowup)),
    block("이슈", issues),
    block("내일로 넘기는 질문", renderBody(b.closingQuestion)),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
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

// 대시보드가 첫 화면에 통째로 들어와야 해서 상단 여백과 셀 높이를 줄였다.
const STYLE = `
:root { color-scheme: light dark;
  --fg:#1a1a1a; --muted:#6b6b6b; --line:#e3e3e3; --card:#f6f6f7;
  --up:#c0392b; --down:#1565c0; --flat:#6b6b6b; --warn:#b45309; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8e8e8; --muted:#9a9a9a; --line:#333; --card:#1c1c1e;
    --up:#ff6b5a; --down:#5aa9ff; --flat:#9a9a9a; --warn:#fbbf24; }
}
* { box-sizing:border-box; }
body { margin:0 auto; padding:1rem .9rem 3rem; max-width:44rem;
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;
  color:var(--fg); word-break:keep-all; overflow-wrap:anywhere; }
header { display:flex; align-items:baseline; gap:.5rem; margin-bottom:.7rem; }
h1 { font-size:1.1rem; margin:0; }
.date { color:var(--muted); font-size:.85rem; }

/* 모바일 2열 고정 */
.grid { display:grid; grid-template-columns:repeat(2,1fr); gap:.4rem; }
@media (min-width:34rem) { .grid { grid-template-columns:repeat(4,1fr); } }
.cell { background:var(--card); border-radius:8px; padding:.5rem .6rem; }
.cell .k { font-size:.72rem; color:var(--muted); letter-spacing:-.02em; }
.cell .v { font-size:1.02rem; font-weight:700; font-variant-numeric:tabular-nums; }
.cell .d { font-size:.8rem; font-variant-numeric:tabular-nums; color:var(--flat); }
.cell.up .d, .cell.up .v { color:var(--up); }
.cell.down .d, .cell.down .v { color:var(--down); }
.sep { border:0; border-top:1px solid var(--line); margin:.5rem 0; }
.dash { margin-bottom:.8rem; }
.comment { font-size:.9rem; color:var(--muted); margin:0 0 1.6rem; }

section { margin-bottom:1.6rem; }
h2 { font-size:1rem; margin:0 0 .5rem; padding-bottom:.25rem; border-bottom:1px solid var(--line); }
h3 { font-size:.95rem; margin:0 0 .3rem; }
article { margin-bottom:1rem; }
p { margin:.4rem 0; }
ul { margin:.4rem 0; padding-left:1.15rem; }
li { margin:.25rem 0; }
a { color:inherit; text-decoration:underline; text-underline-offset:2px; }
/* 넓은 표는 페이지가 아니라 표 자신이 가로 스크롤한다 */
.tw { overflow-x:auto; -webkit-overflow-scrolling:touch; margin:.6rem 0; }
table { border-collapse:collapse; font-size:.82rem; min-width:100%; }
th, td { border-bottom:1px solid var(--line); padding:.4rem .55rem; text-align:left;
  vertical-align:top; white-space:nowrap; }
th { background:var(--card); font-weight:600; position:sticky; top:0; }
/* 단지명처럼 긴 값은 줄바꿈을 허용해 표가 지나치게 넓어지지 않게 한다 */
td:nth-child(3) { white-space:normal; min-width:9rem; }
tbody tr:nth-child(even) td { background:rgba(127,127,127,.05); }
pre { white-space:pre-wrap; background:var(--card); padding:1rem; border-radius:6px; font-size:.85rem; }
.warn { color:var(--warn); font-weight:600; }
.failures { border:1px solid var(--line); border-radius:6px; padding:.8rem; }
.failures h2 { border:0; color:var(--warn); }
.failures li { color:var(--muted); font-size:.85rem; }
footer { color:var(--muted); font-size:.78rem; border-top:1px solid var(--line); padding-top:.8rem; }
`.trim();

export function renderHtml(input: RenderInput): string {
  const title = `${input.date} ${input.domain.label} 브리핑`;
  const comment =
    input.summary.kind === "structured" &&
    input.summary.brief.dashboardComment.trim().length > 0
      ? `<p class="comment">${escapeHtml(input.summary.brief.dashboardComment)}</p>`
      : "";

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
<h1>${input.domain.emoji} ${escapeHtml(input.domain.label)}</h1>
<span class="date">${escapeHtml(input.date)} KST</span>
</header>
${renderDashboard(input.dashboard)}
${comment}
<main>
${renderNarrative(input.summary)}
${renderFailures(input.failedSources)}
</main>
<footer>생성 ${escapeHtml(input.generatedAt)} · 자동 생성된 요약이며 투자 권유가 아닙니다.</footer>
</body>
</html>
`;
}
