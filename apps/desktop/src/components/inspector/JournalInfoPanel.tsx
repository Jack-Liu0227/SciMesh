import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { journalLookup, journalErrorCode, type JournalErrorCode, type JournalInfo } from "@/lib/journal";

type Result = { kind: "idle" } | { kind: "loading" } | { kind: "success"; info: JournalInfo } | { kind: "error"; code: JournalErrorCode };

export function JournalInfoPanel({ initialQuery = "" }: { initialQuery?: string }) {
  const { t, i18n } = useTranslation("settings");
  const id = useId();
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setQuery(initialQuery);
    setResult({ kind: "idle" });
    return () => { generation.current += 1; };
  }, [initialQuery]);

  const lookup = async () => {
    const request = ++generation.current;
    setResult({ kind: "loading" });
    try {
      const info = await journalLookup(query);
      if (generation.current === request) setResult({ kind: "success", info });
    } catch (error) {
      if (generation.current === request) setResult({ kind: "error", code: journalErrorCode(error) });
    }
  };

  const info = result.kind === "success" ? result.info : null;
  const metrics = info ? [
    { label: t("journal.impactFactor"), metric: info.impactFactor },
    { label: t("journal.impactFactor5Year"), metric: info.impactFactor5Year },
    { label: t("journal.jcrQuartile"), metric: info.jcrQuartile },
    { label: t("journal.casPartition"), metric: info.casPartition },
  ] : [];

  return (
    <section className="min-w-0 space-y-3 p-4 text-xs" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="font-medium text-text">{t("journal.panelTitle")}</h3>
      <form onSubmit={(event) => { event.preventDefault(); if (query.trim() && result.kind !== "loading") void lookup(); }} className="space-y-2">
        <label htmlFor={`${id}-query`} className="block text-muted">{t("journal.queryLabel")}</label>
        <input id={`${id}-query`} type="text" value={query} maxLength={512}
          onChange={(event) => { generation.current += 1; setQuery(event.target.value); setResult({ kind: "idle" }); }}
          className="w-full min-w-0 rounded border border-border bg-surface px-3 py-2 text-text" />
        <p className="text-muted">{t("journal.lookupHint")}</p>
        <button type="submit" disabled={!query.trim() || result.kind === "loading"} className="rounded border border-border px-3 py-2 disabled:opacity-40">{t(result.kind === "loading" ? "journal.working" : "journal.lookup")}</button>
      </form>
      {result.kind === "error" && <p role="alert" className="break-words text-muted">{t(`journal.errors.${result.code}`)}</p>}
      {info && <div role="status" className="min-w-0 space-y-3">
        <p className="break-words font-medium text-text">{info.publicationName}</p>
        {info.doi && <p className="break-all text-muted">{t("journal.doi", { value: info.doi })}</p>}
        {info.issns.length > 0 && <p className="break-words text-muted">{t("journal.issns", { value: info.issns.join(", ") })}</p>}
        <dl className="space-y-2">
          {metrics.map(({ label, metric }) => <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-2">
            <dt className="text-muted">{label}</dt>
            <dd className="text-right text-text">
              <span>{metric === null ? t("journal.missing") : metric.value}</span>
              {metric !== null && <span className="ml-2 text-muted">{metric.year === null ? t("journal.yearUnknown") : t("journal.metricYear", { year: metric.year })}</span>}
            </dd>
          </div>)}
        </dl>
        <p className="text-muted">{t("journal.source", { source: info.source })}</p>
        <p className="text-muted">{t("journal.fetchedAt", { time: new Date(info.fetchedAt * 1000).toLocaleString(i18n.language) })}</p>
        <p className="text-muted">{t("journal.yearHint")}</p>
      </div>}
    </section>
  );
}
