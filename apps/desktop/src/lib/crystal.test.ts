import { describe, expect, it } from "vitest";
import de from "../i18n/locales/de/inspector.json";
import en from "../i18n/locales/en/inspector.json";
import es from "../i18n/locales/es/inspector.json";
import fr from "../i18n/locales/fr/inspector.json";
import ja from "../i18n/locales/ja/inspector.json";
import ko from "../i18n/locales/ko/inspector.json";
import zh from "../i18n/locales/zh-Hans/inspector.json";
import {
  CRYSTAL_LIMITS, CrystalError, cartesianToFractional, cellFromLattice, crystalDisplayAtoms,
  crystalNumber, crystalVolume, fractionalToCartesian, isCrystalFile, latticeFromCell,
  parseCrystal, serializeCrystal, type CrystalDocument, type CrystalIssue, type Vector3,
} from "./crystal";

const POSCAR = "Skew cell\n2\n2 0 0\n1 2 0\n0.5 0.3 3\nSi O\n1 1\nSelective dynamics\nDirect\n0.1 0.2 0.3 T F T # site\n0.5 0.5 0.5 F F F\n";
const CIF = `# source header
data_sample
_audit_creation_method 'A local experiment'
_cell_length_a 4
_cell_length_b 5
_cell_length_c 6
_cell_angle_alpha 80
_cell_angle_beta 75
_cell_angle_gamma 65
_space_group_IT_number 1
_space_group_name_H-M_alt 'P 1'
loop_
_space_group_symop_id
_space_group_symop_operation_xyz
1 'x,y,z'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
Si1 Si 0.1 0.2 0.3 1 # retain this comment
O1 O 0.4 0.5 0.6 1
`;

function expectVector(actual: Vector3, expected: Vector3) { actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 10)); }
function expectIssue(run: () => unknown, code: CrystalIssue) {
  expect(run).toThrowError(CrystalError);
  try { run(); } catch (error) { expect(error).toMatchObject({ code }); }
}
function moveFirst(document: CrystalDocument): CrystalDocument {
  return { ...document, atoms: document.atoms.map((a, i) => i === 0 ? { ...a, fractional: [0.7, -0.2, 1.3] } : a) };
}

describe("crystal coordinates and bounds", () => {
  it("provides identical crystal translation keys in all seven locales", () => {
    const paths = (value: Record<string, unknown>): string[] => Object.entries(value).flatMap(([key, child]) =>
      typeof child === "object" && child !== null ? paths(Object.fromEntries(Object.entries(child))).map((path) => `${key}.${path}`) : [key]).sort();
    for (const locale of [de, es, fr, ja, ko, zh]) expect(paths(locale.crystal)).toEqual(paths(en.crystal));
  });
  it("inverts a nonorthogonal, left-handed lattice without transposing vectors", () => {
    const lattice = [[2, 1, 0], [0, -3, 1], [1, 0, 4]] satisfies CrystalDocument["lattice"];
    expectVector(fractionalToCartesian([0.2, 0.3, 0.4], lattice), [0.8, -0.7, 1.9]);
    expectVector(cartesianToFractional([0.8, -0.7, 1.9], lattice), [0.2, 0.3, 0.4]);
  });
  it("roundtrips triclinic cell lengths and angles", () => {
    const cell = [4, 5, 6, 80, 75, 65] satisfies Parameters<typeof latticeFromCell>[0];
    cellFromLattice(latticeFromCell(cell)).forEach((value, i) => expect(value).toBeCloseTo(cell[i], 10));
  });
  it.each(["", " ", "NaN", "Infinity", "1e309", "0x12", "1 garbage"])("rejects invalid numeric input %j", (value) => {
    expectIssue(() => crystalNumber(value), "invalidNumber");
  });
  it("rejects missing, singular and impossible cells", () => {
    expectIssue(() => parseCrystal("x.cif", CIF.replace("_cell_angle_gamma 65\n", "")), "missingCell");
    expectIssue(() => latticeFromCell([1, 1, 1, 10, 10, 170]), "invalidLattice");
    expectIssue(() => parseCrystal("POSCAR", POSCAR.replace("0.5 0.3 3", "0 0 0")), "invalidLattice");
  });
  it("recognizes only bounded supported formats", () => {
    for (const name of ["POSCAR", "x/CONTCAR", "C:\\s\\POSCAR", "x.VASP", "sample.cif"]) expect(isCrystalFile(name)).toBe(true);
    expect(isCrystalFile("notes.POSCAR.txt")).toBe(false);
    expectIssue(() => parseCrystal("x.xyz", ""), "unsupportedFormat");
    expectIssue(() => parseCrystal("POSCAR", " ".repeat(CRYSTAL_LIMITS.textLength + 1)), "tooLarge");
    expectIssue(() => parseCrystal("POSCAR", POSCAR.replace("1 1\nSelective", "5001 0\nSelective")), "tooLarge");
  });
});

