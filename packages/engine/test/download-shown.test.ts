import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { shownFile } from "../src/tools/browser.ts";

describe("where a download is said to be", () => {
  test("from the project, with forward slashes on every system", () => {
    expect(shownFile("C:\\work\\app", "C:\\work\\app\\downloads\\notes.txt", win32)).toBe("downloads/notes.txt");
    expect(shownFile("/work/app", "/work/app/downloads/notes.txt", posix)).toBe("downloads/notes.txt");
  });

  test("a place that cannot be said from the project is said whole, and a backslash in a name stays where the system allows it", () => {
    expect(shownFile("C:\\work\\app", "D:\\other\\notes.txt", win32)).toBe("D:/other/notes.txt");
    expect(shownFile("/work/app", "/work/app/odd\\name.txt", posix)).toBe("odd\\name.txt");
  });
});
