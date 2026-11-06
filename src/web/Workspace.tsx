import { Plus, Settings } from "lucide-react";
import { Avatar, AvatarFallback } from "./components/ui/avatar";
import { Button } from "./components/ui/button";
import { useEffect, useState } from "react";
import { Brand, Language, type Lang } from "./ui";
import type { Companion } from "../shared/companion";
import { Memories, Remember } from "./persona/Memories";
import CallPanel from "./call/CallPanel";
import Conversation from "./chat/Conversation";
import Editor from "./companions/Editor";
import "./workspace.css";

function Portrait({ name, id }: { name: string; id: string }) {
  return (
    <Avatar className="portrait" aria-hidden="true">
      <AvatarFallback className={"tone" + (id.charCodeAt(0) % 4)}>
        {Array.from(name)[0]}
      </AvatarFallback>
    </Avatar>
  );
}
export default function Workspace({
  lang,
  setLang,
  logout,
}: {
  lang: Lang;
  setLang: (l: Lang) => void;
  logout: () => void;
}) {
  const zh = lang === "zh",
    [rows, setRows] = useState<Companion[]>([]),
    [ready, loaded] = useState(false),
    [failed, fail] = useState(false);
  const [id, select] = useState(
    () => localStorage.getItem("duet.companion") || "",
  );
  const [mode, edit] = useState<"new" | "edit" | null>(null);
  const active = rows.find((v) => v.id === id) || rows[0];
  useEffect(() => {
    let alive = true;
    fetch("/api/companions")
      .then(async (r) => {
        if (!r.ok) throw Error();
        const list = await r.json();
        if (alive) setRows(list);
      })
      .catch(() => {
        if (alive) fail(true);
      })
      .finally(() => {
        if (alive) loaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (active) localStorage.setItem("duet.companion", active.id);
  }, [active?.id]);
  function saved(c: Companion) {
    setRows((rs) =>
      rs.some((r) => r.id === c.id)
        ? rs.map((r) => (r.id === c.id ? c : r))
        : [...rs, c],
    );
    select(c.id);
    edit(null);
  }
  return (
    <div className="studio">
      <header className="studio-bar">
        <Brand />
        <div className="controls">
          <Language lang={lang} setLang={setLang} />
          <Button variant="ghost" onClick={logout}>
            {zh ? "退出" : "Sign out"}
          </Button>
        </div>
      </header>
      <div className="studio-columns">
        <aside className="people">
          <div className="topline">
            <h2>{zh ? "我的伙伴" : "Companions"}</h2>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => edit("new")}
              title={zh ? "创建伙伴" : "New companion"}
              aria-label={zh ? "创建伙伴" : "New companion"}
            >
              <Plus aria-hidden="true" />
            </Button>
          </div>
          <nav aria-label={zh ? "切换伙伴" : "Choose companion"}>
            {rows.map((c) => (
              <Button
                variant="ghost"
                className={"person" + (c.id === active?.id ? " selected" : "")}
                key={c.id}
                onClick={() => select(c.id)}
                aria-pressed={c.id === active?.id}
              >
                <Portrait name={c.name} id={c.id} />
                <span>{c.name}</span>
              </Button>
            ))}
          </nav>
        </aside>
        <main className="room">
          {!ready ? (
            <p>{zh ? "正在打开…" : "Opening…"}</p>
          ) : failed ? (
            <p role="alert">
              {zh
                ? "无法读取角色，请刷新重试。"
                : "Could not load companions. Refresh to retry."}
            </p>
          ) : active ? (
            <>
              <header className="room-bar">
                <div className="identity">
                  <Portrait name={active.name} id={active.id} />
                  <h1>{active.name}</h1>
                </div>
                <div className="controls">
                  <Memories
                    key={active.id}
                    companionId={active.id}
                    locale={lang}
                  />
                  <Button variant="outline" onClick={() => edit("edit")}>
                    <Settings aria-hidden="true" />
                    {zh ? "伙伴设置" : "Companion settings"}
                  </Button>
                </div>
              </header>
              <Conversation
                companion={active}
                lang={lang}
                renderCall={({
                  refresh,
                  busy,
                  conversationId,
                  setCallActive,
                }) => (
                  <CallPanel
                    companion={active}
                    lang={lang}
                    onHistoryChange={refresh}
                    disabled={busy || !conversationId}
                    conversationId={conversationId}
                    onActiveChange={setCallActive}
                  />
                )}
                renderMessageAction={(source) => (
                  <Remember
                    companionId={active.id}
                    locale={lang}
                    source={source}
                  />
                )}
              />
            </>
          ) : (
            <div className="room-welcome">
              <img src="/room.svg" alt="" />
              <h1>{zh ? "认识你的第一位伙伴" : "Meet your first companion"}</h1>
              <p>
                {zh
                  ? "为对方取个名字，选好你们聊天的语言。"
                  : "Give them a name and choose the language you’ll speak together."}
              </p>
              <Button variant="default" onClick={() => edit("new")}>
                {zh ? "创建第一位伙伴" : "Create your first companion"}
              </Button>
            </div>
          )}
        </main>
      </div>
      {mode && (
        <Editor
          key={mode + (active?.id || "")}
          companion={mode === "edit" ? active : undefined}
          lang={lang}
          onClose={() => edit(null)}
          onSave={saved}
          onDelete={(deleted) => {
            setRows((rs) => rs.filter((r) => r.id !== deleted));
            edit(null);
          }}
        />
      )}
    </div>
  );
}