describe("POSCAR roundtrips", () => {
  it("keeps physical lattice, species order, flags and comments after coordinate edits", () => {
    const parsed = parseCrystal("POSCAR", POSCAR);
    expect(parsed.lattice[1]).toEqual([2, 4, 0]);
    expect(parsed.atoms[0].selective).toEqual([true, false, true]);
    const saved = serializeCrystal(moveFirst(parsed));
    expect(saved).toContain("T F T # site");
    expect(saved).toContain("Selective dynamics\nDirect");
    expect(saved.split("\n")[1]).toBe("1");
    const next = parseCrystal("CONTCAR", saved);
    expectVector(next.atoms[0].fractional, [0.7, -0.2, 1.3]);
    expect(next.atoms.map((a) => a.element)).toEqual(["Si", "O"]);
    next.lattice.forEach((v, i) => expectVector(v, parsed.lattice[i]));
  });
  it("applies the scale to Cartesian coordinates as well as lattice vectors", () => {
    const parsed = parseCrystal("x.vasp", POSCAR.replace("Direct", "Cartesian"));
    expectVector(fractionalToCartesian(parsed.atoms[0].fractional, parsed.lattice), [0.2, 0.4, 0.6]);
    const next = parseCrystal("x.vasp", serializeCrystal(parsed));
    expect(next.coordinateMode).toBe("cartesian");
    expectVector(next.atoms[0].fractional, parsed.atoms[0].fractional);
  });
  it.each(["Direct", "Cartesian"])("supports negative target volume with %s coordinates", (mode) => {
    const parsed = parseCrystal("POSCAR", POSCAR.replace("\n2\n", "\n-96\n").replace("Direct", mode));
    expect(crystalVolume(parsed.lattice)).toBeCloseTo(96, 10);
    const next = parseCrystal("POSCAR", serializeCrystal(parsed));
    expect(crystalVolume(next.lattice)).toBeCloseTo(96, 9);
    expectVector(next.atoms[0].fractional, parsed.atoms[0].fractional);
  });
  it("handles CRLF and a nonselective file", () => {
    const text = POSCAR.replace("Selective dynamics\n", "").replace(" T F T", "").replace(" F F F", "").replace(/\n/g, "\r\n");
    const saved = serializeCrystal(parseCrystal("POSCAR", text));
    expect(saved).toContain("\r\nDirect\r\n");
    expect(parseCrystal("POSCAR", saved).atoms[0].selective).toBeNull();
  });
  it("does not infer VASP 4 species and refuses unsupported scale forms", () => {
    expectIssue(() => parseCrystal("POSCAR", POSCAR.replace("Si O\n", "")), "missingSpecies");
    expectIssue(() => parseCrystal("POSCAR", POSCAR.replace("\n2\n", "\n1 2 3\n")), "invalidPoscar");
    expectIssue(() => parseCrystal("POSCAR", POSCAR.replace(" T F T", " T F")), "invalidPoscar");
  });
  it("protects trailing velocity or predictor-corrector sections", () => {
    const parsed = parseCrystal("CONTCAR", POSCAR + "\nCartesian\n1 2 3\n4 5 6\n");
    expect(parsed.warnings).toContain("poscarTail");
    expect(parsed.editable).toBe(false);
    expectIssue(() => serializeCrystal(parsed), "readOnly");
  });
});

