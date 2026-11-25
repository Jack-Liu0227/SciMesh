/** Bounded crystal IO. Coordinates belong to source sites; periodic images are display-only. */
export type Vector3 = readonly [number, number, number];
export type Lattice = readonly [Vector3, Vector3, Vector3];
export type CoordinateMode = "direct" | "cartesian";
export type CellParameters = readonly [number, number, number, number, number, number];
export const CRYSTAL_LIMITS = { textLength: 2_000_000, atoms: 5_000, tokens: 150_000, displayAtoms: 12_000 };

export type CrystalIssue =
  | "tooLarge" | "unsupportedFormat" | "invalidNumber" | "invalidLattice" | "invalidPoscar"
  | "missingSpecies" | "invalidCif" | "missingCell" | "missingAtoms" | "readOnly" | "invalidEdit"
  | "displayLimit" | "multipleBlocks" | "unknownSymmetry" | "partialOccupancy"
  | "unknownOccupancy" | "unspecifiedOccupancy" | "unsupportedCif" | "uncertainty" | "poscarTail";

export class CrystalError extends Error {
  constructor(public readonly code: CrystalIssue) {
    super(code);
    this.name = "CrystalError";
  }
}

export interface CrystalAtom {
  readonly element: string;
  readonly label: string;
  readonly fractional: Vector3;
  /** null means unspecified or unknown, never an invented unit occupancy. */
  readonly occupancy: number | null;
  readonly selective: readonly [boolean, boolean, boolean] | null;
}

interface Span { readonly start: number; readonly end: number }
interface CifToken extends Span { readonly value: string; readonly bare: boolean }
interface SiteSource { readonly element: string; readonly coordinates: readonly [Span, Span, Span] }
type CrystalSource =
  | { readonly kind: "poscar"; readonly lines: readonly string[]; readonly eol: string;
      readonly atomStart: number; readonly suffixes: readonly string[]; readonly elements: readonly string[] }
  | { readonly kind: "cif"; readonly cell: readonly [Span, Span, Span, Span, Span, Span];
      readonly sites: readonly SiteSource[] };

export interface CrystalDocument {
  readonly format: "poscar" | "cif";
  readonly sourceText: string;
  readonly source: CrystalSource;
  readonly lattice: Lattice;
  readonly atoms: readonly CrystalAtom[];
  readonly coordinateMode: CoordinateMode;
  readonly editable: boolean;
  readonly warnings: readonly CrystalIssue[];
}

const ELEMENTS = new Set(("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn " +
  "Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd " +
  "Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf " +
  "Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og").split(" "));
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\(\d+\))?(?:[eEdD][+-]?\d+)?$/;

function numeric(text: string): number {
  if (!NUMBER.test(text)) throw new CrystalError("invalidNumber");
  const value = Number(text.replace(/\(\d+\)/, "").replace(/[dD]/, "e"));
  if (!Number.isFinite(value) || Math.abs(value) > 1e9) throw new CrystalError("invalidNumber");
  return value;
}

/** Validate a user-entered number without accepting blank strings, NaN, or Infinity. */
export function crystalNumber(text: string): number { return numeric(text.trim()); }

function vector(values: readonly string[]): Vector3 {
  if (values.length < 3) throw new CrystalError("invalidNumber");
  return [numeric(values[0]), numeric(values[1]), numeric(values[2])];
}
function cross(a: Vector3, b: Vector3): Vector3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vector3, b: Vector3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function crystalVolume(lattice: Lattice): number { return Math.abs(dot(lattice[0], cross(lattice[1], lattice[2]))); }

export function validateLattice(lattice: Lattice): void {
  const lengths = lattice.map((v) => Math.hypot(...v));
  if (lattice.some((v) => v.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e6)) ||
      lengths.some((n) => n < 1e-6 || n > 1e6) ||
      crystalVolume(lattice) / (lengths[0] * lengths[1] * lengths[2]) < 1e-8) {
    throw new CrystalError("invalidLattice");
  }
}

