/**
 * 청약홈 전 공급유형 수집기 (공공데이터포털 / 한국부동산원 청약홈).
 *
 * 청약홈은 LH·SH·GH를 포함한 모든 공급기관의 공고를 모아 제공한다.
 * 여기서 5개 API를 전부 받아 한 곳에 모은다.
 *   APT 분양       — 민간분양·공공분양 모두 포함 (HOUSE_SECD_NM으로 구분)
 *   무순위/잔여세대 — 통장 순위와 무관해 사용자 우선순위 1순위다
 *   오피스텔/도시형/민간임대 — 아파트보다 후순위
 *   경쟁률 2종      — 인기순위 산출용
 *
 * 정렬: 아파트 우선, 그다음 접수 시작일 순. 오피스텔류는 뒤로 보낸다.
 *
 * 서비스키는 Encoding 키를 그대로 쿼리에 붙인다 (DECISIONS #22).
 * 값이 없는 칸을 null로 주므로 스키마를 nullable로 둔다.
 */
import { z } from "zod";
import { dataGoKrConfig } from "../../config.js";
import { fetchJson } from "../../http.js";
import { kstDateString } from "../../date.js";
import { type Collector, type CollectResult, toResult } from "../types.js";

const BASE = "https://api.odcloud.kr/api";

/** 공급유형별 엔드포인트. kind는 사용자 우선순위 판정에 그대로 쓰인다 */
const SOURCES = [
  {
    kind: "APT",
    label: "APT 분양",
    path: "ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail",
    priority: 1,
  },
  {
    kind: "무순위/잔여",
    label: "무순위·잔여세대",
    path: "ApplyhomeInfoDetailSvc/v1/getRemndrLttotPblancDetail",
    priority: 0, // 통장 순위 무관 — 가장 먼저 본다
  },
  {
    kind: "오피스텔/도시형",
    label: "오피스텔·도시형·민간임대",
    path: "ApplyhomeInfoDetailSvc/v1/getUrbtyOfctlLttotPblancDetail",
    priority: 2,
  },
] as const;

const COMPET_SOURCES = [
  { kind: "APT", path: "ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet" },
  { kind: "무순위/잔여", path: "ApplyhomeInfoCmpetRtSvc/v1/getRemndrLttotPblancCmpet" },
] as const;

/** 최근 공고만 보면 되므로 페이지 하나로 끊는다 */
const PER_PAGE = 300;
/** 접수 예정을 며칠 앞까지 볼지 */
const UPCOMING_DAYS = 28;
/** 마감 임박 알림 기준일 */
export const DEADLINE_ALERTS = [7, 3, 1, 0] as const;
/** 인기순위에 넣을 최대 건수 */
const TOP_COMPETITION = 12;

/** 공공데이터포털은 값이 없는 칸을 null로 준다 */
const nv = z.union([z.string(), z.number()]).nullish();

const detailRow = z
  .object({
    HOUSE_NM: nv,
    HOUSE_SECD_NM: nv,
    HOUSE_DTL_SECD_NM: nv,
    RENT_SECD_NM: nv,
    HSSPLY_ADRES: nv,
    SUBSCRPT_AREA_CODE_NM: nv,
    RCRIT_PBLANC_DE: nv,
    RCEPT_BGNDE: nv,
    RCEPT_ENDDE: nv,
    GNRL_RCEPT_BGNDE: nv,
    GNRL_RCEPT_ENDDE: nv,
    SUBSCRPT_RCEPT_BGNDE: nv,
    SUBSCRPT_RCEPT_ENDDE: nv,
    SPSPLY_RCEPT_BGNDE: nv,
    SPSPLY_RCEPT_ENDDE: nv,
    GNRL_RNK1_CRSPAREA_RCPTDE: nv,
    GNRL_RNK1_CRSPAREA_ENDDE: nv,
    PRZWNER_PRESNATN_DE: nv,
    CNTRCT_CNCLS_BGNDE: nv,
    CNTRCT_CNCLS_ENDDE: nv,
    MVN_PREARNGE_YM: nv,
    TOT_SUPLY_HSHLDCO: nv,
    BSNS_MBY_NM: nv,
    CNSTRCT_ENTRPS_NM: nv,
    PBLANC_URL: nv,
    HMPG_ADRES: nv,
    MDAT_TRGET_AREA_SECD: nv,
    SPECLT_RDN_EARTH_AT: nv,
    PARCPRC_ULS_AT: nv,
    HOUSE_MANAGE_NO: nv,
    PBLANC_NO: nv,
  })
  .passthrough();

