import { Button } from "./components/ui/button";
export type Lang = "zh" | "en";
export function Brand() {
  return (
    <span className="brand">
      <img src="/mark.svg" alt="" />
      DuetRoom
    </span>
  );
}
export function Language({
  lang,
  setLang,
}: {
  lang: Lang;
  setLang: (lang: Lang) => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={() => setLang(lang === "zh" ? "en" : "zh")}
      lang={lang === "zh" ? "en" : "zh"}
    >
      {lang === "zh" ? "English" : "中文"}
    </Button>
  );
}