export function fractionalToCartesian(f: Vector3, lattice: Lattice): Vector3 {
  const axis = (j: number) => f[0] * lattice[0][j] + f[1] * lattice[1][j] + f[2] * lattice[2][j];
  return [axis(0), axis(1), axis(2)];
}
export function cartesianToFractional(c: Vector3, lattice: Lattice): Vector3 {
  validateLattice(lattice);
  const determinant = dot(lattice[0], cross(lattice[1], lattice[2]));
  return [dot(c, cross(lattice[1], lattice[2])) / determinant,
    dot(c, cross(lattice[2], lattice[0])) / determinant, dot(c, cross(lattice[0], lattice[1])) / determinant];
}

export function latticeFromCell([a, b, c, alpha, beta, gamma]: CellParameters): Lattice {
  if ([a, b, c].some((n) => !Number.isFinite(n) || n <= 0) ||
      [alpha, beta, gamma].some((n) => !Number.isFinite(n) || n <= 0 || n >= 180)) throw new CrystalError("invalidLattice");
  const radians = Math.PI / 180;
  const ca = Math.cos(alpha * radians), cb = Math.cos(beta * radians), cg = Math.cos(gamma * radians);
  const sg = Math.sin(gamma * radians);
  const cy = c * (ca - cb * cg) / sg;
  const cz2 = c * c - (c * cb) ** 2 - cy * cy;
  if (cz2 <= 0) throw new CrystalError("invalidLattice");
  const lattice: Lattice = [[a, 0, 0], [b * cg, b * sg, 0], [c * cb, cy, Math.sqrt(cz2)]];
  validateLattice(lattice);
  return lattice;
}

export function cellFromLattice(lattice: Lattice): CellParameters {
  validateLattice(lattice);
  const [a, b, c] = lattice.map((v) => Math.hypot(...v));
  const angle = (u: Vector3, v: Vector3) => Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (Math.hypot(...u) * Math.hypot(...v))))) * 180 / Math.PI;
  return [a, b, c, angle(lattice[1], lattice[2]), angle(lattice[0], lattice[2]), angle(lattice[0], lattice[1])];
}

export function isCrystalFile(filename: string): boolean {
  return /(?:^|[/\\])(?:POSCAR|CONTCAR)$/i.test(filename) || /\.(?:vasp|cif)$/i.test(filename);
}

export function parseCrystal(filename: string, text: string): CrystalDocument {
  if (text.length > CRYSTAL_LIMITS.textLength) throw new CrystalError("tooLarge");
  if (!isCrystalFile(filename)) throw new CrystalError("unsupportedFormat");
  const document = /\.cif$/i.test(filename) ? parseCif(text) : parsePoscar(text);
  if (document.atoms.some((a) => [...a.fractional, ...fractionalToCartesian(a.fractional, document.lattice)].some((n) => !Number.isFinite(n) || Math.abs(n) > 1e9))) throw new CrystalError("invalidNumber");
  return document;
}

