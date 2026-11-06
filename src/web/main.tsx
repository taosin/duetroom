import { Button } from "./components/ui/button";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import Login from "./Login";
import Workspace from "./Workspace";
import { type Lang } from "./ui";
import "./base.css";

function App() {
  const [lang, setLang] = useState<Lang>(() =>
    localStorage.getItem("duet.lang") === "zh"
      ? "zh"
      : localStorage.getItem("duet.lang") === "en"
        ? "en"
        : navigator.language.startsWith("zh")
          ? "zh"
          : "en",
  );
  const [session, setSession] = useState<"loading" | "in" | "out" | "error">(
    "loading",
  );
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    localStorage.setItem("duet.lang", lang);
  }, [lang]);
  useEffect(() => {
    fetch("/api/session")
      .then((r) => setSession(r.ok ? "in" : r.status === 401 ? "out" : "error"))
      .catch(() => setSession("error"));
  }, []);
  const zh = lang === "zh";
  if (session === "loading")
    return (
      <p role="status" className="loading">
        {zh ? "正在打开…" : "Opening…"}
      </p>
    );
  if (session === "error")
    return (
      <main className="loading">
        <p>
          {zh
            ? "连接失败，请检查服务是否已启动。"
            : "Could not connect to DuetRoom."}
        </p>
        <Button variant="outline" onClick={() => location.reload()}>
          {zh ? "重试" : "Retry"}
        </Button>
      </main>
    );
  if (session === "out")
    return (
      <Login lang={lang} setLang={setLang} onLogin={() => setSession("in")} />
    );
  async function logout() {
    const r = await fetch("/api/session", { method: "DELETE" });
    if (r.ok || r.status === 401) setSession("out");
  }
  return <Workspace lang={lang} setLang={setLang} logout={logout} />;
}
createRoot(document.getElementById("root")!).render(<App />);
