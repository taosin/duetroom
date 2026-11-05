import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./memories.css";

interface Props {
  companionId: string;
  locale: string;
}
interface Source {
  turnId: string;
  role: "user" | "assistant";
}
interface Preview {
  text: string;
  createdAt: number;
  timeZone: string;
}
interface Memory extends Preview {
  id: string;
  pinned: boolean;
}

const copy = {
  zh: {
    remember: "记住",
    remembered: "已记住",
    memories: "记忆",
    preview: "保存这条记忆",
    edit: "修改",
    fact: "希望记住的事",
    save: "保存",
    cancel: "取消",
    close: "关闭",
    remove: "删除",
    pin: "置顶",
    unpin: "取消置顶",
    empty: "还没有记忆。在消息旁点「记住」即可保存。",
    loading: "正在读取…",
    source: "来源消息",
    failed: "操作失败，请稍后重试。",
    capacity: "已存满 30 条记忆。删去一条后就能继续保存。",
    expired: "登录已过期，请刷新页面后重新登录。",
    missing: "来源或记忆已被删除。",
    invalid: "请输入 1 到 200 个字。",
    retry: "重试",
  },
  en: {
    remember: "Remember",
    remembered: "Saved to memory",
    memories: "Memories",
    preview: "Save a memory",
    edit: "Edit",
    fact: "What to remember",
    save: "Save",
    cancel: "Cancel",
    close: "Close",
    remove: "Delete",
    pin: "Pin",
    unpin: "Unpin",
    empty: "No memories yet. Select “Remember” beside a message to save one.",
    loading: "Loading…",
    source: "Source message",
    failed: "Couldn’t complete this action. Please try again.",
    capacity: "All 30 memories are in use. Delete one to make room.",
    expired: "Your session expired. Reload the page to sign in.",
    missing: "This message or memory has been deleted.",
    invalid: "Enter 1 to 200 characters.",
    retry: "Retry",
  },
};
type Strings = typeof copy.en;
const words = (locale: string): Strings =>
  locale.startsWith("zh") ? copy.zh : copy.en;
const base = (id: string) =>
  "/api/companions/" + encodeURIComponent(id) + "/memories";

