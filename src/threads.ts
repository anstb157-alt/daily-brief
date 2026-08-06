/**
 * 열린 스레드 (어제 던진 질문 → 오늘 후속).
 *
 * state/open-threads.json에 도메인별로 전일 미해결 이슈를 저장한다.
 * 오늘 브리핑은 그 질문이 해소됐는지 판정하고, 새 질문을 다시 저장한다.
 * 스레드가 없으면 (첫 실행일 등) 해당 블록은 통째로 생략된다.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { DomainId } from "./domains.js";

const STATE_PATH = "state/open-threads.json";

const threadSchema = z.object({
  /** 질문을 던진 날 (KST YYYY-MM-DD) */
  askedOn: z.string(),
  question: z.string(),
});

const stateSchema = z.record(z.string(), threadSchema);

export type OpenThread = z.infer<typeof threadSchema>;

/** 해당 도메인의 전일 스레드. 없으면 null */
export async function loadThread(
  domain: DomainId,
): Promise<OpenThread | null> {
  try {
    const parsed = stateSchema.parse(
      JSON.parse(await readFile(STATE_PATH, "utf8")),
    );
    return parsed[domain] ?? null;
  } catch {
    // 파일이 없거나 깨졌으면 스레드 없음으로 취급한다 — 블록이 생략될 뿐이다
    return null;
  }
}

/** 오늘 새로 던진 질문을 저장한다. 다른 도메인의 값은 건드리지 않는다. */
export async function saveThread(
  domain: DomainId,
  thread: OpenThread,
): Promise<void> {
  let current: Record<string, OpenThread> = {};
  try {
    current = stateSchema.parse(JSON.parse(await readFile(STATE_PATH, "utf8")));
  } catch {
    current = {};
  }
  current[domain] = thread;
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}
