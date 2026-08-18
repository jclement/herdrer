// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { DIAGRAM_SELECTOR, diagramSource, postHeight, renderDiagrams } from "./diagrams";

const SVG = '<svg id="d" viewBox="0 0 640 320" width="100%" style="max-width:640px"><g/></svg>';

/** Builds a document body the way internal/review/render.go emits one. */
function frame(...sources: string[]): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = sources
    .map((s) => `<figure class="mermaid-wrap"><pre class="mermaid">${s}</pre></figure>`)
    .join("");
  return root;
}

describe("diagramSource", () => {
  it("reads the escaped text the server emitted", () => {
    const root = frame("graph TD;\n  A--&gt;B;");
    expect(diagramSource(root.querySelector(DIAGRAM_SELECTOR)!)).toBe("graph TD;\n  A-->B;");
  });

  it("drops the blank lines a fenced block leaves around the source", () => {
    const pre = document.createElement("pre");
    pre.textContent = "\n\ngraph TD;\n  A-->B;\n\n  \n";
    expect(diagramSource(pre)).toBe("graph TD;\n  A-->B;");
  });

  it("normalises CRLF", () => {
    const pre = document.createElement("pre");
    pre.textContent = "graph TD;\r\n  A-->B;\r\n";
    expect(diagramSource(pre)).toBe("graph TD;\n  A-->B;");
  });

  it("removes common indentation but keeps relative indentation", () => {
    const pre = document.createElement("pre");
    pre.textContent = "    graph TD;\n      A-->B;\n\n      B-->C;\n";
    expect(diagramSource(pre)).toBe("graph TD;\n  A-->B;\n\n  B-->C;");
  });

  it("is empty for a placeholder with nothing in it", () => {
    const pre = document.createElement("pre");
    pre.textContent = "   \n\n";
    expect(diagramSource(pre)).toBe("");
  });
});

describe("renderDiagrams", () => {
  it("replaces the source with the rendered svg", async () => {
    const root = frame("graph TD;\n  A--&gt;B;");
    const render = vi.fn(async () => SVG);

    const summary = await renderDiagrams(root, render);

    expect(summary).toEqual({ total: 1, rendered: 1, failed: 0 });
    expect(render).toHaveBeenCalledWith(expect.any(String), "graph TD;\n  A-->B;");
    expect(root.querySelector(DIAGRAM_SELECTOR)).toBeNull();
    expect(root.querySelector(".mermaid-figure svg")).not.toBeNull();
  });

  it("fits to width by default and pans once zoomed", async () => {
    const root = frame("graph TD;");
    await renderDiagrams(root, async () => SVG);

    const figure = root.querySelector<HTMLElement>(".mermaid-figure")!;
    const svg = figure.querySelector("svg")!;
    expect(figure.dataset.zoom).toBe("fit");
    expect(svg.style.width).toBe("100%");
    expect(figure.style.getPropertyValue("--mmd-natural")).toBe("640px");

    figure.querySelector<HTMLElement>(".mermaid-viewport")!.click();
    expect(figure.dataset.zoom).toBe("pan");
    expect(svg.style.width).toBe("640px");

    figure.querySelector<HTMLButtonElement>('button[aria-label^="Fit"]')!.click();
    expect(figure.dataset.zoom).toBe("fit");
  });

  it("leaves the source visible with a note when a diagram will not parse", async () => {
    const root = frame("graph TD;\n  A--&gt;B;");
    const render = vi.fn(async () => {
      throw new Error("Parse error on line 2:\n  A-->B;\n  ^");
    });

    const summary = await renderDiagrams(root, render);

    expect(summary).toEqual({ total: 1, rendered: 0, failed: 1 });
    const pre = root.querySelector<HTMLElement>(DIAGRAM_SELECTOR);
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("A-->B;");
    expect(pre!.classList.contains("mermaid-unrendered")).toBe(true);

    const note = root.querySelector(".mermaid-error")!;
    expect(note.textContent).toContain("showing source");
    // The message quotes the agent's source back, so it must never be markup.
    expect(note.innerHTML).not.toContain("<");
  });

  it("keeps rendering after one diagram fails", async () => {
    const root = frame("bad", "graph TD;");
    const render = vi.fn(async (_id: string, source: string) => {
      if (source === "bad") throw new Error("nope");
      return SVG;
    });

    const summary = await renderDiagrams(root, render);

    expect(summary).toEqual({ total: 2, rendered: 1, failed: 1 });
    expect(root.querySelectorAll(DIAGRAM_SELECTOR)).toHaveLength(1);
    expect(root.querySelectorAll(".mermaid-figure svg")).toHaveLength(1);
  });

  it("degrades when the renderer returns nothing usable", async () => {
    const root = frame("graph TD;", "graph TD;");
    const summary = await renderDiagrams(root, async (_id, src) =>
      src === "graph TD;" ? "" : SVG,
    );

    expect(summary.failed).toBe(2);
    expect(root.querySelectorAll(DIAGRAM_SELECTOR)).toHaveLength(2);
    expect(root.querySelector(".mermaid-error")!.textContent).toContain("no diagram");
  });

  it("degrades rather than throwing when the svg is missing from the markup", async () => {
    const root = frame("graph TD;");
    await expect(renderDiagrams(root, async () => "<div>not a diagram</div>")).resolves.toEqual({
      total: 1,
      rendered: 0,
      failed: 1,
    });
    expect(root.querySelector(DIAGRAM_SELECTOR)).not.toBeNull();
  });

  it("does not add a second note when the same diagram fails twice", async () => {
    const root = frame("graph TD;");
    const boom = async () => {
      throw new Error("nope");
    };
    await renderDiagrams(root, boom);
    await renderDiagrams(root, boom);
    expect(root.querySelectorAll(".mermaid-error")).toHaveLength(1);
  });

  it("reports the new height once diagrams land", async () => {
    const root = frame("graph TD;");
    const onChange = vi.fn();
    await renderDiagrams(root, async () => SVG, { onChange });
    expect(onChange).toHaveBeenCalled();
  });
});

describe("postHeight", () => {
  it("sends exactly the shape the parent validates", () => {
    vi.spyOn(document.documentElement, "getBoundingClientRect").mockReturnValue({
      height: 812.4,
    } as DOMRect);
    const target = { postMessage: vi.fn() } as unknown as Window;

    postHeight(document, target);

    expect(target.postMessage).toHaveBeenCalledWith({ type: "herdrer:height", height: 813 }, "*");
    vi.restoreAllMocks();
  });

  it("stays quiet when there is nothing sane to report", () => {
    vi.spyOn(document.documentElement, "getBoundingClientRect").mockReturnValue({
      height: 0,
    } as DOMRect);
    const target = { postMessage: vi.fn() } as unknown as Window;

    postHeight(document, target);
    postHeight(document, null);

    expect(target.postMessage).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
