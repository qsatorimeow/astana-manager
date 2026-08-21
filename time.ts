// Все даты в системе хранятся как timestamp в мс (UTC).
// Эти функции нужны только для отображения/разбора времени по московскому часовому поясу.

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000; // МСК = UTC+3, без перехода на летнее время

/** Форматирует timestamp (мс, UTC) в строку "чч:мм" по московскому времени. */
export function formatMsk(ms: number): string {
  const mskDate = new Date(ms + MSK_OFFSET_MS);
  const hh = String(mskDate.getUTCHours()).padStart(2, "0");
  const mm = String(mskDate.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Парсит время в формате "чч:мм" (по МСК) в ближайший будущий timestamp (мс, UTC).
 * Если указанное время сегодня уже прошло — берётся завтрашний день.
 * Возвращает null, если строка не соответствует формату.
 */
export function parseMskTimeToTimestamp(text: string, afterMs: number = Date.now()): number | null {
  const match = text.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  const nowMsk = new Date(afterMs + MSK_OFFSET_MS);
  const candidateMsk = new Date(
    Date.UTC(
      nowMsk.getUTCFullYear(),
      nowMsk.getUTCMonth(),
      nowMsk.getUTCDate(),
      hours,
      minutes,
      0,
      0,
    ),
  );

  let candidateMs = candidateMsk.getTime() - MSK_OFFSET_MS;
  if (candidateMs <= afterMs) {
    candidateMs += 24 * 60 * 60 * 1000; // время уже прошло сегодня — переносим на завтра
  }
  return candidateMs;
}