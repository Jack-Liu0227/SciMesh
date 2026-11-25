import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { journalStatus, setJournalKey, deleteJournalKey, journalLookup, journalErrorCode, type JournalErrorCode } from "@/lib/journal";
import { isTauri } from "@/lib/tauri";
import { isGatewayWeb } from "@/lib/webMode";
import { Section } from "./Section";

type Status = { kind: "loading" } | { kind: "ready"; configured: boolean } | { kind: "error"; code: JournalErrorCode };
type Notice = { kind: "success"; message: "saved" | "removed" | "testSuccess" } | { kind: "error"; code: JournalErrorCode } | null;

export function EasyScholarCard() {
  const { t } = useTranslation("settings");
  const id = useId();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [key, setKey] = useState("");
  const [publication, setPublication] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const desktop = isTauri && !isGatewayWeb;

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void journalStatus().then((value) => {
      if (active) setStatus({ kind: "ready", configured: value.configured });
    }).catch((error: unknown) => {
      if (active) setStatus({ kind: "error", code: journalErrorCode(error) });
    });
    return () => { active = false; };
  }, [desktop]);

  if (!desktop) return null;
  const configured = status.kind === "ready" && status.configured;
  const action = async (operation: "save" | "remove" | "test") => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const pendingKey = key;
    setKey("");
    try {
      if (operation === "test") {
        await journalLookup(publication);
        setNotice({ kind: "success", message: "testSuccess" });
      } else {
        const value = operation === "save" ? await setJournalKey(pendingKey) : await deleteJournalKey();
        setStatus({ kind: "ready", configured: value.configured });
        setNotice({ kind: "success", message: operation === "save" ? "saved" : "removed" });
      }
    } catch (error) {
      setNotice({ kind: "error", code: journalErrorCode(error) });
    } finally { setBusy(false); }
  };

  return (
    <Section title={t("journal.title")} hint={t("journal.hint")}>
      <div className="space-y-3 text-xs">
        <p role="status" className="text-muted">
          {status.kind === "loading" ? t("journal.checking") : status.kind === "error" ? t(`journal.errors.${status.code}`) : t(configured ? "journal.configured" : "journal.notConfigured")}
        </p>
        <label htmlFor={`${id}-key`} className="block text-text">{t("journal.keyLabel")}</label>
        <input id={`${id}-key`} type="password" value={key} autoComplete="off" spellCheck={false}
          disabled={busy} maxLength={512} onChange={(event) => setKey(event.target.value)}
          className="w-full min-w-0 rounded border border-border bg-surface px-3 py-2 text-text" />
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy || status.kind === "loading" || !key.trim()} onClick={() => void action("save")} className="rounded border border-border px-3 py-2 disabled:opacity-40">{t("journal.save")}</button>
          <button type="button" disabled={busy || !configured} onClick={() => void action("remove")} className="rounded border border-border px-3 py-2 disabled:opacity-40">{t("journal.remove")}</button>
        </div>
        <p className="text-muted">{t("journal.storageHint")}</p>
        <label htmlFor={`${id}-publication`} className="block text-text">{t("journal.testPublication")}</label>
        <input id={`${id}-publication`} type="text" value={publication} disabled={busy} maxLength={512}
          onChange={(event) => setPublication(event.target.value)}
          className="w-full min-w-0 rounded border border-border bg-surface px-3 py-2 text-text" />
        <p className="text-muted">{t("journal.testHint")}</p>
        <button type="button" disabled={busy || !configured || !publication.trim() || /^(?:10\.|doi:|https?:)/i.test(publication.trim())}
          onClick={() => void action("test")} className="rounded border border-border px-3 py-2 disabled:opacity-40">{t(busy ? "journal.working" : "journal.test")}</button>
        {notice && <p role={notice.kind === "error" ? "alert" : "status"} className="break-words text-muted">{notice.kind === "error" ? t(`journal.errors.${notice.code}`) : t(`journal.${notice.message}`)}</p>}
      </div>
    </Section>
  );
}
