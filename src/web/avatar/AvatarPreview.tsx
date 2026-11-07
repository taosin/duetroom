import { useEffect, useRef, useState } from "react";
import type { ModelViewerElement } from "@google/model-viewer";
import { Download, RotateCcw } from "lucide-react";
import { Button } from "../components/ui/button";
import { RoomDialog } from "../components/RoomDialog";
import type { Lang } from "../ui";
import model from "./companion.glb?url";
import portrait from "./portrait.webp";
import "./avatar.css";

const cameras = {
  portrait: { orbit: "-8deg 84deg .96m", target: "0m 1.54m 0m" },
  full: { orbit: "4deg 87deg 4.2m", target: "0m .88m 0m" },
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
        <img src={portrait} alt="" />
        <span>{zh ? "查看 3D 形象" : "View 3D avatar"}</span>
      </Button>
      {open && <AvatarStudio lang={lang} onClose={() => setOpen(false)} />}
    </>
  );
}

function AvatarStudio({ lang, onClose }: { lang: Lang; onClose: () => void }) {
  const zh = lang === "zh";
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<ModelViewerElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [full, setFull] = useState(false);

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
      if (motion.matches) {
        el.pause();
        el.currentTime = 0;
      } else {
        el.play();
      }
    };
    const ready = () => {
      setStatus("ready");
      updateMotion();
    };
    const failed = () => setStatus("error");
    // Load the renderer only when someone opens the portrait.
    import("@google/model-viewer")
      .then(() => {
        if (closed || !host.current) return;
        const el = document.createElement("model-viewer") as ModelViewerElement;
        viewer.current = el;
        el.alt = zh
          ? "身穿深绿色外套的女性数字人"
          : "3D figure of a woman in a deep green jacket";
        el.cameraControls = true;
        el.cameraOrbit = cameras.portrait.orbit;
        el.cameraTarget = cameras.portrait.target;
        el.fieldOfView = "28deg";
        el.minCameraOrbit = "auto 48deg 0.42m";
        el.maxCameraOrbit = "auto 112deg 5m";
        el.minFieldOfView = "20deg";
        el.maxFieldOfView = "38deg";
        el.disablePan = true;
        el.interactionPrompt = "none";
        el.environmentImage = "neutral";
        el.exposure = 1.05;
        el.loading = "eager";
        el.addEventListener("load", ready);
        el.addEventListener("error", failed);
        el.src = model;
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
  }, [zh]);

  function frame(wide: boolean) {
    const el = viewer.current;
    if (!el) return;
    const camera = wide ? cameras.full : cameras.portrait;
    el.cameraTarget = camera.target;
    el.cameraOrbit = camera.orbit;
    el.fieldOfView = "28deg";
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      el.jumpCameraToGoal();
    setFull(wide);
  }

  return (
    <RoomDialog
      title={zh ? "3D 形象" : "3D avatar"}
      closeLabel={zh ? "关闭" : "Close"}
      onClose={onClose}
      className="avatar-dialog"
    >
      <div className="avatar-stage">
        {status !== "ready" && (
          <img
            className="avatar-fallback"
            src={portrait}
            alt={zh ? "数字人肖像" : "Avatar portrait"}
          />
        )}
        <div className="avatar-view" ref={host} hidden={status === "error"} />
      </div>
      <p className="avatar-hint" role="status">
        {status === "error"
          ? zh
            ? "当前无法显示 3D 模型。可以下载模型查看。"
            : "3D view unavailable. Download the model to open it locally."
          : status === "loading"
            ? zh
              ? "正在加载形象…"
              : "Loading avatar…"
            : zh
              ? "拖动旋转，滚动或双指缩放。"
              : "Drag to rotate. Scroll or pinch to zoom."}
      </p>
      <div className="avatar-tools">
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
          <a href={model} download="DuetRoom-avatar.glb">
            <Download />
            {zh ? "下载模型" : "Download model"}
          </a>
        </Button>
      </div>
    </RoomDialog>
  );
}
