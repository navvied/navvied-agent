import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const cells = (JSON.parse(readFileSync("analysis.ipynb", "utf8")) as { cells: { id?: string; cell_type: string; source: string[]; outputs?: unknown[] }[] }).cells;
const text = (c: { source: string[] }): string => c.source.join("");

test("the sum cell prints the mean", () => expect(text(cells.find((c) => c.id === "c2")!)).toBe("print(sum(data) / len(data))"));
test("a markdown note follows the title", () => { expect(cells[1]!.cell_type).toBe("markdown"); expect(text(cells[1]!)).toBe("Mean of the data"); });
test("the other cells keep their outputs", () => expect(cells.find((c) => c.id === "c1")!.outputs).toHaveLength(1));
test("the changed cell no longer shows the old output", () => expect(cells.find((c) => c.id === "c2")!.outputs).toEqual([]));
test("there are four cells", () => expect(cells).toHaveLength(4));
