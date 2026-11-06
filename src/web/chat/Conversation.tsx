import { ArrowUp, Ellipsis, Plus, Square, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { NativeSelect } from "../components/ui/native-select";
import { Textarea } from "../components/ui/textarea";
import { Button } from "../components/ui/button";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "./chat.css";

export type ChatSource = {
  turnId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  timeZone: string;
};
type Thread = { id: string; title: string; createdAt: number; active: boolean };
type Turn = {
  id: string;
  clientMessageId: string;
  userText: string;
  assistantText: string;
  status: "running" | "awaiting" | "interrupted" | "complete" | "failed";
  mode: "text" | "voice";
  createdAt: number;
  timeZone: string;
};
type ChatProps = {
  companion: {
    id: string;
    name: string;
    locale: string;
    persona: string;
    voice: string;
  };
  lang: "zh" | "en";
  renderCall?: (controls: {
    refresh: () => void;
    busy: boolean;
    conversationId?: string;
    setCallActive: (active: boolean) => void;
  }) => ReactNode;
  renderMessageAction?: (source: ChatSource) => ReactNode;
};

const copy = {
  zh: {
    you: "我",
    history: "聊天记录",
    empty: "从一句问候开始",
    first: (name: string) => "给" + name + "写下第一条消息。",
    older: "查看更早的消息",
    placeholder: (name: string) => "给" + name + "写消息…",
    send: "发送",
    stop: "停止回复",
    retry: "重新生成",
    loading: "正在读取聊天记录…",
    typing: "正在回复…",
    failed: "回复失败",
    interrupted: "已中断",
    missing:
      "文字模型尚未配置。请在服务端设置 DUET_MODEL_BASE_URL 和 DUET_MODEL_NAME。",
    model: "暂时无法连接文字模型。请检查模型服务，再重试。",
    busy: "另一个页面或通话正在使用这个角色，请稍后再发。",
    network: "连接已中断。重新连接后可查看已保存的消息。",
    reload: "重新连接",
    login: "登录已过期，请刷新页面重新登录。",
    clear: "清除聊天记录",
    confirm: "清除这段对话及其关联的记忆？",
    erase: "确认清除",
    cancel: "取消",
    voice: "通话",
    limit: "回复已达到长度上限。",
    invalid: "消息无法发送，请检查内容后重试。",
    conversation: "对话",
    check: "检查模型连接",
    working: "正在检查…",
    checked: "模型连接成功。",
    newChat: "新建对话",
    untitled: "新对话",
    choose: "切换对话",
    changed: "另一页面已切换对话。请确认当前对话后继续。",
    more: "对话选项",
    today: "今天",
    callActive: "通话中，挂断后可以打字。",
  },
  en: {
    you: "You",
    history: "Chat history",
    empty: "Start with a hello",
    first: (name: string) => "Write your first message to " + name + ".",
    older: "Load earlier messages",
    placeholder: (name: string) => "Message " + name + "…",
    send: "Send",
    stop: "Stop reply",
    retry: "Retry reply",
    loading: "Loading messages…",
    typing: "Replying…",
    failed: "Reply failed",
    interrupted: "Interrupted",
    missing:
      "Text model setup required. Set DUET_MODEL_BASE_URL and DUET_MODEL_NAME on the server.",
    model:
      "Could not reach the text model. Check the model service, then try again.",
    busy: "This companion is busy in another tab or call. Try again shortly.",
    network: "Connection lost. Reconnect to see your saved messages.",
    reload: "Reconnect",
    login: "Your session expired. Reload the page to sign in.",
    clear: "Clear chat history",
    confirm: "Clear this conversation and its linked memories?",
    erase: "Clear conversation",
    cancel: "Cancel",
    voice: "Call",
    limit: "The reply reached its length limit.",
    invalid: "Could not send this message. Check the contents and retry.",
    conversation: "Conversation",
    check: "Check model connection",
    working: "Checking…",
    checked: "Model connected.",
    newChat: "New conversation",
    untitled: "New conversation",
    choose: "Switch conversation",
    changed:
      "Another tab switched conversations. Check the selected conversation before continuing.",
    more: "Conversation options",
    today: "Today",
    callActive: "End the call to type a message.",
  },
};
function Chat({ companion, lang, renderCall, renderMessageAction }: ChatProps) {
  const t = copy[lang];
  const path = "/api/companions/" + encodeURIComponent(companion.id) + "/chat";
  const [turns, setTurns] = useState<Turn[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [switching, setSwitching] = useState(false);
  const currentThread = useRef("");
  const drafts = useRef(new Map<string, string>());
  const [cursor, setCursor] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [callActive, setCallActive] = useState(false);
  const [activeId, setActiveId] = useState("");
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [confirm, setConfirm] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probed, setProbed] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const alive = useRef(true);
  const historyVersion = useRef(0);
  const view = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const anchorHeight = useRef<number | null>(null);
  const pendingMore = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const reusable = useRef<{ id: string; text: string } | null>(null);
  const refresh = useCallback(
    async (before?: number) => {
      if (before && pendingMore.current) return;
      if (before) pendingMore.current = true;
      const revision = ++historyVersion.current;
      try {
        const r = await fetch(
          path +
            (before
              ? "?before=" +
                before +
                "&conversationId=" +
                encodeURIComponent(currentThread.current)
              : ""),
        );
        if (!r.ok)
          throw Error(
            r.status === 401
              ? "login_required"
              : r.status === 409
                ? "conversation_changed"
                : "connection_lost",
          );
        const data = await r.json();
        if (
          !alive.current ||
          revision !== historyVersion.current ||
          socket.current
        )
          return;
        if (currentThread.current !== data.conversationId) {
          currentThread.current = data.conversationId;
          setConversationId(data.conversationId);
          setDraft(drafts.current.get(data.conversationId) || "");
          reusable.current = null;
          follow.current = true;
          setMenu(false);
          setConfirm(false);
        }
        setThreads(data.conversations);
        if (before) anchorHeight.current = view.current?.scrollHeight ?? null;
        setTurns((prev) => (before ? [...data.turns, ...prev] : data.turns));
        setCursor(data.nextCursor);
        setConfigured(data.modelConfigured);
        setLoaded(true);
        setError((prev) => (prev === "connection_lost" ? "" : prev));
      } catch (e) {
        if (alive.current && revision === historyVersion.current)
          setError(
            e instanceof Error &&
              ["conversation_changed", "login_required"].includes(e.message)
              ? e.message
              : "connection_lost",
          );
      } finally {
        if (before) pendingMore.current = false;
      }
    },
    [path],
  );
  useEffect(() => {
    alive.current = true;
    void refresh();
    const restore = () => {
      if (!socket.current && !document.hidden) void refresh();
    };
    const visibility = () => {
      if (document.hidden) socket.current?.close();
      else restore();
    };
    window.addEventListener("online", restore);
    window.addEventListener("focus", restore);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive.current = false;
      historyVersion.current++;
      const current = socket.current;
      socket.current = null;
      current?.close();
      window.removeEventListener("online", restore);
      window.removeEventListener("focus", restore);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [refresh]);
  useLayoutEffect(() => {
    const el = view.current;
    if (!el) return;
    if (anchorHeight.current !== null) {
      el.scrollTop += el.scrollHeight - anchorHeight.current;
      anchorHeight.current = null;
    } else if (follow.current) el.scrollTop = el.scrollHeight;
  }, [turns, activeId]);

  const active = turns.find((row) => row.id === activeId);
  const rendered = active?.assistantText.length ?? 0;
  useEffect(() => {
    if (!rendered || !activeId || document.hidden) return;
    const current = socket.current;
    // Acknowledge after the browser has had a paint opportunity for this committed prefix.
    // Do not cancel an older committed prefix simply because a newer delta arrived.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (
          !document.hidden &&
          current &&
          current === socket.current &&
          current.readyState === WebSocket.OPEN
        )
          current.send(
            JSON.stringify({
              type: "text.ack",
              turnId: activeId,
              offset: rendered,
            }),
          );
      }),
    );
  }, [activeId, rendered]);

  function send(text: string, clientMessageId: string, retry = false) {
    if (
      socket.current ||
      callActive ||
      switching ||
      !conversationId ||
      !text.trim()
    )
      return;
    setError("");
    setBusy(true);
    setMenu(false);
    follow.current = true;
    let ws: WebSocket;
    try {
      const url = new URL(path + "/socket", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(url);
    } catch {
      setError("connection_lost");
      setBusy(false);
      return;
    }
    socket.current = ws;
    let started = false;
    let concluded = false;
    let issue = "";
    ws.onopen = () => {
      if (ws !== socket.current) return;
      ws.send(
        JSON.stringify({
          type: "text.send",
          protocolVersion: 1,
          conversationId,
          clientMessageId,
          text,
          retry,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      );
    };
    ws.onmessage = ({ data }) => {
      if (ws !== socket.current) return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        issue = "connection_lost";
        ws.close();
        return;
      }
      if (msg.type === "turn.started") {
        started = true;
        reusable.current = null;
        drafts.current.delete(conversationId);
        setDraft("");
        setActiveId(msg.turn.id);
        setTurns((rows) => [
          ...rows.filter((row) => row.id !== msg.turn.id),
          msg.turn,
        ]);
      } else if (msg.type === "text.delta") {
        setTurns((rows) =>
          rows.map((row) =>
            row.id === msg.turnId
              ? { ...row, assistantText: row.assistantText + msg.delta }
              : row,
          ),
        );
      } else if (msg.type === "turn.ended") {
        concluded = true;
      } else if (msg.type === "snapshot") {
        concluded = true;
        reusable.current = null;
        drafts.current.delete(conversationId);
        setDraft("");
      } else if (msg.type === "error") {
        issue = msg.code;
      }
    };
    ws.onerror = () => {
      issue = "connection_lost";
    };
    ws.onclose = () => {
      if (ws !== socket.current) return;
      socket.current = null;
      setBusy(false);
      setActiveId("");
      if (issue || (!concluded && !started))
        setError(issue || "connection_lost");
      void refresh();
    };
  }
  function submit() {
    const text = draft.trim();
    if (!text || configured !== true || busy) return;
    const existing = reusable.current;
    const id = existing?.text === text ? existing.id : crypto.randomUUID();
    reusable.current = { id, text };
    send(text, id);
  }
  async function changeThread(method: "POST" | "PUT" | "DELETE", target = "") {
    if (switching || busy || callActive) return;
    setSwitching(true);
    setError("");
    historyVersion.current++;
    try {
      const suffix = target
        ? "/" + encodeURIComponent(target) + (method === "PUT" ? "/active" : "")
        : "";
      const r = await fetch(path + "/conversations" + suffix, { method });
      if (!r.ok) throw Error((await r.json()).error);
      if (!alive.current) return;
      if (method === "DELETE") drafts.current.delete(target);
      setConfirm(false);
      setMenu(false);
      await refresh();
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error && e.message === "busy"
            ? "busy"
            : "connection_lost",
        );
    } finally {
      if (alive.current) setSwitching(false);
    }
  }
  async function probe() {
    setProbing(true);
    setProbed(false);
    setError("");
    try {
      const r = await fetch("/api/chat/model/probe", { method: "POST" });
      if (!alive.current) return;
      if (!r.ok) {
        setError((await r.json()).error || "model_unavailable");
        return;
      }
      setProbed(true);
      void refresh();
    } catch {
      if (alive.current) setError("connection_lost");
    } finally {
      if (alive.current) setProbing(false);
    }
  }
  const message =
    error === "conversation_changed"
      ? t.changed
      : error === "model_unconfigured"
        ? t.missing
        : error === "model_unavailable"
          ? t.model
          : error === "busy"
            ? t.busy
            : error === "login_required"
              ? t.login
              : error === "reply_limit"
                ? t.limit
                : error === "connection_lost"
                  ? t.network
                  : t.invalid;
  function bubble(turn: Turn, role: "user" | "assistant") {
    const text = role === "user" ? turn.userText : turn.assistantText;
    if (!text) return null;
    return (
      <div className={"duet-message " + role}>
        <p>{text}</p>
        {renderMessageAction?.({
          role,
          turnId: turn.id,
          text,
          createdAt: turn.createdAt,
          timeZone: turn.timeZone,
        })}
      </div>
    );
  }
  return (
    <section className="duet-chat" aria-label={t.conversation}>
      <div className="duet-chatbar">
        <h2>{t.conversation}</h2>
        <div className="duet-chattools">
          {renderCall?.({
            refresh,
            busy: busy || switching,
            conversationId: conversationId || undefined,
            setCallActive,
          })}
          <DropdownMenu open={menu} onOpenChange={setMenu}>
            <DropdownMenuTrigger asChild>
              <Button
                ref={menuButton}
                variant="ghost"
                size="icon"
                aria-label={t.more}
              >
                <Ellipsis aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                if (confirm) event.preventDefault();
              }}
            >
              <DropdownMenuItem
                disabled={busy || switching || probing || callActive}
                onSelect={() => void probe()}
              >
                {probing ? t.working : t.check}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={
                  (!turns.length && threads.length <= 1) ||
                  busy ||
                  switching ||
                  callActive
                }
                onSelect={() => setConfirm(true)}
              >
                <Trash2 aria-hidden="true" />
                {t.clear}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {loaded && (
        <div className="duet-threadbar">
          <NativeSelect
            aria-label={t.choose}
            value={conversationId}
            disabled={busy || callActive || switching}
            onChange={(e) => void changeThread("PUT", e.target.value)}
          >
            {threads.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title || t.untitled} ·{" "}
                {new Date(row.createdAt).toLocaleDateString(
                  lang === "zh" ? "zh-CN" : "en",
                  { month: "short", day: "numeric" },
                )}
              </option>
            ))}
          </NativeSelect>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={busy || callActive || switching}
            onClick={() => void changeThread("POST")}
          >
            <Plus aria-hidden="true" /> {t.newChat}
          </Button>
        </div>
      )}
      <AlertDialog
        open={confirm}
        onOpenChange={(open) => {
          if (!switching) setConfirm(open);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            menuButton.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t.clear}</AlertDialogTitle>
            <AlertDialogDescription>{t.confirm}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p className="feedback" role="alert">
              {message}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={switching}>
              {t.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={switching}
              onClick={(event) => {
                event.preventDefault();
                void changeThread("DELETE", conversationId);
              }}
            >
              {t.erase}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {configured === false && (
        <div className="duet-notice" role="status">
          {t.missing}
        </div>
      )}
      {error && !(configured === false && error === "model_unconfigured") && (
        <div className="duet-notice" role="alert">
          <span>{message}</span>
          {(error === "connection_lost" ||
            error === "conversation_changed") && (
            <Button variant="outline" onClick={() => void refresh()}>
              {t.reload}
            </Button>
          )}
        </div>
      )}
      {probed && !error && (
        <div className="duet-notice" role="status">
          {t.checked}
        </div>
      )}
      <div
        className="duet-history"
        aria-label={t.history}
        ref={view}
        onScroll={() => {
          const el = view.current;
          if (el)
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 72;
        }}
      >
        {cursor !== null && (
          <Button
            variant="link"
            className="duet-older"
            onClick={() => void refresh(cursor)}
          >
            {t.older}
          </Button>
        )}
        {!loaded && !error && <p className="duet-loading">{t.loading}</p>}
        {loaded && !turns.length && (
          <div className="duet-empty">
            <img className="duet-window" src="/room.svg" alt="" />
            <h3>{configured === false ? companion.name : t.empty}</h3>
            {configured !== false && <p>{t.first(companion.name)}</p>}
          </div>
        )}
        {turns.map((turn, i) => {
          const date = new Date(turn.createdAt);
          const nextDay =
            !i ||
            date.toDateString() !==
              new Date(turns[i - 1].createdAt).toDateString();
          return (
            <div key={turn.id} className="duet-turn">
              {nextDay && (
                <div className="duet-date">
                  <span>
                    {date.toDateString() === new Date().toDateString()
                      ? t.today
                      : date.toLocaleDateString(
                          lang === "zh" ? "zh-CN" : "en",
                          { month: "short", day: "numeric", year: "numeric" },
                        )}
                  </span>
                </div>
              )}
              <div className="duet-meta user">
                {t.you} ·{" "}
                {date.toLocaleTimeString(lang === "zh" ? "zh-CN" : "en", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                {turn.mode === "voice" ? " · " + t.voice : ""}
              </div>
              {bubble(turn, "user")}
              {(turn.assistantText ||
                turn.id === activeId ||
                turn.status === "failed" ||
                turn.status === "interrupted") && (
                <div className="duet-meta">{companion.name}</div>
              )}
              {bubble(turn, "assistant")}
              {turn.id === activeId && !turn.assistantText && (
                <div className="duet-status" role="status">
                  {t.typing}
                </div>
              )}
              {turn.status === "interrupted" && (
                <div className="duet-status">{t.interrupted}</div>
              )}
              {turn.status === "failed" && (
                <div className="duet-status">
                  {t.failed}
                  {!turn.assistantText && i === turns.length - 1 && (
                    <Button
                      variant="outline"
                      disabled={busy || callActive}
                      onClick={() =>
                        send(turn.userText, turn.clientMessageId, true)
                      }
                    >
                      {t.retry}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <form
        className="duet-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Textarea
          ref={input}
          rows={2}
          maxLength={4000}
          value={draft}
          disabled={busy || switching || callActive}
          aria-label={t.placeholder(companion.name)}
          placeholder={
            callActive ? t.callActive : t.placeholder(companion.name)
          }
          onChange={(event) => {
            setDraft(event.target.value);
            drafts.current.set(conversationId, event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229 &&
              !window.matchMedia("(pointer: coarse)").matches
            ) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <Button
            variant="default"
            size="icon"
            type="button"
            className="duet-send"
            aria-label={t.stop}
            title={t.stop}
            onClick={() => {
              const ws = socket.current;
              if (ws?.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: "interrupt" }));
              else ws?.close();
            }}
          >
            <Square aria-hidden="true" fill="currentColor" />
          </Button>
        ) : (
          <Button
            variant="default"
            size="icon"
            className="duet-send"
            type="submit"
            disabled={
              !draft.trim() || configured !== true || switching || callActive
            }
            aria-label={t.send}
            title={t.send}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
        )}
      </form>
    </section>
  );
}
export default function Conversation(props: ChatProps) {
  return <Chat key={props.companion.id} {...props} />;
}