function parsePoscar(text: string): CrystalDocument {
  const lines = text.split(/\r?\n/);
  if (lines.length < 8) throw new CrystalError("invalidPoscar");
  const words = (index: number) => (lines[index] ?? "").trim().split(/\s+/);
  const scales = words(1).map(numeric);
  if (scales.length !== 1 || scales[0] === 0) throw new CrystalError("invalidPoscar");
  const raw: Lattice = [vector(words(2)), vector(words(3)), vector(words(4))];
  validateLattice(raw);
  const scale = scales[0] < 0 ? Math.cbrt(-scales[0] / crystalVolume(raw)) : scales[0];
  const multiply = (v: Vector3): Vector3 => [v[0] * scale, v[1] * scale, v[2] * scale];
  const lattice: Lattice = [multiply(raw[0]), multiply(raw[1]), multiply(raw[2])];
  validateLattice(lattice);
  const species = words(5);
  if (species.some((s) => !ELEMENTS.has(s))) throw new CrystalError("missingSpecies");
  const counts = words(6).map((s) => /^\d+$/.test(s) ? Number(s) : NaN);
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (counts.length !== species.length || counts.some((n) => !Number.isSafeInteger(n) || n < 0) || total < 1) throw new CrystalError("invalidPoscar");
  if (total > CRYSTAL_LIMITS.atoms) throw new CrystalError("tooLarge");
  const selective = /^s/i.test(lines[7].trim());
  const modeIndex = selective ? 8 : 7;
  const modeLine = lines[modeIndex]?.trim() ?? "";
  if (!/^(?:d|c|k)/i.test(modeLine)) throw new CrystalError("invalidPoscar");
  const coordinateMode: CoordinateMode = /^d/i.test(modeLine) ? "direct" : "cartesian";
  const atomStart = modeIndex + 1;
  const atoms: CrystalAtom[] = [];
  const suffixes: string[] = [];
  let site = 0;
  for (let group = 0; group < species.length; group++) {
    for (let n = 0; n < counts[group]; n++, site++) {
      const line = lines[atomStart + site];
      if (!line) throw new CrystalError("invalidPoscar");
      const values = [...line.matchAll(/\S+/g)];
      const coordinates = vector(values.map((v) => v[0]));
      let flags: CrystalAtom["selective"] = null;
      if (selective) {
        if (values.length < 6 || values.slice(3, 6).some((v) => !/^[tf]$/i.test(v[0]))) throw new CrystalError("invalidPoscar");
        flags = [values[3][0].toUpperCase() === "T", values[4][0].toUpperCase() === "T", values[5][0].toUpperCase() === "T"];
      }
      const last = values[selective ? 5 : 2];
      suffixes.push(line.slice(last.index + last[0].length));
      atoms.push({ element: species[group], label: `${species[group]}${site + 1}`,
        fractional: coordinateMode === "direct" ? coordinates : cartesianToFractional(multiply(coordinates), lattice),
        occupancy: null, selective: flags });
    }
  }
  const tail = lines.slice(atomStart + total).some((line) => line.trim());
  return { format: "poscar", sourceText: text, lattice, atoms, coordinateMode, editable: !tail,
    warnings: tail ? ["poscarTail"] : [],
    source: { kind: "poscar", lines, eol: text.includes("\r\n") ? "\r\n" : "\n", atomStart, suffixes, elements: atoms.map((a) => a.element) } };
}

/** CIF 1.1 tokenization, including quoted values, comments and column-one text fields. */
function cifTokens(text: string): CifToken[] {
  const tokens: CifToken[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text[i] === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
    const start = i;
    const quote = text[i];
    let value: string, bare = true;
    if (quote === ";" && (i === 0 || text[i - 1] === "\n")) {
      bare = false;
      const close = text.indexOf("\n;", i + 1);
      if (close < 0) throw new CrystalError("invalidCif");
      value = text.slice(i + 1, close);
      i = close + 2;
      if (i < text.length && !/\s/.test(text[i])) throw new CrystalError("invalidCif");
    } else if (quote === "'" || quote === '"') {
      bare = false;
      i++;
      const content = i;
      while (i < text.length && !(text[i] === quote && (i + 1 === text.length || /\s/.test(text[i + 1])))) i++;
      if (i === text.length) throw new CrystalError("invalidCif");
      value = text.slice(content, i++);
    } else {
      while (i < text.length && !/\s/.test(text[i])) i++;
      value = text.slice(start, i);
    }
    tokens.push({ value, start, end: i, bare });
    if (tokens.length > CRYSTAL_LIMITS.tokens) throw new CrystalError("tooLarge");
  }
  return tokens;
}

