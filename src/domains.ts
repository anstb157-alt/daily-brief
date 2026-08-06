/**
 * 도메인별 설정.
 *
 * 파이프라인 로직은 runPipeline(domain) 하나로 통일하고,
 * 주식/부동산의 차이는 전부 이 객체로 주입한다 (DECISIONS #2).
 * 도메인이 늘어도 파이프라인 코드를 복사하지 않는다.
 */

export type DomainId = "stock" | "realestate" | "chungyak";

export interface DomainConfig {
  readonly id: DomainId;
  /** 카톡 헤딩·HTML 제목에 쓰는 라벨 */
  readonly label: string;
  /** 카톡 헤딩 앞머리 이모지 */
  readonly emoji: string;
  /** 시스템 프롬프트 경로 */
  readonly promptPath: string;
  /** Pages 출력 디렉터리 (베이스 URL 기준 상대) */
  readonly outputDir: string;
}

export const DOMAINS: Record<DomainId, DomainConfig> = {
  stock: {
    id: "stock",
    label: "증시",
    emoji: "📈",
    promptPath: "prompts/stock.md",
    outputDir: "stock",
  },
  realestate: {
    id: "realestate",
    label: "부동산",
    emoji: "🏠",
    promptPath: "prompts/realestate.md",
    outputDir: "realestate",
  },
  chungyak: {
    id: "chungyak",
    label: "청약",
    emoji: "📒",
    promptPath: "prompts/chungyak.md",
    outputDir: "chungyak",
  },
};
