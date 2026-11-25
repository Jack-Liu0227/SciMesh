import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePreviewInspector as FilePreviewInspectorT } from "@ai4s/shared";
import { previewUrl, readArtifact } from "@/lib/artifactFile";
import { CRYSTAL_LIMITS, parseCrystal } from "@/lib/crystal";
import { useRuntimeStore } from "@/lib/runtime";
import { FilePreviewInspector, PreviewError } from "./FilePreviewInspector";

// The markdown tests below carry inline `content`, so they never hit
// readArtifact — this mock only feeds the binary-file test.
const probeLargeFile = vi.fn();
vi.mock("@/lib/artifactFile", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/artifactFile")>();
  return {
    ...mod,
    readArtifact: vi.fn(async () => ({
      path: "data/blob.bin",
      mime: "application/octet-stream",
      encoding: "base64",
      data: "AAEC",
      size: 3,
    })),
    probeLargeFile: (...args: unknown[]) => probeLargeFile(...args),
    previewUrl: vi.fn(async () => "http://127.0.0.1:1/page.html"),
    writeWorkspaceFile: (...args: Parameters<typeof writeWorkspaceFile>) =>
      writeWorkspaceFile(...args),
  };
});

// Monaco needs a real layout engine; jsdom has none. These tests are about the
// INSPECTOR — dirty state, autosave, discard — so the editor is a textarea with
// the same contract. See `test/monacoStub`.
vi.mock("@/components/code-editor/monacoSetup", () => import("@/test/monacoStub"));

// Editing is desktop-only, so the editing tests need the app to believe it is
// running under Tauri.
const writeWorkspaceFile = vi.fn(async (_path: string, _content: string, _root?: unknown) => {});
const recordProvenance = vi.fn(
  async (_input: { path: string; tool: string; content?: string }, ..._rest: unknown[]) => {},
);
const structureTransport = vi.hoisted(() => ({ tauri: true, web: false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: structureTransport.invoke }));
vi.mock("@/lib/webMode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webMode")>()),
  get isGatewayWeb() { return structureTransport.web; },
  gatewayOrigin: () => "http://gateway.test",
  gatewayToken: () => "structure-test-token",
}));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  get isTauri() { return structureTransport.tauri; },
}));
vi.mock("@/lib/provenance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provenance")>()),
  recordProvenance: (...args: Parameters<typeof recordProvenance>) => recordProvenance(...args),
}));

