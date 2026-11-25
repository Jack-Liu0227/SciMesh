import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCrystal } from "@/lib/crystal";
import { CrystalView } from "./CrystalView";

const scene = vi.hoisted(() => {
  const addAtoms = vi.fn();
  const viewer = { addModel: vi.fn(() => ({ addAtoms })), setStyle: vi.fn(), setClickable: vi.fn(),
    addLine: vi.fn(), zoomTo: vi.fn(), render: vi.fn(), resize: vi.fn(), clear: vi.fn() };
  return { viewer, addAtoms, createViewer: vi.fn(() => viewer) };
});
vi.mock("3dmol", () => ({ createViewer: scene.createViewer }));

const POSCAR = "Silicon\n1\n4 0 0\n1 4 0\n0 0 4\nSi\n2\nSelective dynamics\nDirect\n0 0 0 T F T\n0.5 0.5 0.5 F F F\n";
const CIF = "data_test\n_cell_length_a 4\n_cell_length_b 4\n_cell_length_c 4\n_cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 90\n_space_group_IT_number 1\nloop_\n_atom_site_type_symbol\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\n_atom_site_occupancy\nSi 0 0 0 0.5\n";

async function editX(value: string) {
  const field = screen.getByLabelText("Coordinate x");
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("CrystalView", () => {
  it("is read-only without a host writer while keeping the atom table available", async () => {
    render(<CrystalView filename="POSCAR" text={POSCAR} />);
    expect(screen.getByLabelText("Coordinate x")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Source atom table" })).toBeInTheDocument();
    expect(screen.getByText(/host has not enabled editing/)).toBeInTheDocument();
    await waitFor(() => expect(scene.addAtoms).toHaveBeenCalled());
    expect(scene.viewer.addLine).toHaveBeenCalledTimes(12);
  });
  it("edits a source coordinate and explicitly saves exactly the source atom count", async () => {
    const onSave = vi.fn(async (_text: string) => {});
    render(<CrystalView filename="POSCAR" text={POSCAR} onSave={onSave} />);
    await editX("0.25");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const doc = parseCrystal("POSCAR", onSave.mock.calls[0][0]);
    expect(doc.atoms).toHaveLength(2);
    expect(doc.atoms[0].fractional[0]).toBe(0.25);
    expect(doc.atoms[0].selective).toEqual([true, false, true]);
    expect(await screen.findByText("No unsaved changes")).toBeInTheDocument();
  });
  it("edits POSCAR lattice vectors while keeping fractional source positions fixed", async () => {
    const onSave = vi.fn(async (_text: string) => {});
    render(<CrystalView filename="POSCAR" text={POSCAR} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Vector 1 · x (Å)"), { target: { value: "8" } });
    fireEvent.blur(screen.getByLabelText("Vector 1 · x (Å)"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const doc = parseCrystal("POSCAR", onSave.mock.calls[0][0]);
    expect(doc.lattice[0]).toEqual([8, 0, 0]);
    expect(doc.atoms[1].fractional).toEqual([0.5, 0.5, 0.5]);
  });
  it("edits a simple CIF cell and preserves the supported source site loop", async () => {
    const onSave = vi.fn(async (_text: string) => {});
    render(<CrystalView filename="cell.cif" text={CIF.replace("0 0 0 0.5", "0 0 0 1")} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("a (Å)"), { target: { value: "7" } });
    fireEvent.blur(screen.getByLabelText("a (Å)"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const doc = parseCrystal("cell.cif", onSave.mock.calls[0][0]);
    expect(doc.lattice[0]).toEqual([7, 0, 0]);
    expect(doc.atoms).toHaveLength(1);
    expect(doc.atoms[0].occupancy).toBe(1);
  });
  it("converts Cartesian input using the actual nonorthogonal lattice", async () => {
    const onSave = vi.fn(async (_text: string) => {});
    render(<CrystalView filename="POSCAR" text={POSCAR} onSave={onSave} />);
    await userEvent.selectOptions(screen.getByLabelText("Coordinate input"), "cartesian");
    await editX("2");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const doc = parseCrystal("POSCAR", onSave.mock.calls[0][0]);
    expect(doc.atoms[0].fractional).toEqual([0.5, 0, 0]);
    expect(doc.coordinateMode).toBe("direct");
  });
  it("undoes a coordinate change and resets edits to the current source", async () => {
    render(<CrystalView filename="POSCAR" text={POSCAR} onSave={async () => {}} />);
    await editX("0.25");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("0");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await editX("0.4");
    await userEvent.click(screen.getByRole("button", { name: "Reset / reload source" }));
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("0");
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
  });
  it("keeps dirty edits after a failed host save and reports the error", async () => {
    const onSave = vi.fn(async () => { throw new Error("Permission denied"); });
    render(<CrystalView filename="POSCAR" text={POSCAR} onSave={onSave} />);
    await editX("0.25");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("0.25");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });
  it("blocks overwriting an incoming conflict, retains edits, then reloads on reset", async () => {
    const onSave = vi.fn(async () => {});
    const { rerender } = render(<CrystalView filename="POSCAR" text={POSCAR} onSave={onSave} />);
    await editX("0.25");
    const changed = POSCAR.replace("0 0 0 T", "0.75 0 0 T");
    rerender(<CrystalView filename="POSCAR" text={changed} onSave={onSave} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("source changed");
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("0.25");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Reset / reload source" }));
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("0.75");
    expect(onSave).not.toHaveBeenCalled();
  });
  it("also detects conflicts before a focused input has been committed", async () => {
    const { rerender } = render(<CrystalView filename="POSCAR" text={POSCAR} onSave={async () => {}} />);
    fireEvent.change(screen.getByLabelText("Coordinate x"), { target: { value: "0.2" } });
    rerender(<CrystalView filename="POSCAR" text={POSCAR.replace("Silicon", "External edit")} onSave={async () => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("source changed");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
  it("disables editing while the host is saving", () => {
    render(<CrystalView filename="POSCAR" text={POSCAR} onSave={async () => {}} saving />);
    expect(screen.getByLabelText("Coordinate x")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
  });
  it("blocks duplicate writes while an asynchronous save is pending", async () => {
    let finish: () => void = () => {};
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<CrystalView filename="POSCAR" text={POSCAR} onSave={onSave} />);
    await editX("0.25");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(screen.getByLabelText("Coordinate x")).toBeDisabled();
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(await screen.findByText("No unsaved changes")).toBeInTheDocument();
  });
  it("keeps a conflict when a different source arrives during an asynchronous save", async () => {
    let finish: () => void = () => {};
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { rerender } = render(<CrystalView filename="POSCAR" text={POSCAR} onSave={onSave} />);
    await editX("0.25");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    rerender(<CrystalView filename="POSCAR" text={POSCAR.replace("Silicon", "Concurrent change")} onSave={onSave} />);
    await act(async () => { finish(); });
    expect(screen.getByRole("alert")).toHaveTextContent("source changed");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("0.25");
  });
  it("paginates source sites without silently dropping atoms", async () => {
    const many = "Sites\n1\n4 0 0\n0 4 0\n0 0 4\nSi\n101\nDirect\n" + Array.from({ length: 101 }, () => "0 0 0").join("\n");
    render(<CrystalView filename="POSCAR" text={many} />);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(101);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("Source atom 101 · Si")).toBeInTheDocument();
  });
  it("keeps CIFs with partial occupancy read-only even with a writer", async () => {
    const onSave = vi.fn(async () => {});
    render(<CrystalView filename="sample.cif" text={CIF} onSave={onSave} />);
    expect(screen.getByText(/partial or zero occupancy/)).toBeInTheDocument();
    expect(screen.getByLabelText("Coordinate x")).toBeDisabled();
    expect(screen.getByLabelText("a (Å)")).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(scene.addAtoms).toHaveBeenCalled());
  });
  it("maps a clicked periodic image back to its source atom", async () => {
    render(<CrystalView filename="POSCAR" text={POSCAR} onSave={async () => {}} />);
    await waitFor(() => expect(scene.addAtoms).toHaveBeenCalled());
    await userEvent.selectOptions(screen.getByLabelText("Display cells"), "2");
    await waitFor(() => expect(scene.addAtoms.mock.calls.slice(-1)[0]?.[0]).toHaveLength(16));
    const atoms: unknown = scene.addAtoms.mock.calls.slice(-1)[0]?.[0];
    expect(atoms).toEqual(expect.arrayContaining([expect.objectContaining({ properties: { sourceIndex: 1 } })]));
    const callback: (atom: { properties: { sourceIndex: number } }) => void = scene.viewer.setClickable.mock.calls.slice(-1)[0]?.[2];
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    // 3Dmol's callback is the GPU boundary. The editor itself is exercised directly.
    act(() => callback({ properties: { sourceIndex: 1 } }));
    expect(screen.getByText("Source atom 2 · Si")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByRole("button", { name: "2" })).toHaveAttribute("aria-pressed", "true");
  });
  it("keeps table editing available without WebGL", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    render(<CrystalView filename="POSCAR" text={POSCAR} onSave={async () => {}} />);
    expect(await screen.findByText(/3D preview needs WebGL/)).toBeInTheDocument();
    expect(screen.getByLabelText("Coordinate x")).toBeEnabled();
    expect(scene.createViewer).not.toHaveBeenCalled();
  });
  it("rejects blank numeric input without changing the source model", async () => {
    render(<CrystalView filename="POSCAR" text={POSCAR} onSave={async () => {}} />);
    await editX("");
    expect(screen.getByRole("alert")).toHaveTextContent("finite numeric");
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("0");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
  it("reports malformed input without invoking the renderer", () => {
    render(<CrystalView filename="POSCAR" text="not a crystal" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid or unsupported POSCAR");
    expect(scene.createViewer).not.toHaveBeenCalled();
  });
});
