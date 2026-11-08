import { useEffect, useRef, useState } from "react";
import type { ModelViewerElement } from "@google/model-viewer";
import { Download, RotateCcw, Square, Volume2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { followSpeech } from "./speech";
import { greetingText, playGreeting } from "./greeting";
import { RoomDialog } from "../components/RoomDialog";
import type { Lang } from "../ui";
import studioModel from "./studio.glb?url";
import studioPortrait from "./studio.webp";
import portraitLight from "./portrait-light.hdr?url";
import animatedModel from "./companion.glb?url";
import scanModel from "./scanned.glb?url";
import scanPortrait from "./scanned.webp";
import portrait from "./portrait.webp";
import "./avatar.css";

const avatarKinds = ["studio", "scan", "animated"] as const;
type AvatarKind = (typeof avatarKinds)[number];

const hints = {
  zh: {
    loading: "正在加载形象…",
    ready: "拖动旋转，滚动或双指缩放。",
    error: "当前无法显示 3D 模型。可以下载模型查看。",
    audioError: "问候播放失败，可以重试。",
    play: "试听问候",
    stop: "停止试听",
  },
  en: {
    loading: "Loading avatar…",
    ready: "Drag to rotate. Scroll or pinch to zoom.",
    error: "3D view unavailable. Download the model to open it locally.",
    audioError: "Couldn’t play the greeting. Try again.",
    play: "Play greeting",
    stop: "Stop greeting",
  },
};

const avatars = {
  studio: {
    label: { zh: "写实肖像", en: "Studio portrait" },
    src: studioModel,
    poster: studioPortrait,
    file: "DuetRoom-studio.glb",
    alt: {
      zh: "长发女性数字伙伴的定制三维肖像",
      en: "A custom 3D portrait of a companion with long dark hair",
    },
    portrait: { orbit: "-4deg 86deg .90m", target: "0m 1.455m .035m" },
    full: { orbit: "4deg 87deg 4.2m", target: "0m .85m 0m" },
  },
  scan: {
    label: { zh: "实拍形象", en: "Photo scan" },
    src: scanModel,
    poster: scanPortrait,
    file: "DuetRoom-scan.glb",
    alt: {
      zh: "身穿条纹衬衫的女性全身扫描",
      en: "Full-body scan of a woman in a striped blouse",
    },
    portrait: { orbit: "-6deg 84deg .94m", target: "0m 1.455m .035m" },
    full: { orbit: "4deg 87deg 4.2m", target: "0m .85m 0m" },
  },
  animated: {
    label: { zh: "动画形象", en: "Animated" },
    src: animatedModel,
    poster: portrait,
    file: "DuetRoom-avatar.glb",
    alt: {
      zh: "身穿深绿色外套的女性数字人",
      en: "3D figure of a woman in a deep green jacket",
    },
    portrait: { orbit: "-8deg 84deg .96m", target: "0m 1.54m 0m" },
    full: { orbit: "4deg 87deg 4.2m", target: "0m .88m 0m" },
  },
};

export function AvatarPreview({ lang }: { lang: Lang }) {
  const [open, setOpen] = useState(false);
  const zh = lang === "zh";
  return (
    <>
      <Button
        variant="outline"
        className="avatar-entry"
        onClick={() => setOpen(true)}
      >
        <img src={studioPortrait} alt="" />
        <span>{zh ? "查看 3D 形象" : "View 3D avatar"}</span>
      </Button>
      {open && <AvatarStudio lang={lang} onClose={() => setOpen(false)} />}
    </>
  );
}

function AvatarStudio({ lang, onClose }: { lang: Lang; onClose: () => void }) {
  const zh = lang === "zh";
  const [kind, setKind] = useState<AvatarKind>("studio");
  return (
    <RoomDialog
      title={zh ? "3D 形象" : "3D avatar"}
      closeLabel={zh ? "关闭" : "Close"}
      onClose={onClose}
      className="avatar-dialog"
    >
      <div
        className="avatar-choices"
        role="group"
        aria-label={zh ? "选择形象" : "Choose avatar"}
      >
        {avatarKinds.map((id) => (
          <Button
            key={id}
            size="sm"
            variant={kind === id ? "secondary" : "ghost"}
            aria-pressed={kind === id}
            onClick={() => setKind(id)}
          >
            {avatars[id].label[lang]}
          </Button>
        ))}
      </div>
      <AvatarView key={kind + lang} kind={kind} lang={lang} />
      {kind !== "animated" && (
        <small className="avatar-credit">
          <a
            href="https://huggingface.co/datasets/digitalrealitylab/HSRD-100"
            target="_blank"
            rel="noreferrer"
          >
            Digital Reality Lab · HSRD-100
          </a>
          {" · "}
          <a
            href="https://creativecommons.org/licenses/by/4.0/"
            target="_blank"
            rel="noreferrer"
          >
            CC BY 4.0
          </a>
          {" · "}
          {kind === "studio"
            ? zh
              ? "面部重塑与生成纹理"
              : "Reshaped face and generated texture"
            : zh
              ? "网页适配"
              : "Adapted for web"}
        </small>
      )}
    </RoomDialog>
  );
}

function AvatarView({ lang, kind }: { lang: Lang; kind: AvatarKind }) {
  const zh = lang === "zh";
  const avatar = avatars[kind];
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<ModelViewerElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [full, setFull] = useState(false);

  const greeting = useRef<ReturnType<typeof playGreeting> | null>(null);
  const [greetingState, setGreetingState] = useState<
    "idle" | "playing" | "error"
  >("idle");

  useEffect(() => {
    function stop() {
      greeting.current?.stop();
      greeting.current = null;
    }
    function stopPreview() {
      stop();
      setGreetingState("idle");
    }
    function hide() {
      if (document.hidden) stopPreview();
    }
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", stopPreview);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", stopPreview);
    };
  }, [lang]);

  useEffect(() => {
    const el = viewer.current;
    if (!el || kind !== "studio" || status !== "ready") return;
    const sample = greeting.current;
    if (sample && greetingState === "playing")
      return followSpeech(el, sample.read);
  }, [kind, lang, status, greetingState]);

  function toggleGreeting() {
    if (greeting.current) {
      greeting.current.stop();
      greeting.current = null;
      setGreetingState("idle");
      return;
    }
    try {
      greeting.current = playGreeting(lang, (failed) => {
        greeting.current = null;
        setGreetingState(failed ? "error" : "idle");
      });
      setGreetingState("playing");
    } catch {
      setGreetingState("error");
    }
  }

  useEffect(() => {
    // Loading the GLB can succeed even when the browser cannot draw it.
    const probe = document.createElement("canvas").getContext("webgl2");
    if (!probe) {
      setStatus("error");
      return;
    }
    probe.getExtension("WEBGL_lose_context")?.loseContext();

    let closed = false;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => {
      const el = viewer.current;
      if (!el) return;
      if (motion.matches || el.availableAnimations.length === 0) {
        el.pause();
        el.currentTime = 0;
      } else {
        el.play();
      }
    };
    const ready = () => {
      setStatus("ready");
      if (kind === "studio" && viewer.current)
        viewer.current.animationName = "Portrait idle";
      updateMotion();
    };
    const failed = () => setStatus("error");
    // Load the renderer only when someone opens the portrait.
    import("@google/model-viewer")
      .then(() => {
        if (closed || !host.current) return;
        const el = document.createElement("model-viewer") as ModelViewerElement;
        viewer.current = el;
        el.alt = avatar.alt[lang];
        el.cameraControls = true;
        el.cameraOrbit = avatar.portrait.orbit;
        el.cameraTarget = avatar.portrait.target;
        el.fieldOfView = "28deg";
        el.minCameraOrbit = "auto 48deg 0.42m";
        el.maxCameraOrbit = "auto 112deg 5m";
        el.minFieldOfView = "20deg";
        el.maxFieldOfView = "38deg";
        el.disablePan = true;
        el.interactionPrompt = "none";
        el.environmentImage = kind === "studio" ? portraitLight : "neutral";
        el.exposure = kind === "studio" ? 1 : 1.05;
        el.loading = "eager";
        el.addEventListener("load", ready);
        el.addEventListener("error", failed);
        el.src = avatar.src;
        host.current.appendChild(el);
      })
      .catch(() => {
        if (!closed) failed();
      });
    motion.addEventListener("change", updateMotion);
    return () => {
      closed = true;
      motion.removeEventListener("change", updateMotion);
      const el = viewer.current;
      if (el) {
        el.removeEventListener("load", ready);
        el.removeEventListener("error", failed);
        el.pause();
        el.remove();
      }
      viewer.current = null;
    };
  }, [avatar, kind, lang]);

  function frame(wide: boolean) {
    const el = viewer.current;
    if (!el) return;
    const camera = wide ? avatar.full : avatar.portrait;
    el.cameraTarget = camera.target;
    el.cameraOrbit = camera.orbit;
    el.fieldOfView = "28deg";
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      el.jumpCameraToGoal();
    setFull(wide);
  }

  const stage = (
    <div className="avatar-stage" data-avatar={kind}>
      {status !== "ready" && (
        <img
          className="avatar-fallback"
          src={avatar.poster}
          alt={zh ? "数字人肖像" : "Avatar portrait"}
        />
      )}
      <div className="avatar-view" ref={host} hidden={status === "error"} />
    </div>
  );

  return (
    <>
      {stage}
      <p className="avatar-hint" role="status">
        {greetingState === "playing"
          ? greetingText[lang]
          : greetingState === "error"
            ? hints[lang].audioError
            : hints[lang][status]}
      </p>
      <div className="avatar-tools">
        {kind === "studio" && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={status === "loading"}
            aria-pressed={greetingState === "playing"}
            onClick={toggleGreeting}
          >
            {greetingState === "playing" ? <Square /> : <Volume2 />}
            {greetingState === "playing" ? hints[lang].stop : hints[lang].play}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={status !== "ready"}
          onClick={() => frame(!full)}
        >
          {full ? (zh ? "看近景" : "Portrait") : zh ? "看全身" : "Full body"}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={zh ? "重置视角" : "Reset view"}
          disabled={status !== "ready"}
          onClick={() => frame(false)}
        >
          <RotateCcw />
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <a href={avatar.src} download={avatar.file}>
            <Download />
            {zh ? "下载模型" : "Download model"}
          </a>
        </Button>
      </div>
    </>
  );
}
