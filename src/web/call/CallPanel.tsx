import { useEffect, useRef, useState } from "react";
import { openCall } from "./device";

const copy = {
  en: {
    interrupt: "Interrupt",
    reveal: "Show remaining text",
    call: "Voice call",
    connect: "Start call",
    cancel: "Cancel",
    hangup: "Hang up",
    checking: "Checking voice service…",
    consent:
      "Your microphone audio goes to Azure Speech. The transcript goes to",
    model: "the configured chat model",
    storage:
      "DuetRoom saves chat text and transcriptions. It does not store recordings.",
    listening: "Listening",
    replying: "Replying",
    connecting: "Connecting…",
    back: "Back to text",
    busy: "Another conversation is active.",
    permission: "Microphone permission was denied.",
    unsupported: "Use a browser with secure microphone and Web Audio support.",
    device: "The microphone or speaker is unavailable.",
    speech_unconfigured: "Azure Speech has not been configured.",
    speech_unavailable: "The speech region or service could not be reached.",
    voice_unavailable: "This voice is unavailable in the configured region.",
    recognition_failed: "Speech recognition stopped. Please try again.",
    synthesis_failed: "Speech synthesis stopped.",
    model_unconfigured: "The chat model has not been configured.",
    model_unavailable: "The chat model could not be reached.",
    expired: "This session has ended.",
    network: "The call connection was lost.",
    duration: "The 30-minute call ended. You can call again.",
    background: "The call ended when the page left the foreground.",
    audio_suspended: "Audio was interrupted. Tap to call again.",
    conversation_changed:
      "The active conversation changed. Refresh the chat before calling.",
    call_failed: "The call could not continue.",
  },
  zh: {
    interrupt: "打断",
    reveal: "显示剩余文字",
    call: "语音通话",
    connect: "接通",
    cancel: "取消",
    hangup: "挂断",
    checking: "正在检查语音服务…",
    consent: "麦克风音频将发送到 Azure Speech，转写文本将发送到",
    model: "部署者配置的聊天模型",
    storage: "DuetRoom 保存聊天文字和转写，不保存录音。",
    listening: "正在听",
    replying: "正在回复",
    connecting: "正在接通…",
    back: "返回文字聊天",
    busy: "当前角色已有进行中的对话。",
    permission: "未获得麦克风权限。",
    unsupported:
      "请使用支持麦克风和网页音频的浏览器，并通过 HTTPS 或本机访问。",
    device: "麦克风或扬声器不可用。",
    speech_unconfigured: "尚未配置 Azure Speech。",
    speech_unavailable: "当前无法连接语音服务，请检查服务区域和凭据。",
    voice_unavailable: "所选音色在当前服务区域不可用。",
    recognition_failed: "语音识别中断，请重新接通。",
    synthesis_failed: "语音合成中断。",
    model_unconfigured: "尚未配置聊天模型。",
    model_unavailable: "暂时无法连接聊天模型。",
    expired: "会话已结束。",
    network: "通话连接已中断。",
    duration: "本次通话已满 30 分钟，可再次接通。",
    background: "页面进入后台，通话已结束。",
    audio_suspended: "设备音频已中断，可手动重新接通。",
    conversation_changed: "当前对话已切换，请刷新聊天后重新接通。",
    call_failed: "通话无法继续。",
  },
};
type Props = {
  companion: { id: string; name: string; locale: string; voice: string };
  lang: "en" | "zh";
  onHistoryChange: () => void;
  conversationId?: string;
  disabled?: boolean;
  onActiveChange?: (isActive: boolean) => void;
};
type State =
  | "idle"
  | "checking"
  | "consent"
  | "connecting"
  | "listening"
  | "replying"
  | "error";