describe("CIF roundtrips and semantic protection", () => {
  it("patches coordinates and cell values without losing metadata, quoting or comments", () => {
    const parsed = parseCrystal("sample.cif", CIF);
    expect(parsed.editable).toBe(true);
    const changed = { ...moveFirst(parsed), lattice: latticeFromCell([7, 5, 6, 80, 75, 65]) };
    const saved = serializeCrystal(changed);
    expect(saved).toContain("_audit_creation_method 'A local experiment'");
    expect(saved).toContain("1 'x,y,z'");
    expect(saved).toContain("Si1 Si 0.7 -0.2 1.3 1 # retain this comment");
    expect(saved).toContain("_cell_length_a 7\n");
    const next = parseCrystal("sample.cif", saved);
    expectVector(next.atoms[0].fractional, [0.7, -0.2, 1.3]);
    expect(next.atoms.map((a) => a.occupancy)).toEqual([1, 1]);
  });
  it("retains semicolon text fields with CIF control words inside them", () => {
    const text = CIF.replace("_audit_creation_method 'A local experiment'", "_audit_creation_method\n;An experiment\ndata_fake\nloop_\n;\n");
    const saved = serializeCrystal(moveFirst(parseCrystal("s.cif", text)));
    expect(saved).toContain(";An experiment\ndata_fake\nloop_\n;");
  });
  it("accepts Cartesian sites and writes physical coordinates", () => {
    const text = CIF.replace(/_atom_site_fract_/g, "_atom_site_Cartn_");
    const doc = parseCrystal("s.cif", text);
    expectVector(fractionalToCartesian(doc.atoms[0].fractional, doc.lattice), [0.1, 0.2, 0.3]);
    const saved = serializeCrystal(moveFirst(doc));
    const next = parseCrystal("s.cif", saved);
    expectVector(next.atoms[0].fractional, [0.7, -0.2, 1.3]);
  });
  it("preserves omitted occupancy rather than inserting a default", () => {
    const text = CIF.replace("_atom_site_occupancy\n", "").replace("0.3 1 #", "0.3 #").replace("0.6 1\n", "0.6\n");
    const doc = parseCrystal("s.cif", text);
    expect(doc.editable).toBe(true);
    expect(doc.atoms[0].occupancy).toBeNull();
    expect(doc.warnings).toContain("unspecifiedOccupancy");
    expect(serializeCrystal(moveFirst(doc))).not.toContain("_atom_site_occupancy");
  });
  it.each([
    [CIF + "\ndata_second\n_cell_length_a 3\n", "multipleBlocks"],
    [CIF.replace("0.3 1 #", "0.3 0.5 #"), "partialOccupancy"],
    [CIF.replace("0.3 1 #", "0.3 ? #"), "unknownOccupancy"],
    [CIF.replace("0.3 1 #", "0.3 . #"), "unknownOccupancy"],
    [CIF.replace("'P 1'", "'P -1'"), "unknownSymmetry"],
    [CIF.replace("'x,y,z'", "'-x,-y,-z'"), "unknownSymmetry"],
    [CIF.replace("_cell_length_a 4", "_cell_length_a 4.0(2)"), "uncertainty"],
    [CIF + "_atom_site_aniso_U_11 0.2\n", "unsupportedCif"],
    [CIF + "_unknown_future_semantics 1\n", "unsupportedCif"],
  ] satisfies [string, CrystalIssue][])("locks unsafe semantics %s", (text, issue) => {
    const parsed = parseCrystal("s.cif", text);
    expect(parsed.warnings).toContain(issue);
    expect(parsed.editable).toBe(false);
    expect(parsed.sourceText).toBe(text);
    expectIssue(() => serializeCrystal(parsed), "readOnly");
  });
  it("requires an explicit P1 declaration", () => {
    const text = CIF.replace("_space_group_IT_number 1\n", "").replace("_space_group_name_H-M_alt 'P 1'\n", "").replace("loop_\n_space_group_symop_id\n_space_group_symop_operation_xyz\n1 'x,y,z'\n", "");
    expect(parseCrystal("s.cif", text).warnings).toContain("unknownSymmetry");
  });
  it("rejects malformed loops, duplicate tags and absent atom positions", () => {
    expectIssue(() => parseCrystal("s.cif", CIF.replace("O1 O 0.4 0.5 0.6 1", "O1 O 0.4")), "invalidCif");
    expectIssue(() => parseCrystal("s.cif", CIF + "_cell_length_a 4\n"), "invalidCif");
    expectIssue(() => parseCrystal("s.cif", CIF.replace("_atom_site_fract_z", "_atom_site_other")), "missingAtoms");
    expectIssue(() => parseCrystal("s.cif", CIF.replace("0.3 1 #", "? 1 #")), "invalidNumber");
  });
  it("does not guess an element from an ambiguous uppercase-only atom label", () => {
    const text = CIF.replace("_atom_site_type_symbol\n", "").replace("Si1 Si", "CL1").replace("O1 O", "O1");
    expectIssue(() => parseCrystal("s.cif", text), "missingSpecies");
  });
});

describe("display copies", () => {
  it("maps all images to source sites and never expands serialized atom counts", () => {
    const doc = parseCrystal("POSCAR", POSCAR);
    const images = crystalDisplayAtoms(doc, 2);
    expect(images).toHaveLength(16);
    expect(images.filter((a) => a.sourceIndex === 0)).toHaveLength(8);
    expect(images[14].image).toEqual([1, 1, 1]);
    expectVector(images[14].cartesian, fractionalToCartesian([1.1, 1.2, 1.3], doc.lattice));
    expect(parseCrystal("POSCAR", serializeCrystal(doc)).atoms).toHaveLength(2);
  });
  it("refuses a display expansion beyond its cap instead of truncating", () => {
    const doc = parseCrystal("POSCAR", POSCAR);
    expectIssue(() => crystalDisplayAtoms({ ...doc, atoms: Array.from({ length: 1501 }, () => doc.atoms[0]) }, 2), "displayLimit");
  });
});