const detailSchema = z.object({ data: z.array(detailRow) });

const competRow = z
  .object({
    HOUSE_MANAGE_NO: nv,
    PBLANC_NO: nv,
    HOUSE_TY: nv,
    SUPLY_HSHLDCO: nv,
    REQ_CNT: nv,
    CMPET_RATE: nv,
    SUBSCRPT_RANK_CODE: nv,
    RESIDE_SENM: nv,
  })
  .passthrough();

const competSchema = z.object({ data: z.array(competRow) });

const s = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

export interface ApplyNotice {
  kind: string;
  /** 민영/국민 등 (HOUSE_SECD_NM) */
  houseType: string;
  /** 민간분양/공공분양 구분 근거 (HOUSE_DTL_SECD_NM) */
  detailType: string;
  /** 분양/임대 (RENT_SECD_NM) */
  rentType: string;
  name: string;
  address: string;
  /** 청약 지역 (서울/경기 등) */
  area: string;
  noticeDate: string;
  /** 일반공급 접수 시작 — 유형마다 필드가 달라 여기서 통일한다 */
  receiptStart: string;
  receiptEnd: string;
  /** 특별공급 접수 */
  specialStart: string;
  specialEnd: string;
  winnerDate: string;
  contractStart: string;
  contractEnd: string;
  moveIn: string;
  totalUnits: string;
  builder: string;
  /** 공식 모집공고 링크 (PBLANC_URL) */
  noticeUrl: string;
  /** 청약홈 신청·상세 페이지 링크 */
  applyUrl: string;
  homepage: string;
  /** 규제지역 여부 근거 */
  regulatedArea: string;
  priceCapApplied: string;
  /** 마감까지 남은 일수. 음수면 이미 종료 */
  daysToDeadline: number | null;
  /** 서울 공고인지 — 별도 표로 올린다 */
  isSeoul: boolean;
  key: string;
}

export interface CompetitionRow {
  kind: string;
  houseName: string;
  area: string;
  houseType: string;
  supplyUnits: number;
  applicants: number;
  rate: number;
  rank: string;
}

export interface ApplyhomeData {
  /** 오늘 (KST) */
  today: string;
  /** 접수 예정·진행 중. 아파트 우선, 무순위 최우선 */
  notices: ApplyNotice[];
  /** 서울 공고만 별도로 (없으면 빈 배열 — 그 사실도 브리핑에 명시한다) */
  seoul: ApplyNotice[];
  /** 마감 임박 (D-7/D-3/D-1/당일) */
  deadlineAlerts: { days: number; notice: ApplyNotice }[];
  /** 경쟁률 인기순위 (높은 순) */
  competitionTop: CompetitionRow[];
  note: string;
}

async function fetchAll(path: string, key: string, label: string): Promise<unknown> {
  return fetchJson(
    `${BASE}/${path}?page=1&perPage=${PER_PAGE}&serviceKey=${key}`,
    {},
    label,
  );
}

