import { expect, test } from "bun:test";
import { parseCsv } from "../src/csv.ts";

test("rows and cells", () => expect(parseCsv("a,b\nc,d")).toEqual([["a", "b"], ["c", "d"]]));
test("a trailing newline adds no row", () => expect(parseCsv("a,b\n")).toEqual([["a", "b"]]));
test("empty input has no rows", () => expect(parseCsv("")).toEqual([]));
test("quoted cells may contain commas", () => expect(parseCsv('x,"y,z"\n')).toEqual([["x", "y,z"]]));
test("CRLF line endings", () => expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([["a", "b"], ["c", "d"]]));
