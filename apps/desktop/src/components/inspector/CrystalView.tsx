import { useEffect, useMemo, useRef, useState } from "react";
import type { AtomSpec, GLViewer } from "3dmol";
import { useTranslation } from "react-i18next";
import {
  CRYSTAL_LIMITS, CrystalError, cartesianToFractional, cellFromLattice, crystalDisplayAtoms,
  crystalNumber, crystalVolume, fractionalToCartesian, latticeFromCell, parseCrystal,
  serializeCrystal, validateLattice,
  type CoordinateMode, type CrystalDocument, type CrystalIssue, type Lattice, type Vector3,
} from "@/lib/crystal";

export interface CrystalViewProps {
  filename: string;
  text: string;
  /** The host owns file IO, approval and an atomic external-change check. Reject on failure. */
  onSave?: (nextText: string) => Promise<void>;
  saving?: boolean;
}

type Parsed = { kind: "ok"; document: CrystalDocument } | { kind: "error"; code: CrystalIssue };
const inputClass = "min-w-0 w-full rounded-input border border-border bg-surface px-2 py-1 text-xs text-text disabled:opacity-60";
const buttonClass = "rounded-input border border-border px-2 py-1 text-xs text-text hover:bg-surface-2 disabled:opacity-50";
const CELL_NAMES: readonly ("a" | "b" | "c" | "alpha" | "beta" | "gamma")[] = ["a", "b", "c", "alpha", "beta", "gamma"];
const TABLE_COLUMNS: readonly ("site" | "element" | "position" | "occupancy")[] = ["site", "element", "position", "occupancy"];

function parse(filename: string, text: string): Parsed {
  try { return { kind: "ok", document: parseCrystal(filename, text) }; }
  catch (error) { return { kind: "error", code: error instanceof CrystalError ? error.code : "invalidEdit" }; }
}

/** Host integration boundary. Changing filename starts a new editor with no carried-over edits. */
export function CrystalView(props: CrystalViewProps) {
  return <CrystalEditor key={props.filename} {...props} />;
}

