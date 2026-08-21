// Inline-кнопки под сообщением "занял мероприятие".
export type ButtonAction = "kd" | "kd_prompt" | "rollback" | "cancel";

export function buildEventKeyboard(entryId: number): string {
  const payload = (action: ButtonAction) => JSON.stringify({ action, entryId });
  return JSON.stringify({
    inline: true,
    buttons: [
      [
        { action: { type: "callback", label: "КД", payload: payload("kd") }, color: "positive" },
        { action: { type: "callback", label: "Написать КД", payload: payload("kd_prompt") }, color: "positive" },
      ],
      [
        { action: { type: "callback", label: "Откат", payload: payload("rollback") }, color: "negative" },
        { action: { type: "callback", label: "Аннулировать", payload: payload("cancel") }, color: "negative" },
      ],
    ],
  });
}

/** Пустая клавиатура — используется, чтобы убрать кнопки из уже отправленного сообщения. */
export function buildEmptyKeyboard(): string {
  return JSON.stringify({ inline: true, buttons: [] });
}