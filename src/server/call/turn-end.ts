export class TurnEnd {
  private timer?: ReturnType<typeof setTimeout>;
  private lastVoice = 0;
  private pending = "";
  private partialOpen = false;
  constructor(
    private submit: (text: string) => void,
    private locale: string,
  ) {}

  voice() {
    this.lastVoice = Date.now();
    if (this.pending) this.schedule();
  }
  partial() {
    this.partialOpen = true;
    clearTimeout(this.timer);
  }
  final(text: string) {
    this.partialOpen = false;
    const separator = this.locale.startsWith("zh") ? "" : " ";
    this.pending = [this.pending, text.trim()]
      .filter(Boolean)
      .join(separator)
      .slice(0, 4000);
    this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    if (!this.pending || this.partialOpen) return;
    this.timer = setTimeout(
      () => {
        const text = this.pending;
        this.pending = "";
        this.submit(text);
      },
      Math.max(0, this.lastVoice + 650 - Date.now()),
    );
  }
  close() {
    clearTimeout(this.timer);
    this.pending = "";
  }
}

// Segments retain their exact offsets in the original model text for delivery receipts.
export function splitSpeech(text: string) {
  const complete: string[] = [];
  let tail = text;
  while (tail.length) {
    const punctuation = /[。！？!?\n]|\.(?=\s|$)/u.exec(tail);
    let end = punctuation ? punctuation.index + 1 : 0;
    if ((!end || end > 120) && tail.length >= 120) {
      const prefix = tail.slice(0, 120);
      const pause = Math.max(
        prefix.lastIndexOf(" "),
        prefix.lastIndexOf(","),
        prefix.lastIndexOf("，"),
      );
      end =
        pause > 40 ? pause + 1 : /[\uD800-\uDBFF]$/.test(prefix) ? 119 : 120;
    }
    if (!end) break;
    complete.push(tail.slice(0, end));
    tail = tail.slice(end);
  }
  return { complete, tail };
}
