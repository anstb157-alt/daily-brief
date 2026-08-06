/**
 * 오늘(KST) 경제지표·연준 일정 수집기.
 *
 * 소스: ForexFactory 주간 캘린더 JSON 미러 (인증 없음, 무료).
 * 비공식 미러 도메인이라 예고 없이 바뀔 수 있다 — 실패 시 "데이터 없음"으로 넘어간다.
 *
 * 주간 파일이므로 오늘 하루치를 KST 기준으로 걸러낸다.
 * KST 08:40 실행 시점은 ET로 전날 저녁이고, 이 파일의 주는 ET 일요일에 시작하므로
 * KST 월요일 아침에도 당일 항목이 이미 포함돼 있다.
 *
 * 실적 발표 일정은 여기 없다 — earnings.ts(별도 단계)가 담당한다.
 */
import { z } from "zod";
import { BROWSER_UA, fetchJson } from "../http.js";
import { KST, kstDateString, kstTimeString } from "../date.js";
import { type Collector, type CollectResult, toResult } from "./types.js";

/** 이번 주 + 다음 주를 함께 받아 "오늘"과 "예정"을 모두 채운다 */
const SOURCE_URLS = [
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
  "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
] as const;

/** 예정 일정 표시 범위 (오늘 이후 며칠까지) */
const UPCOMING_DAYS = 14;
/** 예정 일정은 High만 — Medium까지 넣으면 목록이 길어져 안 읽힌다 */
const UPCOMING_IMPACTS = new Set(["High"]);

/** 한국 개인투자자에게 유의미한 통화권만 남긴다. "All"은 OPEC 회의 등 전역 이벤트 */
const KEEP_COUNTRIES = new Set(["USD", "KRW", "All"]);
/** Low는 노이즈가 커서 제외. Holiday는 휴장 여부라 유지 */
const KEEP_IMPACTS = new Set(["High", "Medium", "Holiday"]);

const entrySchema = z.object({
  title: z.string(),
  country: z.string(),
  date: z.string(),
  impact: z.string(),
  forecast: z.string(),
  previous: z.string(),
});

const feedSchema = z.array(entrySchema);

export interface CalendarEvent {
  /** KST HH:mm. 종일 이벤트는 빈 문자열 */
  timeKst: string;
  title: string;
  country: string;
  impact: string;
  /** 컨센서스 (없으면 빈 문자열) */
  forecast: string;
  previous: string;
}

export interface UpcomingEvent extends CalendarEvent {
  /** KST 기준 날짜 (YYYY-MM-DD) */
  date: string;
}

export interface CalendarData {
  /** 기준 날짜 (KST, YYYY-MM-DD) */
  date: string;
  events: CalendarEvent[];
  /** 오늘 이후 주요 일정 (High only) */
  upcoming: UpcomingEvent[];
}

export const calendarCollector: Collector<CalendarData> = {
  name: "calendar",
  async collect(): Promise<CollectResult<CalendarData>> {
    return toResult(async () => {
      // 다음 주 파일이 없거나 실패해도 오늘 일정은 살려야 한다
      const settled = await Promise.allSettled(
        SOURCE_URLS.map((url) =>
          fetchJson(
            url,
            { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } },
            `forexfactory:${url.endsWith("nextweek.json") ? "nextweek" : "thisweek"}`,
          ),
        ),
      );
      const feed = settled.flatMap((r) =>
        r.status === "fulfilled" ? feedSchema.parse(r.value) : [],
      );
      if (feed.length === 0) {
        throw new Error("주간 캘린더를 모두 받지 못했다");
      }

      const today = kstDateString();
      const toEvent = (e: z.infer<typeof entrySchema>): CalendarEvent => ({
        // Holiday 등 종일 이벤트는 소스가 00:00 근처로 주므로 시각 표기를 생략한다
        timeKst: e.impact === "Holiday" ? "" : kstTimeString(new Date(e.date)),
        title: e.title,
        country: e.country,
        impact: e.impact,
        forecast: e.forecast,
        previous: e.previous,
      });

      const events = feed
        .filter(
          (e) =>
            KEEP_COUNTRIES.has(e.country) &&
            KEEP_IMPACTS.has(e.impact) &&
            kstDateString(new Date(e.date)) === today,
        )
        .map(toEvent)
        .sort((a, b) => a.timeKst.localeCompare(b.timeKst));

      const horizon = kstDateString(
        new Date(Date.now() + UPCOMING_DAYS * 86_400_000),
      );
      const upcoming = feed
        .filter((e) => {
          const d = kstDateString(new Date(e.date));
          return (
            KEEP_COUNTRIES.has(e.country) &&
            UPCOMING_IMPACTS.has(e.impact) &&
            d > today &&
            d <= horizon
          );
        })
        .map<UpcomingEvent>((e) => ({
          ...toEvent(e),
          date: kstDateString(new Date(e.date)),
        }))
        .sort((a, b) => `${a.date}${a.timeKst}`.localeCompare(`${b.date}${b.timeKst}`));

      console.log(
        `[calendar] ${today}(${KST}) 오늘 ${events.length}건 / 예정 ${upcoming.length}건 / 전체 ${feed.length}건`,
      );

      return { date: today, events, upcoming };
    });
  },
};