export function CallProblem({
  lang,
  code,
  onBack,
}: {
  lang: "en" | "zh";
  code: string;
  onBack: () => void;
}) {
  const labels = copy[lang];
  const text = Object.hasOwn(labels, code)
    ? labels[code as keyof typeof labels]
    : labels.call_failed;
  return (
    <>
      <p role="alert">{text}</p>
      <button type="button" onClick={onBack}>
        {labels.back}
      </button>
    </>
  );
}
export default function CallPanel({
  companion,
  lang,
  onHistoryChange,
  conversationId,
  disabled,
  onActiveChange,
}: Props) {
  const labels = copy[lang];
  const [state, setState] = useState<State>("idle");
  const [model, setModel] = useState("");
  const [error, setError] = useState("call_failed");
  const [caption, setCaption] = useState("");
  const [offer, setOffer] = useState(false);
  const [remaining, setRemaining] = useState<{
    text: string;
    generation: number;
  }>();
  useEffect(() => {
    if (!remaining) return;
    const call = current.current;
    let tick = requestAnimationFrame(() => {
      tick = requestAnimationFrame(() => call?.displayed(remaining.generation));
    });
    return () => cancelAnimationFrame(tick);
  }, [remaining]);
  const current = useRef<ReturnType<typeof openCall> | undefined>(undefined);
  const handle = useRef(0);
  const activeChange = useRef(onActiveChange);
  activeChange.current = onActiveChange;
  const history = useRef(onHistoryChange);
  history.current = onHistoryChange;
  function reset() {
    handle.current++;
    current.current?.close();
    current.current = undefined;
    setCaption("");
    setState("idle");
  }
  useEffect(() => {
    setState("idle");
    setCaption("");
    return () => {
      handle.current++;
      if (current.current) activeChange.current?.(false);
      current.current?.close();
      current.current = undefined;
    };
  }, [companion.id, conversationId]);
  async function prepare() {
    const token = ++handle.current;
    setState("checking");
    try {
      const response = await fetch("/api/call/voices");
      if (!response.ok)
        throw Error(response.status === 401 ? "expired" : "speech_unavailable");
      const result = await response.json();
      if (token !== handle.current) return;
      if (!result.available) throw Error(result.code || "speech_unavailable");
      if (
        !result.voices.some((v: { id: string; locale: string }) =>
          companion.voice
            ? v.id === companion.voice
            : v.locale === companion.locale,
        )
      )
        throw Error("voice_unavailable");
      setModel(result.model);
      setState("consent");
    } catch (e) {
      if (token === handle.current) {
        setError((e as Error).message);
        setState("error");
      }
    }
  }
  function connect() {
    const token = ++handle.current;
    setOffer(false);
    setRemaining(undefined);
    setState("connecting");
    activeChange.current?.(true);
    current.current = openCall(
      companion.id,
      {
        event: (e) => {
          if (handle.current !== token) return;
          if (e.type === "ready" || e.type === "reply.end")
            setState("listening");
          if (e.type === "interrupted" || e.type === "reply") {
            setOffer(false);
            setRemaining(undefined);
            setState(e.type === "reply" ? "replying" : "listening");
          }
          if (e.type === "reveal.available") setOffer(true);
          if (
            e.type === "reveal.text" &&
            e.text &&
            e.generation !== undefined
          ) {
            setOffer(false);
            setRemaining({ text: e.text, generation: e.generation });
          }
          if (e.type === "caption" || e.type === "reply")
            setCaption(e.text || "");
          if (e.type === "history") history.current();
        },
        ended: (code) => {
          if (handle.current !== token) return;
          current.current = undefined;
          activeChange.current?.(false);
          setCaption("");
          if (code) {
            setError(code);
            setState("error");
          } else setState("idle");
          history.current();
        },
      },
      conversationId,
    );
  }
  if (state === "idle")
    return (
      <button type="button" onClick={prepare} disabled={disabled}>
        {labels.call}
      </button>
    );
  return (
    <section className="call-panel" aria-label={labels.call}>
      {state === "checking" && <p role="status">{labels.checking}</p>}
      {state === "consent" && (
        <>
          <p>
            {labels.consent} {model || labels.model}
            {lang === "zh" ? "。" : "."} {labels.storage}
          </p>
          <button type="button" onClick={connect} disabled={disabled}>
            {labels.connect}
          </button>
        </>
      )}
      {(state === "checking" || state === "consent") && (
        <button type="button" onClick={reset}>
          {labels.cancel}
        </button>
      )}
      {state === "error" && (
        <CallProblem lang={lang} code={error} onBack={reset} />
      )}
      {["connecting", "listening", "replying"].includes(state) && (
        <>
          <span role="status">
            {companion.name} ·{" "}
            {labels[state as "connecting" | "listening" | "replying"]}
          </span>
          {caption && <p>{caption}</p>}
          {remaining && <p>{remaining.text}</p>}
          {offer && (
            <button type="button" onClick={() => current.current?.reveal()}>
              {labels.reveal}
            </button>
          )}
          {state === "replying" && (
            <button type="button" onClick={() => current.current?.interrupt()}>
              {labels.interrupt}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              current.current?.close();
            }}
          >
            {labels.hangup}
          </button>
        </>
      )}
    </section>
  );
}