class RequestFailure extends Error {
  constructor(readonly status: number) {
    super("Memory request failed");
  }
}
async function request<T>(
  path: string,
  method = "GET",
  body?: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    signal,
    ...(body && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  if (!response.ok) throw new RequestFailure(response.status);
  return response.status === 204 ? (undefined as T) : response.json();
}
function describe(error: unknown, t: Strings) {
  if (error instanceof RequestFailure) {
    if (error.status === 401) return t.expired;
    if (error.status === 409) return t.capacity;
    if (error.status === 404) return t.missing;
    if (error.status === 400) return t.invalid;
  }
  return t.failed;
}

function Dialog({
  title,
  closeLabel,
  onClose,
  children,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = ref.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="memory-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="topline">
        <h2 id={titleId}>{title}</h2>
        <button
          className="quiet"
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Origin({ row, locale }: { row: Preview; locale: string }) {
  return (
    <small className="memory-origin">
      {words(locale).source} ·{" "}
      {new Intl.DateTimeFormat(locale, {
        timeZone: row.timeZone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(row.createdAt)}{" "}
      · {row.timeZone}
    </small>
  );
}
function Editor({
  draft,
  setDraft,
  submit,
  cancel,
  busy,
  t,
}: {
  draft: string;
  setDraft: (value: string) => void;
  submit: () => void;
  cancel: () => void;
  busy: boolean;
  t: Strings;
}) {
  const length = [...draft.trim()].length;
  return (
    <form
      className="memory-editor"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label>
        {t.fact}
        <textarea
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
        />
      </label>
      <div className="memory-editor-foot">
        <small aria-live="polite">{length} / 200</small>
        <button type="button" onClick={cancel} disabled={busy}>
          {t.cancel}
        </button>
        <button
          className="primary"
          disabled={busy || length < 1 || length > 200}
        >
          {t.save}
        </button>
      </div>
    </form>
  );
}

function PreviewDialog({
  companionId,
  locale,
  source,
  onClose,
  onSave,
}: Props & { source: Source; onClose: () => void; onSave: () => void }) {
  const t = words(locale);
  const [row, setRow] = useState<Preview>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { turnId, role } = source;
  useEffect(() => {
    const controller = new AbortController();
    request<Preview>(
      base(companionId) + "/preview",
      "POST",
      { turnId, role },
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setRow(value);
          setDraft(value.text);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(describe(e, t));
      });
    return () => controller.abort();
  }, [companionId, turnId, role, t]);
  const close = () => {
    if (!busy) onClose();
  };
  async function save() {
    setBusy(true);
    setError("");
    try {
      await request(base(companionId), "POST", { turnId, role, text: draft });
      onSave();
    } catch (e) {
      setError(describe(e, t));
      setBusy(false);
    }
  }
  return (
    <Dialog title={t.preview} closeLabel={t.close} onClose={close}>
      {row && (
        <>
          <Origin row={row} locale={locale} />
          <Editor
            t={t}
            draft={draft}
            setDraft={setDraft}
            busy={busy}
            cancel={close}
            submit={save}
          />
        </>
      )}
      {!row && !error && <p>{t.loading}</p>}
      {error && (
        <p className="feedback" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

export function Remember(props: Props & { source: Source }) {
  return (
    <RememberAction
      key={props.companionId + props.source.turnId + props.source.role}
      {...props}
    />
  );
}
function RememberAction(props: Props & { source: Source }) {
  const t = words(props.locale);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2500);
    return () => window.clearTimeout(timer);
  }, [saved]);
  return (
    <>
      <button
        type="button"
        className="memory-action quiet"
        onClick={() => setOpen(true)}
      >
        {t.remember}
      </button>
      {saved && <small role="status">{t.remembered}</small>}
      {open && (
        <PreviewDialog
          {...props}
          onClose={() => setOpen(false)}
          onSave={() => {
            setSaved(true);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function ListDialog({
  companionId,
  locale,
  onClose,
}: Props & { onClose: () => void }) {
  const t = words(locale);
  const path = base(companionId);
  const [rows, setRows] = useState<Memory[]>();
  const [error, setError] = useState("");
  const [version, refresh] = useState(0);
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    request<Memory[]>(path, "GET", undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setRows(value);
          setError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(describe(e, t));
      });
    return () => controller.abort();
  }, [path, version, t]);

  async function change(id: string, method: string, body?: object) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const value = await request<Memory>(
        path + "/" + encodeURIComponent(id),
        method,
        body,
      );
      setRows((previous) => {
        const list = (previous || []).filter((row) => row.id !== id);
        return method === "DELETE"
          ? list
          : [value, ...list].sort(
              (a, b) => Number(b.pinned) - Number(a.pinned),
            );
      });
      setEditing(undefined);
    } catch (e) {
      setError(describe(e, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={t.memories}
      closeLabel={t.close}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {error && (
        <div role="alert" className="feedback">
          {error}{" "}
          <button onClick={() => refresh((v) => v + 1)}>{t.retry}</button>
        </div>
      )}
      {!rows && !error && <p>{t.loading}</p>}
      {rows && !rows.length && <p className="subtle">{t.empty}</p>}
      {rows && rows.length > 0 && (
        <ul className="memory-list">
          {rows.map((row) => (
            <li key={row.id}>
              <Origin row={row} locale={locale} />
              {editing === row.id ? (
                <Editor
                  t={t}
                  draft={draft}
                  setDraft={setDraft}
                  busy={busy}
                  cancel={() => setEditing(undefined)}
                  submit={() => change(row.id, "PATCH", { text: draft })}
                />
              ) : (
                <>
                  <p className="memory-fact">{row.text}</p>
                  <div className="memory-tools">
                    <button
                      disabled={busy}
                      onClick={() => {
                        setDraft(row.text);
                        setEditing(row.id);
                      }}
                    >
                      {t.edit}
                    </button>
                    <button
                      disabled={busy}
                      aria-pressed={row.pinned}
                      onClick={() =>
                        change(row.id, "PATCH", { pinned: !row.pinned })
                      }
                    >
                      {row.pinned ? t.unpin : t.pin}
                    </button>
                    <button
                      className="quiet"
                      disabled={busy}
                      onClick={() => change(row.id, "DELETE")}
                    >
                      {t.remove}
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export function Memories({ companionId, locale }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {words(locale).memories}
      </button>
      {open && (
        <ListDialog
          key={companionId}
          companionId={companionId}
          locale={locale}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