function CrystalEditor({ filename, text, onSave, saving = false }: CrystalViewProps) {
  const { t } = useTranslation("inspector");
  const [parsed, setParsed] = useState(() => parse(filename, text));
  const [baseline, setBaseline] = useState(text);
  const [history, setHistory] = useState<CrystalDocument[]>([]);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<CoordinateMode>("direct");
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [formVersion, setFormVersion] = useState(0);
  const [uncommitted, setUncommitted] = useState(false);
  const pendingText = useRef<string | null>(null);
  const savingRef = useRef(false);
  const alive = useRef(true);
  const incoming = useRef(text);
  incoming.current = text;
  const normalizedBaseline = useMemo(() => {
    const original = parse(filename, baseline);
    return original.kind === "ok" && original.document.editable ? serializeCrystal(original.document) : baseline;
  }, [filename, baseline]);
  const dirty = useMemo(() => parsed.kind === "ok" && parsed.document.editable && serializeCrystal(parsed.document) !== normalizedBaseline, [parsed, normalizedBaseline]);
  const busy = saving || pending;
  const editable = parsed.kind === "ok" && parsed.document.editable && Boolean(onSave) && !busy;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (text === baseline || text === pendingText.current) return;
    if (dirty || uncommitted || savingRef.current) { setConflict(true); return; }
    setParsed(parse(filename, text));
    setBaseline(text);
    setSelected(0);
    setError(null);
    setConflict(false);
    setFormVersion((n) => n + 1);
    setUncommitted(false);
    // Only incoming file updates trigger this reconciliation. A successful save may precede a prop refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename, text]);

  const reset = () => {
    setParsed(parse(filename, incoming.current));
    setBaseline(incoming.current);
    setHistory([]);
    setConflict(false);
    setError(null);
    setSelected(0);
    setFormVersion((n) => n + 1);
    setUncommitted(false);
  };
  const edit = (change: (document: CrystalDocument) => CrystalDocument) => {
    if (!editable || parsed.kind !== "ok") return;
    try {
      const next = change(parsed.document);
      validateLattice(next.lattice);
      // Validate what would actually be written, including CIF orientation restrictions.
      if (serializeCrystal(next) === serializeCrystal(parsed.document)) return;
      setHistory((previous) => [...previous.slice(-29), parsed.document]);
      setParsed({ kind: "ok", document: next });
      setError(null);
    } catch (cause) {
      setError(t(`crystal.issues.${cause instanceof CrystalError ? cause.code : "invalidEdit"}`));
      setFormVersion((n) => n + 1);
    }
  };
  const save = async () => {
    if (!editable || !onSave || parsed.kind !== "ok" || !dirty || uncommitted || conflict || savingRef.current) return;
    savingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const nextText = serializeCrystal(parsed.document);
      pendingText.current = nextText;
      await onSave(nextText);
      if (!alive.current) return;
      if (incoming.current !== baseline && incoming.current !== nextText) {
        setConflict(true);
        return;
      }
      setParsed(parse(filename, nextText));
      setBaseline(nextText);
      setHistory([]);
      setConflict(false);
    } catch (cause) {
      if (alive.current) setError(t("crystal.saveError", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      savingRef.current = false;
      pendingText.current = null;
      if (alive.current) setPending(false);
    }
  };
  const downloadCopy = () => {
    if (parsed.kind !== "ok") return;
    try {
      const content = dirty ? serializeCrystal(parsed.document) : baseline;
      // A generic MIME type keeps browsers from renaming extensionless POSCAR/CONTCAR to .txt.
      const url = URL.createObjectURL(new Blob([content], { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = filename.split(/[/\\]/).pop() ?? filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(t("crystal.exportError", { error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };

  if (parsed.kind === "error") return <div role="alert" className="p-4 text-sm text-muted">{t(`crystal.issues.${parsed.code}`)}</div>;
  const doc = parsed.document;
  const atom = doc.atoms[selected];
  const parameters = cellFromLattice(doc.lattice);
  const coordinate = atom && (mode === "direct" ? atom.fractional : fractionalToCartesian(atom.fractional, doc.lattice));
  const pageStart = Math.floor(selected / 100) * 100;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-surface text-text" data-crystal-viewer="true">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <span className="text-xs font-medium">{t("crystal.title")}</span>
        <span className="text-xs text-muted">{t("crystal.sourceAtoms", { count: doc.atoms.length })}</span>
        <span role="status" className="text-xs text-muted">{t(dirty || uncommitted ? "crystal.unsaved" : "crystal.saved")}</span>
        <button type="button" className={buttonClass} disabled={!history.length || busy} onClick={() => {
          const previous = history[history.length - 1];
          if (previous) { setParsed({ kind: "ok", document: previous }); setHistory(history.slice(0, -1)); setError(null); setFormVersion((n) => n + 1); }
        }}>{t("crystal.undo")}</button>
        <button type="button" className={buttonClass} disabled={(!dirty && !uncommitted && !conflict) || busy} onClick={reset}>{t("crystal.reset")}</button>
        {onSave && <button type="button" className={buttonClass} disabled={!editable || !dirty || uncommitted || conflict} onClick={() => void save()}>{t(busy ? "crystal.saving" : "crystal.save")}</button>}
        <button type="button" className={buttonClass} disabled={busy || uncommitted} onClick={downloadCopy}>{t("crystal.saveAs")}</button>
      </div>
      {!onSave && <p className="px-3 py-1 text-xs text-muted">{t("crystal.readOnlyHost")}</p>}
      {doc.warnings.length > 0 && <ul className="space-y-1 px-3 py-2 text-xs text-muted" aria-label={t("crystal.warnings")}>
        {doc.warnings.map((warning) => <li key={warning}>{t(`crystal.issues.${warning}`)}</li>)}
      </ul>}
      {conflict && <p role="alert" className="px-3 py-2 text-xs text-error">{t("crystal.conflict")}</p>}
      {error && <p role="alert" className="px-3 py-2 text-xs text-error">{error}</p>}
      <CrystalScene document={doc} selected={selected} onSelect={setSelected} filename={filename} />
      <div className="space-y-3 p-3">
        <fieldset disabled={!editable} className="min-w-0 space-y-2">
          <legend className="text-xs font-medium">{t("crystal.lattice")}</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {parameters.map((value, i) => <label key={CELL_NAMES[i]} className="text-xs text-muted">
              {t(`crystal.cell.${CELL_NAMES[i]}`)}
              {doc.format === "cif" ? <NumericField key={`${formVersion}-${value}`} value={value} onDraft={setUncommitted} label={t(`crystal.cell.${CELL_NAMES[i]}`)} onCommit={(next) => edit((current) => {
                const p = [...cellFromLattice(current.lattice)]; p[i] = next;
                const conventional = latticeFromCell([p[0], p[1], p[2], p[3], p[4], p[5]]);
                // Cell parameters define the conventional CIF basis. POSCAR exposes vectors below.
                return { ...current, lattice: conventional };
              })} onInvalid={() => setError(t("crystal.issues.invalidNumber"))} /> : <output className="block py-1 font-mono text-text">{Number(value.toFixed(6))}</output>}
            </label>)}
          </div>
          {doc.format === "poscar" && <div className="grid grid-cols-3 gap-2">
            {doc.lattice.flatMap((v, i) => v.map((value, j) => <label key={`${i}-${j}`} className="text-xs text-muted">
              {t("crystal.vector", { vector: i + 1, axis: ["x", "y", "z"][j] })}
              <NumericField key={`${formVersion}-${value}`} value={value} onDraft={setUncommitted} label={t("crystal.vector", { vector: i + 1, axis: ["x", "y", "z"][j] })} onCommit={(next) => edit((current) => {
                const v = current.lattice.map((row) => [...row]); v[i][j] = next;
                const lattice: Lattice = [[v[0][0], v[0][1], v[0][2]], [v[1][0], v[1][1], v[1][2]], [v[2][0], v[2][1], v[2][2]]];
                return { ...current, lattice };
              })} onInvalid={() => setError(t("crystal.issues.invalidNumber"))} />
            </label>))}
          </div>}
        </fieldset>
        <p className="text-xs text-muted">{t("crystal.volume", { value: crystalVolume(doc.lattice).toFixed(4) })} {t("crystal.latticeHint")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs">{t("crystal.coordinateMode")}
            <select className={inputClass} value={mode} onChange={(event) => setMode(event.target.value === "cartesian" ? "cartesian" : "direct")}>
              <option value="direct">{t("crystal.direct")}</option>
              <option value="cartesian">{t("crystal.cartesian")}</option>
            </select>
          </label>
          <p className="text-xs text-muted">{t("crystal.fileMode", { mode: t(`crystal.${doc.coordinateMode}`) })}</p>
        </div>
        {atom && coordinate && <fieldset disabled={!editable} className="min-w-0 space-y-2">
          <legend className="text-xs font-medium">{t("crystal.selectedAtom", { index: selected + 1, element: atom.element })}</legend>
          <div className="grid grid-cols-3 gap-2">
            {coordinate.map((value, i) => <label key={i} className="text-xs text-muted">
              {t("crystal.coordinate", { axis: ["x", "y", "z"][i] })}
              <NumericField key={`${selected}-${mode}-${formVersion}-${value}`} value={value} onDraft={setUncommitted} label={t("crystal.coordinate", { axis: ["x", "y", "z"][i] })} onCommit={(next) => edit((current) => {
                const p = [...coordinate]; p[i] = next;
                const position: Vector3 = [p[0], p[1], p[2]];
                return { ...current, atoms: current.atoms.map((a, index) => index === selected ? { ...a,
                  fractional: mode === "direct" ? position : cartesianToFractional(position, current.lattice) } : a) };
              })} onInvalid={() => setError(t("crystal.issues.invalidNumber"))} />
            </label>)}
          </div>
          {atom.selective && <p className="text-xs text-muted">{t("crystal.selective", { flags: atom.selective.map((v) => v ? "T" : "F").join(" ") })}</p>}
        </fieldset>}
        <div className="flex items-center gap-2 text-xs text-muted">
          <button type="button" className={buttonClass} disabled={pageStart === 0} onClick={() => setSelected(Math.max(0, pageStart - 100))}>{t("crystal.previous")}</button>
          <span>{t("crystal.rows", { start: pageStart + 1, end: Math.min(pageStart + 100, doc.atoms.length), total: doc.atoms.length })}</span>
          <button type="button" className={buttonClass} disabled={pageStart + 100 >= doc.atoms.length} onClick={() => setSelected(pageStart + 100)}>{t("crystal.next")}</button>
        </div>
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-left text-xs" aria-label={t("crystal.atomTable")}>
            <thead className="sticky top-0 bg-surface"><tr>{TABLE_COLUMNS.map((key) => <th key={key} className="px-2 py-1">{t(`crystal.${key}`)}</th>)}</tr></thead>
            <tbody>{doc.atoms.slice(pageStart, pageStart + 100).map((a, row) => {
              const index = pageStart + row;
              const p = mode === "direct" ? a.fractional : fractionalToCartesian(a.fractional, doc.lattice);
              return <tr key={index} aria-selected={index === selected} className={index === selected ? "bg-surface-2" : ""}>
                <td className="px-2 py-1"><button type="button" className={buttonClass} aria-pressed={index === selected} onClick={() => setSelected(index)}>{index + 1}</button></td>
                <td className="px-2 py-1">{a.element}</td><td className="whitespace-nowrap px-2 py-1 font-mono">{p.map((n) => Number(n.toFixed(5))).join(", ")}</td>
                <td className="px-2 py-1">{a.occupancy === null ? t("crystal.unspecified") : a.occupancy}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function NumericField({ value, label, onCommit, onInvalid, onDraft }: { value: number; label: string; onCommit: (value: number) => void; onInvalid: () => void; onDraft: (pending: boolean) => void }) {
  const initial = Number(value.toPrecision(12)).toString();
  const [draft, setDraft] = useState(initial);
  const discard = useRef(false);
  const commit = () => {
    onDraft(false);
    if (discard.current) { discard.current = false; return; }
    try { const next = crystalNumber(draft); if (draft !== initial && next !== value) onCommit(next); }
    catch { onInvalid(); setDraft(initial); }
  };
  return <input className={inputClass} aria-label={label} inputMode="decimal" value={draft}
    onChange={(event) => { setDraft(event.target.value); onDraft(event.target.value !== initial); }} onBlur={commit}
    onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { discard.current = true; setDraft(initial); event.currentTarget.blur(); } }} />;
}

function CrystalScene({ document: doc, selected, onSelect, filename }: { document: CrystalDocument; selected: number; onSelect: (index: number) => void; filename: string }) {
  const { t } = useTranslation("inspector");
  const container = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<GLViewer | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [repetitions, setRepetitions] = useState<1 | 2>(1);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);
  const canRepeat = doc.atoms.length * 8 <= CRYSTAL_LIMITS.displayAtoms;
  const effectiveRepetitions = canRepeat ? repetitions : 1;
  const display = useMemo(() => crystalDisplayAtoms(doc, effectiveRepetitions), [doc, effectiveRepetitions]);
  useEffect(() => { if (!canRepeat) setRepetitions(1); }, [canRepeat]);
  useEffect(() => {
    const node = container.current;
    return () => { viewerRef.current?.clear(); viewerRef.current = null; node?.replaceChildren(); };
  }, []);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    let cancelled = false;
    let viewer: GLViewer | null = null;
    setRendering(true);
    setError(null);
    void (async () => {
      try {
        const canvas = window.document.createElement("canvas");
        if (!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"))) throw new Error(t("crystal.webglUnavailable"));
        const mol = await import("3dmol");
        if (cancelled) return;
        // Reuse the context across edits and periodic-copy changes.
        viewer = viewerRef.current ?? mol.createViewer(node, { backgroundColor: "white" });
        viewerRef.current = viewer;
        viewer.clear();
        const model = viewer.addModel();
        model.addAtoms(display.map((a, i) => ({ elem: a.element, x: a.cartesian[0], y: a.cartesian[1], z: a.cartesian[2], serial: i, index: i,
          properties: { sourceIndex: a.sourceIndex } })));
        viewer.setStyle({}, { sphere: { colorscheme: "Jmol", radius: 0.25 } });
        viewer.setStyle({ properties: { sourceIndex: selectedRef.current } }, { sphere: { color: "#f59e0b", radius: 0.35 } });
        // Explicit source mapping makes selecting an image select the original site.
        viewer.setClickable({}, true, (atom: AtomSpec) => {
          const index: unknown = atom.properties?.sourceIndex;
          if (typeof index === "number" && Number.isInteger(index) && index >= 0 && index < doc.atoms.length) onSelect(index);
        });
        const corners: Vector3[] = [];
        for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) corners.push([x, y, z]);
        const point = (p: Vector3) => { const [x, y, z] = fractionalToCartesian(p, doc.lattice); return { x, y, z }; };
        corners.forEach((a, i) => corners.slice(i + 1).forEach((b) => {
          if (a.filter((n, axis) => n !== b[axis]).length === 1) viewer?.addLine({ start: point(a), end: point(b), color: "#64748b" });
        }));
        viewer.zoomTo(); viewer.render();
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { if (!cancelled) setRendering(false); }
    })();
    return () => { cancelled = true; };
  }, [doc, display, onSelect, t]);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || rendering) return;
    viewer.setStyle({}, { sphere: { colorscheme: "Jmol", radius: 0.25 } });
    viewer.setStyle({ properties: { sourceIndex: selected } }, { sphere: { color: "#f59e0b", radius: 0.35 } });
    viewer.render();
  }, [selected, rendering]);
  useEffect(() => {
    const node = container.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { viewerRef.current?.resize(); viewerRef.current?.render(); });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div className="relative min-h-[260px] shrink-0 border-b border-border bg-white">
    <div ref={container} className="absolute inset-0" aria-label={t("crystal.viewer", { filename })} />
    <div className="absolute left-2 top-2 flex flex-wrap items-center gap-2 rounded-input border border-border bg-surface/95 p-1 text-xs text-text">
      <label>{t("crystal.periodicCopies")} <select value={repetitions} className={inputClass} onChange={(event) => setRepetitions(event.target.value === "2" ? 2 : 1)}>
        <option value="1">{t("crystal.singleCell")}</option><option value="2" disabled={!canRepeat}>{t("crystal.supercell")}</option>
      </select></label>
      <button type="button" className={buttonClass} onClick={() => { viewerRef.current?.zoomTo(); viewerRef.current?.render(); }}>{t("crystal.resetView")}</button>
    </div>
    <p className="pointer-events-none absolute bottom-2 left-2 right-2 rounded-input bg-surface/95 px-2 py-1 text-xs text-muted">{rendering ? t("crystal.rendering") : error ?? t("crystal.displayAtoms", { count: display.length })}</p>
  </div>;
}
