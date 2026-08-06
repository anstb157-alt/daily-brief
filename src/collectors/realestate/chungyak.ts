/**
 * 청약홈 분양정보·경쟁률 수집기 (공공데이터포털 / 한국부동산원).
 *
 * 두 API를 함께 본다.
 *   - 분양정보: 모집공고일·청약 접수일 등 일정
 *   - 경쟁률:   최근 마감 단지의 경쟁률
 *
 * 서비스키는 Encoding 키를 그대로 쿼리에 붙인다.
 * Decoding 키를 다시 인코딩하거나 Authorization 헤더로 보내면 -4(등록되지 않은 인증키)가 난다
 * (2026-08-06 실측).
 *
 * 개발계정 쿼터는 일 1,000건 내외다. 하루 2회 호출이라 여유가 크다.
 */
import { z } from "zod";
import { dataGoKrConfig } from "../../config.js";
import { fetchJson } from "../../http.js";
import { kstDateString } from "../../date.js";
import { type Collector, type CollectResult, toResult } from "../types.js";

const DETAIL_URL =
  "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail";
const COMPET_URL =
  "https://api.odcloud.kr/api/ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet";

/** 한 번에 받아올 건수. 최근 것만 보면 되므로 크게 잡지 않는다 */
const PER_PAGE = 100;
/** 청약 일정을 며칠 앞까지 볼지 */
const UPCOMING_DAYS = 21;

/** 공공데이터포털은 값이 없는 칸을 null로 준다 — optional만으론 부족하다 */
const nstr = z.union([z.string(), z.number()]).nullish();

const detailSchema = z.object({
  data: z.array(
    z
      .object({
        HOUSE_NM: nstr,
        HSSPLY_ADRES: nstr,
        RCRIT_PBLANC_DE: nstr,
        RCEPT_BGNDE: nstr,
        RCEPT_ENDDE: nstr,
        SPSPLY_RCEPT_BGNDE: nstr,
        BSNS_MBY_NM: nstr,
        CNSTRCT_ENTRPS_NM: nstr,
        TOT_SUPLY_HSHLDCO: nstr,
      })
      .passthrough(),
  ),
});

const competSchema = z.object({
  data: z.array(
    z
      .object({
        HOUSE_MANAGE_NO: nstr,
        HOUSE_NM: nstr,
        RCRIT_PBLANC_DE: nstr,
        HOUSE_TY: nstr,
        SUPLY_HSHLDCO: nstr,
        REQ_CNT: nstr,
        CMPET_RATE: nstr,
      })
      .passthrough(),
  ),
});

export interface ChungyakSchedule {
  name: string;
  address: string;
  /** 모집공고일 */
  noticeDate: string;
  /** 1순위 접수 시작 */
  receiptStart: string;
  receiptEnd: string;
  builder: string;
  totalUnits: string;
}

export interface ChungyakCompetition {
  name: string;
  noticeDate: string;
  houseType: string;
  supplyUnits: string;
  applicants: string;
  rate: string;
}

export interface ChungyakData {
  /** 앞으로 접수 예정·진행 중인 단지 */
  upcoming: ChungyakSchedule[];
  /** 최근 발표된 경쟁률 */
  recentCompetition: ChungyakCompetition[];
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

async function fetchPage(url: string, serviceKey: string, label: string) {
  // 서비스키는 이미 URL 인코딩된 상태이므로 다시 인코딩하지 않는다
  return fetchJson(
    `${url}?page=1&perPage=${PER_PAGE}&serviceKey=${serviceKey}`,
    {},
    label,
  );
}

export const chungyakCollector: Collector<ChungyakData> = {
  name: "chungyak",
  async collect(): Promise<CollectResult<ChungyakData>> {
    return toResult(async () => {
      const { DATA_GO_KR_SERVICE_KEY } = dataGoKrConfig();
      const today = kstDateString();
      const horizon = kstDateString(new Date(Date.now() + UPCOMING_DAYS * 86_400_000));

      const [detailRaw, competRaw] = await Promise.allSettled([
        fetchPage(DETAIL_URL, DATA_GO_KR_SERVICE_KEY, "chungyak:detail"),
        fetchPage(COMPET_URL, DATA_GO_KR_SERVICE_KEY, "chungyak:compet"),
      ]);

      const upcoming: ChungyakSchedule[] =
        detailRaw.status === "fulfilled"
          ? detailSchema
              .parse(detailRaw.value)
              .data.map<ChungyakSchedule>((d) => ({
                name: str(d.HOUSE_NM),
                address: str(d.HSSPLY_ADRES),
                noticeDate: str(d.RCRIT_PBLANC_DE),
                receiptStart: str(d.RCEPT_BGNDE),
                receiptEnd: str(d.RCEPT_ENDDE),
                builder: str(d.CNSTRCT_ENTRPS_NM) || str(d.BSNS_MBY_NM),
                totalUnits: str(d.TOT_SUPLY_HSHLDCO),
              }))
              // 접수가 아직 안 끝난 단지만 — 지난 공고는 브리핑에 쓸모가 없다
              .filter((s) => s.receiptEnd >= today && s.receiptStart <= horizon)
              .sort((a, b) => a.receiptStart.localeCompare(b.receiptStart))
              .slice(0, 10)
          : [];

      const recentCompetition: ChungyakCompetition[] =
        competRaw.status === "fulfilled"
          ? competSchema
              .parse(competRaw.value)
              .data.map<ChungyakCompetition>((d) => ({
                name: str(d.HOUSE_NM),
                noticeDate: str(d.RCRIT_PBLANC_DE),
                houseType: str(d.HOUSE_TY),
                supplyUnits: str(d.SUPLY_HSHLDCO),
                applicants: str(d.REQ_CNT),
                rate: str(d.CMPET_RATE),
              }))
              .sort((a, b) => b.noticeDate.localeCompare(a.noticeDate))
              .slice(0, 10)
          : [];

      if (upcoming.length === 0 && recentCompetition.length === 0) {
        const reasons = [detailRaw, competRaw]
          .map((r) => (r.status === "rejected" ? String(r.reason).slice(0, 120) : ""))
          .filter(Boolean)
          .join(" / ");
        throw new Error(`청약 데이터 0건${reasons ? ` — ${reasons}` : ""}`);
      }

      console.log(
        `[chungyak] 접수예정 ${upcoming.length}건 / 경쟁률 ${recentCompetition.length}건`,
      );
      return { upcoming, recentCompetition };
    });
  },
};
