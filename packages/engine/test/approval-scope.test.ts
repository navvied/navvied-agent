import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { approvalScope } from "../src/approval-scope.ts";

describe("what 'do not ask again' covers", () => {
  const cwd = "/work/shop";
  test("a command is covered by its first word, past variables and sudo", () => {
    expect(approvalScope("Bash", { command: "npm install left-pad" }, cwd)).toEqual({ key: "bash:npm", phrase: "npm commands" });
    expect(approvalScope("Bash", { command: "NODE_ENV=test sudo /usr/bin/make build" }, cwd)).toEqual({ key: "bash:make", phrase: "make commands" });
    expect(approvalScope("Bash", { command: "" }, cwd).phrase).toBe("commands");
    expect(approvalScope("Bash", {}, cwd).key).toBe("bash:");
  });
  test("a change is covered by the folder it is in, or the project folder for a file at the top", () => {
    expect(approvalScope("Edit", { file_path: "/work/shop/src/a.ts" }, cwd)).toEqual({ key: "file:src", phrase: "changes in src/" });
    expect(approvalScope("Write", { file_path: "src/deep/b.ts" }, cwd).key).toBe("file:src");
    expect(approvalScope("Write", { file_path: "/work/shop/README.md" }, cwd)).toEqual({ key: "file:.", phrase: "changes in the project folder" });
  });
  test("a file outside the project is never covered by a permission given for the project", () => {
    expect(approvalScope("Edit", { file_path: resolve("/etc/hosts") }, cwd)).toEqual({ key: `outside:${resolve("/etc")}`, phrase: `changes in ${resolve("/etc")}` });
    expect(approvalScope("Edit", { file_path: "../other/x.ts" }, cwd).key).toBe(`outside:${resolve("/work/other")}`);
    expect(approvalScope("Write", { file_path: "" }, cwd).key.startsWith("outside:")).toBe(true);
    expect(approvalScope("Edit", { file_path: "/etc/hosts" }, cwd).key).not.toBe(approvalScope("Edit", { file_path: "/work/shop/hosts" }, cwd).key);
  });
  test("a web page is covered by its site; anything else by the tool", () => {
    expect(approvalScope("WebFetch", { url: "https://example.com/a?b=1" }, cwd)).toEqual({ key: "web:example.com", phrase: "pages on example.com" });
    expect(approvalScope("WebFetch", { url: "nonsense" }, cwd).key).toBe("tool:WebFetch");
    expect(approvalScope("Mystery", {}, cwd)).toEqual({ key: "tool:Mystery", phrase: "Mystery" });
  });
});