afterEach(() => {
  cleanup();
  structureTransport.tauri = true;
  structureTransport.web = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const md: FilePreviewInspectorT = {
  variant: "file",
  path: "notes/report.md",
  filename: "report.md",
  artifact: "report",
  content: "# Findings\n\nDose–response holds. `p < 0.01`.",
};

describe("FilePreviewInspector — markdown", () => {
  it("uses the same compact 32px header as a tiled Session pane", () => {
    const { container } = render(
      <FilePreviewInspector data={md} onClose={() => {}} compactHeader />,
    );
    expect(container.querySelector("header")).toHaveClass("h-8", "border-faint");
  });

  it("right-clicking the path offers to show the file in its folder", async () => {
    render(<FilePreviewInspector data={md} onClose={() => {}} />);
    fireEvent.contextMenu(screen.getByText("notes/report.md"));
    expect(await screen.findByRole("menuitem", { name: "Show in folder" })).toBeInTheDocument();
  });

  it("renders markdown as a formatted document by default", async () => {
    render(<FilePreviewInspector data={md} onClose={() => {}} />);
    // The heading is real document markup, not raw "# Findings" text.
    expect(await screen.findByRole("heading", { name: "Findings" })).toBeInTheDocument();
    expect(screen.queryByText("# Findings")).not.toBeInTheDocument();
  });

  it("toggles to the raw source under the Code tab", async () => {
    render(<FilePreviewInspector data={md} onClose={() => {}} />);
    await screen.findByRole("heading", { name: "Findings" });
    await userEvent.click(screen.getByRole("button", { name: /Code/ }));
    expect(screen.getByText(/# Findings/)).toBeInTheDocument();
  });

  it("shows the newly opened file, not the previous one (no stale bleed)", async () => {
    // The same inspector instance is reused across files; opening a second
    // file with its own inline content must replace the first, not keep it.
    const a: FilePreviewInspectorT = { ...md, path: "a.md", filename: "a.md", content: "# Alpha" };
    const b: FilePreviewInspectorT = { ...md, path: "b.md", filename: "b.md", content: "# Beta" };
    const { rerender } = render(<FilePreviewInspector data={a} onClose={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();

    rerender(<FilePreviewInspector data={b} onClose={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Beta" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Alpha" })).not.toBeInTheDocument();
  });
});

describe("FilePreviewInspector — binary file behind a text preview", () => {
  it("says the file is binary instead of the misleading 'desktop app' note", async () => {
    // A text-kind preview whose read comes back base64 (genuinely binary
    // bytes) must say so — not claim the preview needs the desktop app.
    const bin: FilePreviewInspectorT = {
      variant: "file",
      path: "data/blob.bin",
      filename: "blob.bin",
      artifact: "data",
    };
    render(<FilePreviewInspector data={bin} onClose={() => {}} />);
    expect(await screen.findByText(/binary and has no preview/)).toBeInTheDocument();
    expect(screen.queryByText(/available in the desktop app/)).not.toBeInTheDocument();
  });
});

describe("FilePreviewInspector — markdown via readArtifact (Files browser path)", () => {
  it("renders a .md file that has no inline content by reading it from disk", async () => {
    const read = vi.mocked(readArtifact);
    read.mockResolvedValueOnce({
      path: "notes/report.md",
      mime: "text/markdown",
      encoding: "utf8",
      data: "# Disk-loaded\n\nRendered from readArtifact.",
      size: 40,
    });
    render(
      <FilePreviewInspector
        data={{ variant: "file", path: "notes/report.md", filename: "report.md", artifact: "report" }}
        onClose={() => {}}
      />,
    );
    // The heading is real document markup fetched through readArtifact — the
    // path the Files browser (no inline content) actually exercises.
    expect(await screen.findByRole("heading", { name: "Disk-loaded" })).toBeInTheDocument();
    expect(read).toHaveBeenCalledWith("notes/report.md", undefined);
  });

  it("falls back to the desktop-app note when the file cannot be read (browser dev)", async () => {
    const read = vi.mocked(readArtifact);
    read.mockResolvedValueOnce(null);
    render(
      <FilePreviewInspector
        data={{ variant: "file", path: "notes/report.md", filename: "report.md", artifact: "report" }}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText(/desktop app/)).toBeInTheDocument();
  });
});

describe("FilePreviewInspector — session workspace scope", () => {
  const deck: FilePreviewInspectorT = {
    variant: "file",
    path: "GPT-5.6-Luna-self-introduction-premium.pptx",
    filename: "GPT-5.6-Luna-self-introduction-premium.pptx",
    artifact: "report",
  };

  it("waits for the owning session workspace and never reloads from another pane's root", async () => {
    const read = vi.mocked(readArtifact);
    read.mockClear();
    act(() => {
      useRuntimeStore.setState({ workspace: "/workspaces/other-session" });
    });

    render(
      <FilePreviewInspector
        data={deck}
        workspaceDirectory="/workspaces/luna-session"
      />,
    );
    expect(read).not.toHaveBeenCalled();

    act(() => {
      useRuntimeStore.setState({ workspace: "/workspaces/luna-session" });
    });
    await waitFor(() => {
      expect(read).toHaveBeenCalledWith(deck.path, undefined);
    });
    expect(read).toHaveBeenCalledTimes(1);

    // Focusing a different split pane changes the global active workspace.
    // The already-bound Luna preview must neither 404 nor read a same-named
    // file from that other directory.
    act(() => {
      useRuntimeStore.setState({ workspace: "/workspaces/third-session" });
    });
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("treats a \\?\\-prefixed workspace path as the same folder (Windows canonicalize)", async () => {
    // Tauri's canonicalize() returns \\?\C:\… on Windows; the persisted
    // workspace file and a session's directory come from different sources, so
    // without normalization the wait guard compares raw strings that never
    // match and the preview spins on "loading" forever (the REPORT.md bug).
    const read = vi.mocked(readArtifact);
    read.mockClear();
    act(() => {
      useRuntimeStore.setState({ workspace: "\\\\?\\C:\\Users\\root\\Documents\\OpenScience\\2026-08-01-1420" });
    });
    render(
      <FilePreviewInspector
        data={deck}
        workspaceDirectory="C:/Users/root/Documents/OpenScience/2026-08-01-1420"
      />,
    );
    // Same folder (modulo prefix / slashes): the preview must load immediately,
    // not park in the "waiting for workspace" state.
    await waitFor(() => {
      expect(read).toHaveBeenCalledWith(deck.path, undefined);
    });
    expect(screen.queryByText(/waiting for the workspace/i)).not.toBeInTheDocument();
  });

  it("shows a waiting note instead of spinning forever while parked on another workspace", async () => {
    const read = vi.mocked(readArtifact);
    read.mockClear();
    act(() => {
      useRuntimeStore.setState({ workspace: "/workspaces/other-session" });
    });
    render(
      <FilePreviewInspector
        data={deck}
        workspaceDirectory="/workspaces/luna-session"
      />,
    );
    // Parked: no read, and the pane settles into an explicit wait note — the
    // "loading…" spinner must not stay up indefinitely.
    await waitFor(() => {
      expect(screen.getByText(/waiting for the workspace/i)).toBeInTheDocument();
    });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("PreviewError", () => {
  it("shows a helpful card with Open-externally for a too-large file", async () => {
    const onOpen = vi.fn();
    render(
      <PreviewError
        error="file too large to preview (>25 MB)"
        filename="huge.nc"
        path="data/huge.nc"
        onOpenExternally={onOpen}
      />,
    );
    expect(screen.getByText(/huge\.nc is too large to preview/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Open externally/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("inspects a too-large file without loading it and renders the pointer", async () => {
    probeLargeFile.mockResolvedValueOnce({
      format: "fastq",
      size: "90.0 GB",
      approx_reads: 450_000_000,
      read_length: { min: 150, max: 150, mean: 150 },
      gzipped: true,
      note: "Memory pointer — file introspected/sampled, not loaded.",
    });
    render(
      <PreviewError
        error="file too large to preview (>25 MB)"
        filename="reads.fastq.gz"
        path="data/reads.fastq.gz"
        onOpenExternally={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Inspect without loading/i }));
    // The pointer's key facts render — the format value, the read count, and
    // that it was sampled, not loaded.
    expect(await screen.findByText("fastq")).toBeInTheDocument(); // the Format cell, exact
    expect(screen.getByText(/450,000,000/)).toBeInTheDocument();
    expect(screen.getByText(/not loaded/i)).toBeInTheDocument();
    expect(probeLargeFile).toHaveBeenCalledWith("data/reads.fastq.gz", undefined);
  });

  it("shows the probe's error if introspection fails", async () => {
    probeLargeFile.mockRejectedValueOnce(new Error("no Python found"));
    render(
      <PreviewError error="file too large to preview" filename="x.bam" path="x.bam" onOpenExternally={() => {}} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Inspect without loading/i }));
    expect(await screen.findByText(/no Python found/)).toBeInTheDocument();
  });

  it("renders other errors as a plain line, no card", () => {
    render(<PreviewError error="Preview is available in the desktop app." filename="x.bin" onOpenExternally={() => {}} />);
    expect(screen.getByText(/available in the desktop app/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open externally/ })).not.toBeInTheDocument();
  });
});

describe("FilePreviewInspector — editing a file (#33)", () => {
  // These tests assert on what was NOT written, so each starts from no calls.
  beforeEach(() => vi.clearAllMocks());

  const py: FilePreviewInspectorT = {
    variant: "file",
    path: "analysis/fit.py",
    filename: "fit.py",
    artifact: "report",
    content: "import numpy as np\n",
  };

  /** Open the file and switch it into edit mode. The read-only view is
   *  highlighted markup, so its text is spread across spans — the Edit button
   *  appearing is the reliable signal that the file has loaded. */
  async function edit(data = py) {
    const view = render(<FilePreviewInspector data={data} onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit this file" }));
    // `findBy`, not `getBy`: the editor arrives with its own chunk, which is
    // loaded on demand rather than in the app's first bundle.
    return { view, editor: await screen.findByRole("textbox", { name: "Editing fit.py" }) };
  }

  it("shows the source read-only until the user asks to edit", async () => {
    const { container } = render(<FilePreviewInspector data={py} onClose={() => {}} />);
    await screen.findByRole("button", { name: "Edit this file" });
    expect(container.textContent).toContain("import numpy");
    // Nothing to type into: a file is read until it is opened for editing.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("does not offer Save until something actually changed", async () => {
    await edit();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("writes the edited text to disk and records it in the file's history", async () => {
    const { editor } = await edit();
    await userEvent.click(editor);
    await userEvent.keyboard("x = 1");

    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);

    await waitFor(() => expect(writeWorkspaceFile).toHaveBeenCalled());
    const [path, content] = writeWorkspaceFile.mock.calls[0]!;
    expect(path).toBe("analysis/fit.py");
    expect(content).toContain("x = 1");

    // The whole reason to edit in here rather than in an external editor: the
    // hand edit joins the same history an agent's write lands in.
    await waitFor(() => expect(recordProvenance).toHaveBeenCalled());
    const [input] = recordProvenance.mock.calls[0]!;
    expect(input.path).toBe("analysis/fit.py");
    expect(input.tool).toBe("manual-edit");
    expect(input.content).toContain("x = 1");
  });

  it("discards an edit without writing anything", async () => {
    const { view, editor } = await edit();
    await userEvent.click(editor);
    await userEvent.keyboard("oops");
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(writeWorkspaceFile).not.toHaveBeenCalled();
    // Back to the file as it is on disk, not to the abandoned draft.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(view.container.textContent).toContain("import numpy");
    expect(view.container.textContent).not.toContain("oops");
  });
});

describe("FilePreviewInspector — an editor pane", () => {
  beforeEach(() => vi.clearAllMocks());

  const py: FilePreviewInspectorT = {
    variant: "file",
    path: "analysis/fit.py",
    filename: "fit.py",
    artifact: "report",
    content: "import numpy as np\n",
  };

  it("opens editing, with no pencil to find first", async () => {
    render(<FilePreviewInspector data={py} onClose={() => {}} startEditing />);

    // Orca's editor tabs ARE editors; a preview with a hidden pencil is not
    // what "open the file" means.
    expect(await screen.findByRole("textbox", { name: "Editing fit.py" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit this file" })).not.toBeInTheDocument();
  });

  it("opens an HTML file on the page, not its source", async () => {
    const html: FilePreviewInspectorT = {
      variant: "file",
      path: "out/page.html",
      filename: "page.html",
      artifact: "report",
      content: "<h1>Hi</h1>",
    };
    render(<FilePreviewInspector data={html} onClose={() => {}} startEditing />);

    expect(await screen.findByTitle("HTML preview")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Editing page.html" })).not.toBeInTheDocument();
    // The source is one toggle away, already editable.
    await userEvent.click(screen.getByRole("button", { name: /Code/ }));
    expect(await screen.findByRole("textbox", { name: "Editing page.html" })).toBeInTheDocument();
  });

  it("opens a markdown note on its text, with Orca's formatting toolbar", async () => {
    render(<FilePreviewInspector data={md} onClose={() => {}} startEditing />);

    // An editor pane lands on the source, not on a rendered page with the
    // editor hidden behind a toggle.
    expect(await screen.findByRole("textbox", { name: "Editing report.md" })).toBeInTheDocument();
    const toolbar = screen.getByRole("toolbar", { name: "Formatting" });
    for (const button of ["Heading 1", "Bold", "Bulleted list", "Quote", "Link"]) {
      expect(within(toolbar).getByRole("button", { name: button })).toBeInTheDocument();
    }
  });

  it("renders the note when Preview is chosen, edits included, and goes back to editing on Code", async () => {
    render(<FilePreviewInspector data={md} onClose={() => {}} startEditing />);
    const editor = await screen.findByRole("textbox", { name: "Editing report.md" });
    await userEvent.type(editor, "{Control>}{End}{/Control} Added line.");

    await userEvent.click(screen.getByRole("button", { name: /Preview/ }));
    expect(screen.queryByRole("textbox", { name: "Editing report.md" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Findings" })).toBeInTheDocument();
    expect(screen.getByText(/Added line\./)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Code/ }));
    expect(
      (await screen.findByRole("textbox", { name: "Editing report.md" }) as HTMLTextAreaElement).value,
    ).toContain("Added line.");
  });

  it("does not label a note the user opened as a 'report'", async () => {
    render(<FilePreviewInspector data={md} onClose={() => {}} startEditing />);
    await screen.findByRole("textbox", { name: "Editing report.md" });

    // The artifact badge belongs next to something a conversation produced.
    expect(screen.queryByText("Report")).not.toBeInTheDocument();
  });

  it("formats the text through the toolbar", async () => {
    render(<FilePreviewInspector data={md} onClose={() => {}} startEditing />);
    const editor = await screen.findByRole("textbox", { name: "Editing report.md" });

    await userEvent.click(editor);
    // On the heading line: the marker applies to the line the caret is on, and
    // a click lands the caret at the end of the text.
    (editor as HTMLTextAreaElement).setSelectionRange(0, 0);
    await userEvent.click(screen.getByRole("button", { name: "Quote" }));

    // The heading BECOMES a quote rather than being quoted as a heading —
    // one marker per line, the way Orca's toolbar behaves.
    await waitFor(() =>
      expect((editor as HTMLTextAreaElement).value).toContain("> Findings"),
    );
  });

  it("reloads what another writer put on disk, once, and goes back to watching", async () => {
    const onDisk = { text: "v1\n" };
    vi.mocked(readArtifact).mockImplementation(async () => ({
      path: "analysis/run.py", mime: "text/x-python", encoding: "utf8", data: onDisk.text, size: onDisk.text.length,
    }));
    const file: FilePreviewInspectorT = { variant: "file", path: "analysis/run.py", filename: "run.py", artifact: "report" };
    render(<FilePreviewInspector data={file} onClose={() => {}} startEditing />);
    expect(await screen.findByRole("textbox", { name: "Editing run.py" })).toHaveValue("v1\n");

    // An agent rewrites it: the pane says so…
    onDisk.text = "v2\n";
    const reload = await screen.findByRole("button", { name: "Changed on disk — reload" }, { timeout: 3000 });
    await userEvent.click(reload);
    // …and the reload reads it — it used to spin on "Loading" for good.
    expect(await screen.findByRole("textbox", { name: "Editing run.py" })).toHaveValue("v2\n");
    expect(screen.queryByText(/Loading run.py/)).not.toBeInTheDocument();
    // Nothing changed since: no new warning.
    await new Promise((r) => setTimeout(r, 2500));
    expect(screen.queryByRole("button", { name: "Changed on disk — reload" })).not.toBeInTheDocument();
    vi.mocked(readArtifact).mockReset();
  }, 10_000);

  it("saves on its own, and says which state it is in", async () => {
    const editor = await (async () => {
      render(<FilePreviewInspector data={py} onClose={() => {}} startEditing />);
      return screen.findByRole("textbox", { name: "Editing fit.py" });
    })();

    await userEvent.click(editor);
    await userEvent.keyboard("x");

    // Autosave, as Orca does — no Save button to hunt for.
    await waitFor(() => expect(writeWorkspaceFile).toHaveBeenCalled(), { timeout: 3000 });
    // A light, not a word: "Saving…/Saved" sat against the buttons and read as
    // part of them. The state is the dot's label now.
    expect(await screen.findByRole("status", { name: "Saved" })).toBeInTheDocument();
  });
});

describe("FilePreviewInspector — the editor fills its pane", () => {
  const py: FilePreviewInspectorT = {
    variant: "file",
    path: "analysis/fit.py",
    filename: "fit.py",
    artifact: "report",
    content: "import numpy as np\n",
  };

  it("gives the editor a full-height box, not a padded one", async () => {
    render(<FilePreviewInspector data={py} onClose={() => {}} startEditing />);
    const editor = await screen.findByRole("textbox", { name: "Editing fit.py" });

    // Monaco lays itself out against a DEFINITE height. In the padded,
    // auto-height box the read-only view uses it collapsed to a ~30px strip
    // showing nothing but its own scrollbar.
    const box = editor.closest(".flex-1");
    expect(box?.className).toContain("min-h-0");
    expect(editor.closest(".p-3")).toBeNull();
  });

  it("lets the read-only view fill the pane, edge to edge", async () => {
    render(<FilePreviewInspector data={py} onClose={() => {}} />);

    // A file being READ is the pane's surface: full height, no padded card
    // floating over grey. (Highlighting splits the source across spans, so the
    // assertion is on the block, not on a text node.)
    await waitFor(() => {
      const surface = document.querySelector(".min-h-full");
      expect(surface?.textContent).toContain("import numpy");
      expect(document.querySelector(".p-3")).toBeNull();
    });
  });
});

describe("FilePreviewInspector — editing any file the app can read as text", () => {
  const csv: FilePreviewInspectorT = {
    variant: "file",
    path: "demo/dose_response_data.csv",
    filename: "dose_response_data.csv",
    artifact: "table",
    content: "dose_M,rep1\n0,5.09\n",
  };

  beforeEach(() => vi.clearAllMocks());

  it("the pencil opens the text, even for a file that renders as a table", async () => {
    render(<FilePreviewInspector data={csv} onClose={() => {}} />);
    await screen.findByText("dose_M");

    await userEvent.click(screen.getByRole("button", { name: "Edit this file" }));

    // The pencil used to do nothing visible here: the table view had no idea an
    // edit had begun and kept drawing the table. Editing means you see the
    // TEXT, whatever the file usually renders as.
    expect(
      await screen.findByRole("textbox", { name: "Editing dose_response_data.csv" }),
    ).toBeInTheDocument();
  });

  it("goes back to the table when the edit is put away", async () => {
    render(<FilePreviewInspector data={csv} onClose={() => {}} />);
    await screen.findByText("dose_M");
    await userEvent.click(screen.getByRole("button", { name: "Edit this file" }));
    await screen.findByRole("textbox", { name: "Editing dose_response_data.csv" });

    await userEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(await screen.findByText("dose_M")).toBeInTheDocument();
  });
});

describe("FilePreviewInspector crystal service integration", () => {
  const original = "Silicon\n1\n4 0 0\n1 4 0\n0 0 4\nSi\n2\nSelective dynamics\nDirect\n0 0 0 T F T\n0.5 0.5 0.5 F F F\n";
  const firstHash = "a".repeat(64);
  const nextHash = "b".repeat(64);
  const owner = "/workspaces/owning session";
  const file: FilePreviewInspectorT = { variant: "file", path: "crystals/POSCAR", filename: "POSCAR", artifact: "data" };
  const saveRequests = () => structureTransport.invoke.mock.calls
    .filter(([command]) => command === "structure_save").map(([, args]) => args.request);
  const readRequests = () => structureTransport.invoke.mock.calls
    .filter(([command]) => command === "structure_read").map(([, args]) => args.request);

  beforeEach(() => {
    vi.clearAllMocks();
    structureTransport.tauri = true;
    structureTransport.web = false;
    useRuntimeStore.setState({ workspace: "/workspaces/another session", webReadOnly: false });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.mocked(previewUrl).mockResolvedValue("http://gateway.test/download-ticket");
    structureTransport.invoke.mockReset();
    structureTransport.invoke.mockImplementation(async (command) => {
      if (command === "structure_read") return { content: original, hash: firstHash, path: file.path };
      if (command === "structure_save") return { hash: nextHash, version: 1 };
      return null;
    });
  });

  async function editCoordinate(value = "0.25") {
    const field = await screen.findByLabelText("Coordinate x");
    fireEvent.change(field, { target: { value } });
    fireEvent.blur(field);
  }
  async function clickSave() { await userEvent.click(screen.getByRole("button", { name: "Save" })); }

  it("reads the explicit owner, saves its normalized identity and hash, and uses the returned hash for the next edit", async () => {
    render(<FilePreviewInspector data={{ ...file, path: "crystals/./POSCAR", content: "stale inline content" }} workspaceDirectory={owner} startEditing />);
    await editCoordinate();
    expect(readRequests()).toEqual([{ path: "crystals/./POSCAR", root: "workspace", directory: owner }]);
    expect(screen.queryByText(/waiting for the workspace/i)).not.toBeInTheDocument();
    await clickSave();
    await screen.findByText("No unsaved changes");
    const first = saveRequests()[0];
    expect(first).toEqual({ path: file.path, root: "workspace", directory: owner,
      content: expect.any(String), expectedHash: firstHash, operationId: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect(parseCrystal(file.filename, first.content).atoms[0].fractional[0]).toBe(0.25);
    expect(parseCrystal(file.filename, first.content).atoms[0].selective).toEqual([true, false, true]);
    expect(writeWorkspaceFile).not.toHaveBeenCalled();
    expect(recordProvenance).not.toHaveBeenCalled();
    expect(readArtifact).not.toHaveBeenCalled();
    await editCoordinate("0.4");
    await clickSave();
    await screen.findByText("No unsaved changes");
    expect(saveRequests()[1].expectedHash).toBe(nextHash);
    expect(saveRequests()[1].operationId).not.toBe(first.operationId);
  });

  it.each(["io", "conflict", "recovery_required"])("retains the real editor draft after %s and reuses the exact operation on retry", async (code) => {
    let attempts = 0;
    structureTransport.invoke.mockImplementation(async (command) => {
      if (command === "structure_read") return { content: original, hash: firstHash, path: file.path };
      if (command === "structure_save" && attempts++ === 0) throw { code, message: `Server ${code}` };
      return { hash: nextHash, version: 1 };
    });
    render(<FilePreviewInspector data={file} workspaceDirectory={owner} />);
    await editCoordinate();
    await clickSave();
    expect(await screen.findByRole("alert")).toHaveTextContent(`Server ${code}`);
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("0.25");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(readRequests()).toHaveLength(1);
    await clickSave();
    await screen.findByText("No unsaved changes");
    expect(saveRequests()).toHaveLength(2);
    expect(saveRequests()[1]).toEqual(saveRequests()[0]);
  });

  it("allocates a new operation for a changed draft after failure without adopting a new expected hash", async () => {
    structureTransport.invoke.mockImplementation(async (command) => {
      if (command === "structure_read") return { content: original, hash: firstHash, path: file.path };
      throw { code: "conflict", message: "File changed externally" };
    });
    render(<FilePreviewInspector data={file} workspaceDirectory={owner} />);
    await editCoordinate(); await clickSave();
    await screen.findByRole("alert");
    await editCoordinate("0.35"); await clickSave();
    await screen.findByRole("alert");
    const [first, second] = saveRequests();
    expect(first.expectedHash).toBe(firstHash);
    expect(second.expectedHash).toBe(firstHash);
    expect(second.operationId).not.toBe(first.operationId);
    expect(second.content).toContain("0.35 0 0 T F T");
    expect(readRequests()).toHaveLength(1);
  });

  it("reloads the owner's new source and hash only when the user explicitly resolves a conflict", async () => {
    let reads = 0;
    let saves = 0;
    structureTransport.invoke.mockImplementation(async (command) => {
      if (command === "structure_read") return { content: reads++ === 0 ? original : original.replace("0 0 0 T", "0.75 0 0 T"),
        hash: reads === 1 ? firstHash : nextHash, path: file.path };
      if (command === "structure_save" && saves++ === 0) throw { code: "conflict", message: "File changed externally" };
      return { hash: "c".repeat(64), version: 2 };
    });
    render(<FilePreviewInspector data={file} workspaceDirectory={owner} />);
    await editCoordinate(); await clickSave();
    expect(await screen.findByRole("alert")).toHaveTextContent("File changed externally");
    expect(readRequests()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /Changed on disk/ }));
    expect(await screen.findByLabelText("Coordinate x")).toHaveValue("0.75");
    expect(readRequests()).toEqual([
      { path: file.path, root: "workspace", directory: owner },
      { path: file.path, root: "workspace", directory: owner },
    ]);
    await editCoordinate("0.8"); await clickSave(); await screen.findByText("No unsaved changes");
    expect(saveRequests()[1].expectedHash).toBe(nextHash);
    expect(saveRequests()[1].operationId).not.toBe(saveRequests()[0].operationId);
  });

  it("prevents reloading over a pending retry after conflict", async () => {
    let saves = 0;
    let finish: (value: unknown) => void = () => {};
    structureTransport.invoke.mockImplementation(async (command) => {
      if (command === "structure_read") return { content: original, hash: firstHash, path: file.path };
      if (saves++ === 0) throw { code: "conflict", message: "File changed externally" };
      return new Promise((resolve) => { finish = resolve; });
    });
    render(<FilePreviewInspector data={file} workspaceDirectory={owner} />);
    await editCoordinate(); await clickSave();
    await screen.findByRole("alert");
    await clickSave();
    const reload = screen.getByRole("button", { name: /Changed on disk/ });
    expect(reload).toBeDisabled();
    await userEvent.click(reload);
    expect(readRequests()).toHaveLength(1);
    await act(async () => { finish({ hash: nextHash, version: 1 }); });
    expect(await screen.findByText("No unsaved changes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Changed on disk/ })).not.toBeInTheDocument();
  });

  it("keeps the draft and owner when another session gains focus", async () => {
    render(<FilePreviewInspector data={file} workspaceDirectory={owner} />);
    await editCoordinate();
    act(() => useRuntimeStore.setState({ workspace: "/workspaces/new focus" }));
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("0.25");
    expect(screen.getByRole("button", { name: "Open externally" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "History" })).toBeDisabled();
    fireEvent.contextMenu(screen.getByText(file.path));
    expect(screen.queryByRole("menuitem", { name: "Show in folder" })).not.toBeInTheDocument();
    await clickSave(); await screen.findByText("No unsaved changes");
    expect(readRequests()).toHaveLength(1);
    expect(saveRequests()[0].directory).toBe(owner);
  });

  it.each(["root", "directory", "path"])("ignores a late save after changing the owning %s, including the old hash", async (change) => {
    let finish: (value: unknown) => void = () => {};
    let reads = 0;
    let saves = 0;
    const newSource = original.replace("0 0 0 T", "0.75 0 0 T");
    structureTransport.invoke.mockImplementation(async (command) => {
      if (command === "structure_read") return { content: reads++ === 0 ? original : newSource,
        hash: reads === 1 ? firstHash : nextHash, path: change === "path" && reads > 1 ? "other/POSCAR" : file.path };
      if (command === "structure_save" && saves++ === 0) return new Promise((resolve) => { finish = resolve; });
      return { hash: "c".repeat(64), version: 2 };
    });
    const { rerender } = render(<FilePreviewInspector data={file} workspaceDirectory={owner} />);
    await editCoordinate(); await clickSave();
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    const nextFile = change === "root" ? { ...file, root: "base" } satisfies FilePreviewInspectorT
      : change === "path" ? { ...file, path: "other/POSCAR" } : file;
    const directory = change === "directory" ? "/workspaces/second owner" : owner;
    rerender(<FilePreviewInspector data={nextFile} workspaceDirectory={directory} />);
    expect(await screen.findByLabelText("Coordinate x")).toHaveValue("0.75");
    await act(async () => { finish({ hash: "d".repeat(64), version: 1 }); });
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("0.75");
    await editCoordinate("0.6"); await clickSave(); await screen.findByText("No unsaved changes");
    expect(saveRequests()[1]).toMatchObject({ root: nextFile.root ?? "workspace", directory, path: nextFile.path, expectedHash: nextHash });
    expect(saveRequests()[1].operationId).not.toBe(saveRequests()[0].operationId);
  });

  it("rebinds an implicit workspace when the active owner changes", async () => {
    useRuntimeStore.setState({ workspace: owner });
    render(<FilePreviewInspector data={file} />);
    await editCoordinate();
    act(() => useRuntimeStore.setState({ workspace: "/workspaces/new owner" }));
    expect(await screen.findByLabelText("Coordinate x")).toHaveValue("0");
    await editCoordinate("0.8"); await clickSave(); await screen.findByText("No unsaved changes");
    expect(readRequests().map((request) => request.directory)).toEqual([owner, "/workspaces/new owner"]);
    expect(saveRequests()[0].directory).toBe("/workspaces/new owner");
  });

  it("ignores a late read from the previously viewed file", async () => {
    let finish: (value: unknown) => void = () => {};
    structureTransport.invoke.mockImplementation(async (_command, { request }) => {
      if (request.path === file.path) return new Promise((resolve) => { finish = resolve; });
      return { content: original.replace("0 0 0 T", "0.7 0 0 T"), hash: nextHash, path: "other/POSCAR" };
    });
    const { rerender } = render(<FilePreviewInspector data={file} workspaceDirectory={owner} />);
    await waitFor(() => expect(readRequests()).toHaveLength(1));
    rerender(<FilePreviewInspector data={{ ...file, path: "other/POSCAR" }} workspaceDirectory={owner} />);
    expect(await screen.findByLabelText("Coordinate x")).toHaveValue("0.7");
    await act(async () => { finish({ content: original, hash: firstHash, path: file.path }); });
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("0.7");
  });

  it.each(["disk", "home"] satisfies FilePreviewInspectorT["root"][])("reads %s crystal source with the ordinary reader and keeps it read-only", async (root) => {
    vi.mocked(readArtifact).mockResolvedValueOnce({ path: file.path, mime: "text/plain", encoding: "utf8", data: original, size: original.length });
    render(<FilePreviewInspector data={{ ...file, root }} />);
    expect(await screen.findByLabelText("Coordinate x")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(readArtifact).toHaveBeenCalledWith(file.path, root);
    expect(readRequests()).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.getByText(/Silicon/)).toBeInTheDocument();
  });

  it("keeps crystal edits when viewing the source and returning to Preview", async () => {
    render(<FilePreviewInspector data={file} workspaceDirectory={owner} />);
    await editCoordinate();
    await userEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.getByText(/Silicon/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("0.25");
    await clickSave(); await screen.findByText("No unsaved changes");
    expect(saveRequests()[0].content).toContain("0.25 0 0 T F T");
  });

  it("falls back to a read-only molecule preview and source for a protein CIF", async () => {
    const content = "data_protein\nloop_\n_atom_site.group_PDB\n_atom_site.type_symbol\n_atom_site.label_comp_id\n_atom_site.Cartn_x\n_atom_site.Cartn_y\n_atom_site.Cartn_z\nATOM C ALA 1 2 3\n";
    structureTransport.invoke.mockResolvedValue({ content, hash: firstHash, path: "protein.cif" });
    const { container } = render(<FilePreviewInspector data={{ ...file, path: "protein.cif", filename: "protein.cif" }} workspaceDirectory={owner} />);
    expect(await screen.findByText(/additional CIF semantics/)).toBeInTheDocument();
    expect(container.querySelector('[data-molecule-viewer="true"]')).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit this file" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.getByText(/data_protein/)).toBeInTheDocument();
    expect(saveRequests()).toHaveLength(0);
  });

  it("keeps complex CIF semantics read-only after a successful scoped structure read", async () => {
    const content = "data_partial\n_cell_length_a 4\n_cell_length_b 4\n_cell_length_c 4\n_cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 90\n_space_group_IT_number 1\nloop_\n_atom_site_type_symbol\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\n_atom_site_occupancy\nSi 0 0 0 0.5\n";
    structureTransport.invoke.mockResolvedValue({ content, hash: firstHash, path: "partial.cif" });
    render(<FilePreviewInspector data={{ ...file, filename: "partial.cif", path: "partial.cif" }} workspaceDirectory={owner} />);
    expect(await screen.findByText(/partial or zero occupancy/)).toBeInTheDocument();
    expect(screen.getByLabelText("Coordinate x")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(saveRequests()).toHaveLength(0);
  });

  it("loads inline browser-dev structures read-only without pretending to have a save hash", async () => {
    structureTransport.tauri = false;
    render(<FilePreviewInspector data={{ ...file, content: original }} />);
    expect(await screen.findByLabelText("Coordinate x")).toBeDisabled();
    expect(readRequests()).toHaveLength(0);
    expect(screen.getByText(/host has not enabled editing/)).toBeInTheDocument();
  });

  it("shows the read error without substituting an unscoped file or a saveable inline snapshot", async () => {
    structureTransport.invoke.mockRejectedValue({ code: "invalid_content", message: "Unsupported structure header and coordinate layout" });
    render(<FilePreviewInspector data={{ ...file, content: original }} workspaceDirectory={owner} />);
    expect(await screen.findByText("Unsupported structure header and coordinate layout")).toBeInTheDocument();
    expect(readArtifact).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(saveRequests()).toHaveLength(0);
  });

  it("keeps unsupported VASP text available under Code instead of leaving a blank preview", async () => {
    const unsupported = original.replace("Si\n", "");
    structureTransport.invoke.mockResolvedValue({ content: unsupported, hash: firstHash, path: file.path });
    render(<FilePreviewInspector data={file} workspaceDirectory={owner} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("VASP 4 files");
    await userEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.getByText(/Silicon/)).toBeInTheDocument();
    expect(saveRequests()).toHaveLength(0);
  });

  it("keeps an oversized CIF as exact plain source without sending it to an unbounded molecular parser", async () => {
    const content = "#".repeat(CRYSTAL_LIMITS.textLength + 1);
    structureTransport.invoke.mockResolvedValue({ content, hash: firstHash, path: "large.cif" });
    const { container } = render(<FilePreviewInspector data={{ ...file, path: "large.cif", filename: "large.cif" }} workspaceDirectory={owner} />);
    expect(await screen.findByText(/exceeds the preview limits/)).toBeInTheDocument();
    expect(screen.getByLabelText("Code").textContent).toBe(content);
    expect(container.querySelector('[data-molecule-viewer="true"]')).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("shows an explicit source-availability message when browser dev has no source", async () => {
    structureTransport.tauri = false;
    vi.mocked(readArtifact).mockResolvedValueOnce(null);
    render(<FilePreviewInspector data={file} />);
    expect(await screen.findByText(/Preview is available in the desktop app/)).toBeInTheDocument();
    expect(readRequests()).toHaveLength(0);
  });

  it("reads and saves via the authenticated gateway and enables the header download ticket", async () => {
    structureTransport.tauri = false;
    structureTransport.web = true;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === "POST"
      ? { hash: nextHash, version: 1 } : { content: original, hash: firstHash, path: file.path })));
    vi.stubGlobal("fetch", fetcher);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<FilePreviewInspector data={file} workspaceDirectory={owner} />);
    await editCoordinate(); await clickSave(); await screen.findByText("No unsaved changes");
    const [readUrl, readInit] = fetcher.mock.calls[0];
    const query = new URL(readUrl);
    expect(query.pathname).toBe("/v1/structures/read");
    expect(query.searchParams.get("dir")).toBe(owner);
    expect(query.searchParams.get("path")).toBe(file.path);
    expect(readInit?.headers).toEqual({ Authorization: "Bearer structure-test-token" });
    const [saveUrl, saveInit] = fetcher.mock.calls[1];
    expect(saveUrl).toBe("http://gateway.test/v1/structures/save");
    expect(JSON.parse(String(saveInit?.body))).toMatchObject({ expectedHash: firstHash, directory: owner, root: "workspace", path: file.path });
    expect(previewUrl).toHaveBeenCalledWith(file.path, undefined, owner);
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(open).toHaveBeenCalledWith("http://gateway.test/download-ticket", "_blank", "noopener");
    expect(structureTransport.invoke).not.toHaveBeenCalled();
  });

  it("retains a gateway conflict draft and sends the identical retry body without a background reread", async () => {
    structureTransport.tauri = false;
    structureTransport.web = true;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? new Response(JSON.stringify({ error: "Gateway source changed" }), { status: 409 })
      : new Response(JSON.stringify({ content: original, hash: firstHash, path: file.path })));
    vi.stubGlobal("fetch", fetcher);
    render(<FilePreviewInspector data={file} workspaceDirectory={owner} />);
    await editCoordinate(); await clickSave();
    expect(await screen.findByRole("alert")).toHaveTextContent("Gateway source changed");
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("0.25");
    await clickSave();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher.mock.calls[2][1]?.body).toBe(fetcher.mock.calls[1][1]?.body);
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body)).expectedHash).toBe(firstHash);
  });

  it("keeps gateway read-only clients and missing download tickets from exposing failing controls", async () => {
    structureTransport.tauri = false;
    structureTransport.web = true;
    useRuntimeStore.setState({ webReadOnly: true });
    vi.mocked(previewUrl).mockRejectedValueOnce(new Error("Ticket unavailable"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: original, hash: firstHash, path: file.path }))));
    render(<FilePreviewInspector data={file} workspaceDirectory={owner} />);
    expect(await screen.findByLabelText("Coordinate x")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save a copy..." })).toBeEnabled();
  });

  it("lets the gateway editor load and retain edits while a download ticket is pending", async () => {
    structureTransport.tauri = false;
    structureTransport.web = true;
    let finish: (value: string | null) => void = () => {};
    vi.mocked(previewUrl).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: original, hash: firstHash, path: file.path }))));
    render(<FilePreviewInspector data={file} workspaceDirectory={owner} />);
    await editCoordinate();
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
    await act(async () => { finish("http://gateway.test/late-ticket"); });
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("0.25");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("uses gateway file text for unsupported root scopes without granting structure writes", async () => {
    structureTransport.tauri = false;
    structureTransport.web = true;
    const fetcher = vi.fn(async () => new Response(original));
    vi.stubGlobal("fetch", fetcher);
    render(<FilePreviewInspector data={{ ...file, root: "home" }} workspaceDirectory={owner} />);
    expect(await screen.findByLabelText("Coordinate x")).toBeDisabled();
    expect(fetcher).toHaveBeenCalledWith("http://gateway.test/download-ticket");
    expect(previewUrl).toHaveBeenCalledWith(file.path, "home", owner);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(structureTransport.invoke).not.toHaveBeenCalled();
  });
});