/** YYYY-MM-DD 두 날짜의 일수 차 (b - a) */
function dayDiff(a: string, b: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * 청약홈 상세·신청 페이지 링크.
 * 공고 관리번호와 공고번호로 조립한다 — 유형마다 경로가 다르다.
 */
function applyUrlOf(kind: string, manageNo: string, pblancNo: string): string {
  if (!manageNo || !pblancNo) return "https://www.applyhome.co.kr/";
  const q = `houseManageNo=${encodeURIComponent(manageNo)}&pblancNo=${encodeURIComponent(pblancNo)}`;
  if (kind === "무순위/잔여") {
    return `https://www.applyhome.co.kr/ap/apa/selectRemndrLttotPblancDetailView.do?${q}`;
  }
  if (kind === "오피스텔/도시형") {
    return `https://www.applyhome.co.kr/ap/apo/selectUrbtyOfctlPblancDetailView.do?${q}`;
  }
  return `https://www.applyhome.co.kr/ap/apa/selectAPTLttotPblancDetailView.do?${q}`;
}

function toNotice(
  row: z.infer<typeof detailRow>,
  kind: string,
  today: string,
): ApplyNotice {
  // 유형마다 접수일 필드명이 다르다. 있는 것 중 첫 값을 쓴다.
  // 무순위/잔여는 GNRL_*가 비어 있고 SUBSCRPT_*에만 값이 있다 (2026-08-06 실측).
  const start =
    s(row.RCEPT_BGNDE) ||
    s(row.GNRL_RCEPT_BGNDE) ||
    s(row.SUBSCRPT_RCEPT_BGNDE) ||
    s(row.GNRL_RNK1_CRSPAREA_RCPTDE);
  const end =
    s(row.RCEPT_ENDDE) ||
    s(row.GNRL_RCEPT_ENDDE) ||
    s(row.SUBSCRPT_RCEPT_ENDDE) ||
    s(row.GNRL_RNK1_CRSPAREA_ENDDE);
  const area = s(row.SUBSCRPT_AREA_CODE_NM);

  return {
    kind,
    houseType: s(row.HOUSE_SECD_NM),
    detailType: s(row.HOUSE_DTL_SECD_NM),
    rentType: s(row.RENT_SECD_NM),
    name: s(row.HOUSE_NM),
    address: s(row.HSSPLY_ADRES),
    area,
    noticeDate: s(row.RCRIT_PBLANC_DE),
    receiptStart: start,
    receiptEnd: end,
    specialStart: s(row.SPSPLY_RCEPT_BGNDE),
    specialEnd: s(row.SPSPLY_RCEPT_ENDDE),
    winnerDate: s(row.PRZWNER_PRESNATN_DE),
    contractStart: s(row.CNTRCT_CNCLS_BGNDE),
    contractEnd: s(row.CNTRCT_CNCLS_ENDDE),
    moveIn: s(row.MVN_PREARNGE_YM),
    totalUnits: s(row.TOT_SUPLY_HSHLDCO),
    builder: s(row.CNSTRCT_ENTRPS_NM) || s(row.BSNS_MBY_NM),
    noticeUrl: s(row.PBLANC_URL),
    applyUrl: applyUrlOf(kind, s(row.HOUSE_MANAGE_NO), s(row.PBLANC_NO)),
    homepage: s(row.HMPG_ADRES),
    regulatedArea: s(row.MDAT_TRGET_AREA_SECD),
    priceCapApplied: s(row.PARCPRC_ULS_AT),
    daysToDeadline: end ? dayDiff(today, end) : null,
    isSeoul: area.includes("서울") || s(row.HSSPLY_ADRES).includes("서울"),
    key: `${s(row.HOUSE_MANAGE_NO)}-${s(row.PBLANC_NO)}`,
  };
}

const num = (v: unknown): number => {
  const n = Number(s(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export const applyhomeCollector: Collector<ApplyhomeData> = {
  name: "applyhome",
  async collect(): Promise<CollectResult<ApplyhomeData>> {
    return toResult(async () => {
      const { DATA_GO_KR_SERVICE_KEY } = dataGoKrConfig();
      const today = kstDateString();
      const horizon = kstDateString(new Date(Date.now() + UPCOMING_DAYS * 86_400_000));

      const [details, compets] = await Promise.all([
        Promise.allSettled(
          SOURCES.map((src) =>
            fetchAll(src.path, DATA_GO_KR_SERVICE_KEY, `applyhome:${src.kind}`).then(
              (raw) => ({ src, rows: detailSchema.parse(raw).data }),
            ),
          ),
        ),
        Promise.allSettled(
          COMPET_SOURCES.map((src) =>
            fetchAll(src.path, DATA_GO_KR_SERVICE_KEY, `compet:${src.kind}`).then(
              (raw) => ({ src, rows: competSchema.parse(raw).data }),
            ),
          ),
        ),
      ]);

      const priorityOf = new Map<string, number>(
        SOURCES.map((x) => [x.kind, x.priority]),
      );

      const all: ApplyNotice[] = details.flatMap((r) =>
        r.status === "fulfilled"
          ? r.value.rows.map((row) => toNotice(row, r.value.src.kind, today))
          : [],
      );

      // 접수가 아직 안 끝났고 곧 시작하는 공고만 남긴다
      const notices = all
        .filter(
          (n) =>
            n.receiptEnd !== "" &&
            n.receiptEnd >= today &&
            (n.receiptStart === "" || n.receiptStart <= horizon),
        )
        .sort((a, b) => {
          // 1) 무순위 → APT → 오피스텔  2) 접수 시작 빠른 순
          const pa = priorityOf.get(a.kind) ?? 9;
          const pb = priorityOf.get(b.kind) ?? 9;
          if (pa !== pb) return pa - pb;
          return a.receiptStart.localeCompare(b.receiptStart);
        });

      const deadlineAlerts = notices
        .filter((n) => n.daysToDeadline !== null && DEADLINE_ALERTS.includes(
          n.daysToDeadline as (typeof DEADLINE_ALERTS)[number],
        ))
        .map((n) => ({ days: n.daysToDeadline as number, notice: n }))
        .sort((a, b) => a.days - b.days);

      // 경쟁률은 단지명을 알아야 읽히므로 공고 목록과 키로 이어붙인다
      const nameByKey = new Map(all.map((n) => [n.key, n]));
      const competitionTop: CompetitionRow[] = compets
        .flatMap((r) =>
          r.status === "fulfilled"
            ? r.value.rows.map((row) => {
                const hit = nameByKey.get(
                  `${s(row.HOUSE_MANAGE_NO)}-${s(row.PBLANC_NO)}`,
                );
                return {
                  kind: r.value.src.kind,
                  houseName: hit?.name ?? s(row.HOUSE_MANAGE_NO),
                  area: hit?.area ?? "",
                  houseType: s(row.HOUSE_TY),
                  supplyUnits: num(row.SUPLY_HSHLDCO),
                  applicants: num(row.REQ_CNT),
                  rate: num(row.CMPET_RATE),
                  rank: s(row.SUBSCRPT_RANK_CODE),
                };
              })
            : [],
        )
        .filter((c) => c.rate > 0)
        .sort((a, b) => b.rate - a.rate)
        .slice(0, TOP_COMPETITION);

      if (notices.length === 0 && competitionTop.length === 0) {
        const reasons = [...details, ...compets]
          .map((r) => (r.status === "rejected" ? String(r.reason).slice(0, 100) : ""))
          .filter(Boolean)
          .join(" / ");
        throw new Error(`청약 데이터 0건${reasons ? ` — ${reasons}` : ""}`);
      }

      const seoul = notices.filter((n) => n.isSeoul);
      console.log(
        `[applyhome] 진행/예정 ${notices.length}건 (서울 ${seoul.length}) / ` +
          `마감임박 ${deadlineAlerts.length} / 경쟁률 ${competitionTop.length}`,
      );

      return {
        today,
        notices: notices.slice(0, 30),
        seoul,
        deadlineAlerts,
        competitionTop,
        note:
          "청약홈 집계이므로 LH·SH·GH 등 공급기관 공고가 모두 포함된다. " +
          "분양가·대출조건·자산기준은 이 API에 없다 — 공고 URL로 확인해야 하며 추정하지 말 것.",
      };
    });
  },
};