const CELL_TAGS = ["_cell_length_a", "_cell_length_b", "_cell_length_c", "_cell_angle_alpha", "_cell_angle_beta", "_cell_angle_gamma"];
const FRACT_TAGS = ["_atom_site_fract_x", "_atom_site_fract_y", "_atom_site_fract_z"];
const CART_TAGS = ["_atom_site_cartn_x", "_atom_site_cartn_y", "_atom_site_cartn_z"];
const SYMMETRY_OPS = ["_space_group_symop_operation_xyz", "_symmetry_equiv_pos_as_xyz"];
const GROUP_NUMBERS = ["_space_group_it_number", "_symmetry_int_tables_number"];
const GROUP_NAMES = ["_space_group_name_h-m_alt", "_symmetry_space_group_name_h-m"];
const SITE_TAGS = ["_atom_site_label", "_atom_site_type_symbol", "_atom_site_occupancy", ...FRACT_TAGS, ...CART_TAGS];

function parseCif(text: string): CrystalDocument {
  const tokens = cifTokens(text);
  const blocks = tokens.filter((t) => t.bare && /^data_/i.test(t.value));
  if (!blocks.length || blocks[0].start !== tokens[0]?.start) throw new CrystalError("invalidCif");
  const firstEnd = blocks[1]?.start ?? text.length;
  const active = tokens.filter((t) => t.start > blocks[0].start && t.start < firstEnd);
  const scalars = new Map<string, CifToken>();
  const loops: { tags: string[]; rows: CifToken[][] }[] = [];
  const seen = new Set<string>();
  const warnings = new Set<CrystalIssue>();
  if (blocks.length > 1) warnings.add("multipleBlocks");
  const reserved = (t: CifToken) => t.bare && /^(?:_|loop_$|stop_$|global_$|save_)/i.test(t.value);
  for (let i = 0; i < active.length;) {
    const token = active[i++];
    if (token.bare && token.value.toLowerCase() === "loop_") {
      const tags: string[] = [];
      while (i < active.length && active[i].bare && active[i].value.startsWith("_")) tags.push(active[i++].value.toLowerCase());
      if (!tags.length) throw new CrystalError("invalidCif");
      const values: CifToken[] = [];
      while (i < active.length && !reserved(active[i])) values.push(active[i++]);
      if (!values.length || values.length % tags.length) throw new CrystalError("invalidCif");
      const rows: CifToken[][] = [];
      for (let j = 0; j < values.length; j += tags.length) rows.push(values.slice(j, j + tags.length));
      loops.push({ tags, rows });
      for (const tag of tags) {
        if (seen.has(tag)) throw new CrystalError("invalidCif");
        seen.add(tag);
      }
    } else if (token.bare && token.value.startsWith("_")) {
      const value = active[i++];
      const tag = token.value.toLowerCase();
      if (!value || reserved(value) || seen.has(tag)) throw new CrystalError("invalidCif");
      scalars.set(tag, value);
      seen.add(tag);
    } else {
      // Save frames and CIF 2 constructs require a full crystallographic parser.
      throw new CrystalError("invalidCif");
    }
  }
  const required = (tag: string): CifToken => {
    const token = scalars.get(tag);
    if (!token || /^[.?]$/.test(token.value)) throw new CrystalError("missingCell");
    return token;
  };
  const cell: readonly [CifToken, CifToken, CifToken, CifToken, CifToken, CifToken] = [required(CELL_TAGS[0]), required(CELL_TAGS[1]), required(CELL_TAGS[2]), required(CELL_TAGS[3]), required(CELL_TAGS[4]), required(CELL_TAGS[5])];
  const lattice = latticeFromCell([numeric(cell[0].value), numeric(cell[1].value), numeric(cell[2].value), numeric(cell[3].value), numeric(cell[4].value), numeric(cell[5].value)]);
  const atomLoops = loops.filter((loop) => loop.tags.some((tag) => FRACT_TAGS.includes(tag) || CART_TAGS.includes(tag)));
  const atomLoop = atomLoops[0];
  if (!atomLoop) throw new CrystalError("missingAtoms");
  if (atomLoops.length > 1) warnings.add("unsupportedCif");
  const fractional = FRACT_TAGS.every((tag) => atomLoop.tags.includes(tag));
  const cartesian = CART_TAGS.every((tag) => atomLoop.tags.includes(tag));
  if (!fractional && !cartesian) throw new CrystalError("missingAtoms");
  if (fractional && cartesian) warnings.add("unsupportedCif");
  const coordTags = fractional ? FRACT_TAGS : CART_TAGS;
  const atoms: CrystalAtom[] = [], sites: SiteSource[] = [];
  if (atomLoop.rows.length > CRYSTAL_LIMITS.atoms) throw new CrystalError("tooLarge");
  for (const row of atomLoop.rows) {
    const get = (tag: string) => row[atomLoop.tags.indexOf(tag)];
    const label = get("_atom_site_label")?.value;
    const symbol = get("_atom_site_type_symbol")?.value ?? label?.match(/^([A-Z][a-z]?)(?:\d+)?$/)?.[1];
    const element = symbol?.match(/^([A-Z][a-z]?)(?:\d*[+-])?$/)?.[1];
    if (!element || !ELEMENTS.has(element)) throw new CrystalError("missingSpecies");
    const coordinates: readonly [CifToken, CifToken, CifToken] = [get(coordTags[0]), get(coordTags[1]), get(coordTags[2])];
    const position = vector(coordinates.map((t) => t.value));
    const occupancyToken = get("_atom_site_occupancy");
    const occupancy = occupancyToken && !/^[.?]$/.test(occupancyToken.value) ? numeric(occupancyToken.value) : null;
    if (occupancy !== null && (occupancy < 0 || occupancy > 1)) throw new CrystalError("invalidCif");
    if (occupancy !== null && occupancy !== 1) warnings.add("partialOccupancy");
    if (occupancy === null) warnings.add(occupancyToken ? "unknownOccupancy" : "unspecifiedOccupancy");
    atoms.push({ element, label: label ?? symbol ?? element,
      fractional: fractional ? position : cartesianToFractional(position, lattice), occupancy, selective: null });
    sites.push({ element, coordinates });
  }
  const symmetryValues: string[] = [];
  for (const tag of SYMMETRY_OPS) {
    const scalar = scalars.get(tag);
    if (scalar) symmetryValues.push(scalar.value);
    for (const loop of loops) {
      const column = loop.tags.indexOf(tag);
      if (column >= 0) symmetryValues.push(...loop.rows.map((row) => row[column].value));
    }
  }
  const groupNumbers = GROUP_NUMBERS.flatMap((tag) => { const value = scalars.get(tag); return value ? [value.value] : []; });
  const groupNames = GROUP_NAMES.flatMap((tag) => { const value = scalars.get(tag); return value ? [value.value] : []; });
  const identity = (value: string) => value.replace(/\s/g, "").toLowerCase() === "x,y,z";
  const knownP1 = groupNumbers.some((v) => v === "1") || groupNames.some((v) => v.replace(/\s/g, "").toUpperCase() === "P1") || symmetryValues.length > 0;
  if (!knownP1 || groupNumbers.some((v) => v !== "1") || groupNames.some((v) => v.replace(/\s/g, "").toUpperCase() !== "P1") || symmetryValues.some((v) => !identity(v))) warnings.add("unknownSymmetry");
  const allowed = new Set([...CELL_TAGS, ...SITE_TAGS, ...GROUP_NUMBERS, ...GROUP_NAMES, ...SYMMETRY_OPS, "_space_group_symop_id", "_symmetry_equiv_pos_site_id"]);
  for (const tag of seen) {
    if (!allowed.has(tag) && !/^_(?:audit_|publ_|chemical_name_|chemical_formula_|database_)/.test(tag)) warnings.add("unsupportedCif");
  }
  if (tokens.some((t) => NUMBER.test(t.value) && /\(\d+\)/.test(t.value))) warnings.add("uncertainty");
  return { format: "cif", sourceText: text, source: { kind: "cif", cell, sites }, lattice, atoms,
    coordinateMode: fractional ? "direct" : "cartesian", warnings: [...warnings],
    editable: [...warnings].every((w) => w === "unspecifiedOccupancy") };
}

