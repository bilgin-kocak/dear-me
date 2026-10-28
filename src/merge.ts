// Agents often split a long reply into several messages. Everything a chat sends
// in the 90 seconds after its first message becomes one letter. Held in memory only.

export const MERGE_WINDOW_MS = 90_000;

export function createMergeWindow<T extends { messageId: number }>(
  windowMs: number,
  onClose: (chatId: number, parts: T[]) => void | Promise<void>,
) {
  const open = new Map<number, { parts: T[]; timer: ReturnType<typeof setTimeout> }>();

  function close(chatId: number) {
    const w = open.get(chatId);
    if (!w) return;
    clearTimeout(w.timer);
    open.delete(chatId);
    return onClose(chatId, w.parts.sort((a, b) => a.messageId - b.messageId));
  }

  return {
    /** Returns true if this part opened a new window. */
    add(chatId: number, part: T): boolean {
      const w = open.get(chatId);
      if (w) {
        w.parts.push(part);
        return false;
      }
      open.set(chatId, { parts: [part], timer: setTimeout(() => close(chatId), windowMs) });
      return true;
    },
    /** Close the window early ("That's everything"). */
    close,
    /** Throw the window away without calling onClose. */
    discard(chatId: number) {
      const w = open.get(chatId);
      if (w) clearTimeout(w.timer);
      open.delete(chatId);
    },
    isOpen: (chatId: number) => open.has(chatId),
  };
}

export const mergeText = (parts: { text: string }[]) =>
  parts.map((p) => p.text.trim()).filter(Boolean).join("\n\n");
