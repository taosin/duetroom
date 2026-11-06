import { Alert, AlertDescription } from "./components/ui/alert";
import { Label } from "./components/ui/label";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { useState, type FormEvent } from "react";
import { Brand, Language, type Lang } from "./ui";

export default function Login({
  lang,
  setLang,
  onLogin,
}: {
  lang: Lang;
  setLang: (l: Lang) => void;
  onLogin: () => void;
}) {
  const zh = lang === "zh";
  const [password, setPassword] = useState(""),
    [visible, show] = useState(false),
    [busy, wait] = useState(false),
    [error, fail] = useState(0);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    wait(true);
    fail(0);
    try {
      const r = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.ok) {
        onLogin();
        return;
      }
      fail(r.status);
    } catch {
      fail(503);
    } finally {
      wait(false);
    }
  }
  return (
    <main className="gate">
      <section className="gate-main">
        <header className="topline">
          <Brand />
          <Language lang={lang} setLang={setLang} />
        </header>
        <div className="gate-content">
          <h1>{zh ? "欢迎回来" : "Welcome back."}</h1>
          <p>
            {zh
              ? "输入主人口令，打开你的房间。"
              : "Use your owner password to enter your room."}
          </p>
          <form onSubmit={submit}>
            <Label htmlFor="password">
              {zh ? "主人口令" : "Owner password"}
            </Label>
            <div className="secret">
              <Input
                autoComplete="current-password"
                id="password"
                type={visible ? "text" : "password"}
                required
                value={password}
                maxLength={512}
                onChange={(e) => setPassword(e.target.value)}
              />
              <Button
                variant="ghost"
                type="button"
                onClick={() => show(!visible)}
              >
                {visible ? (zh ? "隐藏" : "Hide") : zh ? "显示" : "Show"}
              </Button>
            </div>
            {error > 0 && (
              <Alert variant="destructive">
                <AlertDescription>
                  {error === 401
                    ? zh
                      ? "口令不正确，请重试。"
                      : "Incorrect password. Try again."
                    : error === 429
                      ? zh
                        ? "请稍后再试。"
                        : "Please try again in a minute."
                      : zh
                        ? "无法登录，请检查服务地址。"
                        : "Could not sign in. Check the service address."}
                </AlertDescription>
              </Alert>
            )}
            <Button type="submit" variant="default" disabled={busy}>
              {busy ? "…" : zh ? "进入房间　→" : "Enter room　→"}
            </Button>
          </form>
        </div>
        <span className="selfhost">
          {zh ? "个人部署" : "Self-hosted instance"}
        </span>
      </section>
      <div
        className="gate-art"
        role="img"
        aria-label={
          zh ? "窗边两把相对的椅子" : "Two chairs beside an open window"
        }
      />
    </main>
  );
}