const formatNumber = (value: number) => Number(value.toPrecision(13)).toString();

/** Serialize only source atoms. CIF edits patch numeric tokens and retain all other source text. */
export function serializeCrystal(document: CrystalDocument): string {
  if (!document.editable) throw new CrystalError("readOnly");
  validateLattice(document.lattice);
  const { source, atoms } = document;
  const elements = source.kind === "poscar" ? source.elements : source.sites.map((s) => s.element);
  if (atoms.length !== elements.length || atoms.some((a, i) => a.element !== elements[i] ||
      [...a.fractional, ...fractionalToCartesian(a.fractional, document.lattice)].some((n) => !Number.isFinite(n) || Math.abs(n) > 1e9))) throw new CrystalError("invalidEdit");
  if (source.kind === "poscar") {
    const lines = [...source.lines];
    lines[1] = "1";
    document.lattice.forEach((v, i) => { lines[i + 2] = v.map(formatNumber).join(" "); });
    atoms.forEach((atom, i) => {
      const position = document.coordinateMode === "direct" ? atom.fractional : fractionalToCartesian(atom.fractional, document.lattice);
      const flags = atom.selective ? ` ${atom.selective.map((f) => f ? "T" : "F").join(" ")}` : "";
      lines[source.atomStart + i] = position.map(formatNumber).join(" ") + flags + source.suffixes[i];
    });
    return lines.join(source.eol);
  }
  const parameters = cellFromLattice(document.lattice);
  const conventional = latticeFromCell(parameters);
  if (document.lattice.some((v, i) => v.some((n, j) => Math.abs(n - conventional[i][j]) > 1e-7 * Math.max(1, Math.abs(n))))) throw new CrystalError("invalidEdit");
  const patches: { span: Span; value: string }[] = source.cell.map((span, i) => ({ span, value: formatNumber(parameters[i]) }));
  atoms.forEach((atom, i) => {
    const position = document.coordinateMode === "direct" ? atom.fractional : fractionalToCartesian(atom.fractional, document.lattice);
    source.sites[i].coordinates.forEach((span, j) => patches.push({ span, value: formatNumber(position[j]) }));
  });
  const parts: string[] = [];
  let cursor = 0;
  for (const { span, value } of patches.sort((a, b) => a.span.start - b.span.start)) {
    parts.push(document.sourceText.slice(cursor, span.start), value);
    cursor = span.end;
  }
  parts.push(document.sourceText.slice(cursor));
  return parts.join("");
}

export interface DisplayCrystalAtom {
  readonly sourceIndex: number;
  readonly image: Vector3;
  readonly element: string;
  readonly cartesian: Vector3;
}

/** 1x1x1 or 2x2x2 display; never feed these images back to the serializer. */
export function crystalDisplayAtoms(document: CrystalDocument, repetitions: 1 | 2): DisplayCrystalAtom[] {
  if (document.atoms.length * repetitions ** 3 > CRYSTAL_LIMITS.displayAtoms) throw new CrystalError("displayLimit");
  const display: DisplayCrystalAtom[] = [];
  for (let x = 0; x < repetitions; x++) for (let y = 0; y < repetitions; y++) for (let z = 0; z < repetitions; z++) {
    document.atoms.forEach((atom, sourceIndex) => {
      const f = atom.fractional;
      display.push({ sourceIndex, image: [x, y, z], element: atom.element,
        cartesian: fractionalToCartesian([f[0] + x, f[1] + y, f[2] + z], document.lattice) });
    });
  }
  return display;
}
