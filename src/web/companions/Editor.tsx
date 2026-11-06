import { RoomDialog } from "../components/RoomDialog";
import { Label } from "../components/ui/label";
import { NativeSelect } from "../components/ui/native-select";
import { Textarea } from "../components/ui/textarea";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { useEffect, useState, type FormEvent } from "react";
import type { Companion, CompanionInput } from "../../shared/companion";
import type { Lang } from "../ui";
export default function Editor({
  companion,
  lang,
  onClose,
  onSave,
  onDelete,
}: {
  companion?: Companion;
  lang: Lang;
  onClose: () => void;
  onSave: (c: Companion) => void;
  onDelete: (id: string) => void;
}) {
  const zh = lang === "zh";
  const [input, setInput] = useState<CompanionInput>(
    companion
      ? {
          name: companion.name,
          persona: companion.persona,
          locale: companion.locale,
          voice: companion.voice,
        }
      : { name: "", persona: "", locale: zh ? "zh-CN" : "en-US", voice: "" },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [deleting, setDeleting] = useState(false);
  const [voices, setVoices] = useState<
    { id: string; name: string; locale: string }[]
  >([]);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/call/voices", { signal: abort.signal })
      .then(async (r) => {
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data.voices)) setVoices(data.voices);
        }
      })
      .catch(() => {});
    return () => abort.abort();
  }, []);
  const update = (field: keyof CompanionInput, value: string) =>
    setInput((v) => ({ ...v, [field]: value }));
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const r = await fetch(
        "/api/companions" + (companion ? "/" + companion.id : ""),
        {
          method: companion ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!r.ok) throw Error();
      onSave(await r.json());
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!companion || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/companions/" + companion.id, {
        method: "DELETE",
      });
      if (!r.ok) throw Error();
      onDelete(companion.id);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <RoomDialog
      className="editor"
      title={
        deleting
          ? zh
            ? "删除伙伴？"
            : "Delete companion?"
          : companion
            ? zh
              ? "伙伴设置"
              : "Companion settings"
            : zh
              ? "创建伙伴"
              : "New companion"
      }
      closeLabel={zh ? "关闭" : "Close"}
      onClose={onClose}
      busy={busy}
    >
      {deleting ? (
        <>
          <p>
            {zh
              ? "此伙伴的对话和记忆也将被删除。"
              : "This also deletes their conversations and memories."}
          </p>
          <div className="actions">
            <Button variant="outline" onClick={() => setDeleting(false)}>
              {zh ? "取消" : "Cancel"}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={remove}>
              {zh ? "确认删除" : "Confirm deletion"}
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={save}>
          <Label className="form-field">
            {zh ? "名字" : "Name"}
            <Input
              autoFocus
              required
              value={input.name}
              maxLength={80}
              onChange={(e) => update("name", e.target.value)}
            />
          </Label>
          <Label className="form-field">
            {zh ? "性格" : "Personality"}
            <Textarea
              value={input.persona}
              rows={3}
              maxLength={2000}
              placeholder={
                zh
                  ? "例如，温和、有主见，喜欢聊电影。"
                  : "For example, thoughtful, curious, and fond of cinema."
              }
              onChange={(e) => update("persona", e.target.value)}
            />
          </Label>
          <Label className="form-field">
            {zh ? "对话语言" : "Conversation language"}
            <NativeSelect
              value={input.locale}
              onChange={(e) =>
                setInput((v) => ({ ...v, locale: e.target.value, voice: "" }))
              }
            >
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </NativeSelect>
          </Label>
          <Label className="form-field">
            {zh ? "音色" : "Voice"}
            <NativeSelect
              value={input.voice}
              onChange={(e) => update("voice", e.target.value)}
            >
              <option value="">
                {zh ? "按对话语言自动选择" : "Choose automatically by language"}
              </option>
              {input.voice && !voices.some((v) => v.id === input.voice) && (
                <option value={input.voice}>{input.voice}</option>
              )}
              {voices
                .filter((v) => v.locale === input.locale)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
            </NativeSelect>
          </Label>
          <div className="actions">
            {companion && (
              <Button
                variant="ghost"
                className="text-destructive mr-auto"
                type="button"
                onClick={() => setDeleting(true)}
              >
                {zh ? "删除" : "Delete"}
              </Button>
            )}
            <Button variant="outline" type="button" onClick={onClose}>
              {zh ? "取消" : "Cancel"}
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={busy || !input.name.trim()}
            >
              {zh ? "保存" : "Save"}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="feedback">
          {zh ? "操作失败，请重试。" : "Could not save this change. Try again."}
        </p>
      )}
    </RoomDialog>
  );
}
