import { describe, expect, test } from "bun:test";
import { stillWaitedFor } from "../src/tools/browser/tab.ts";

describe("a page that does not open says what it was waiting for", () => {
  test("the first few unanswered addresses by computer and path, never what follows a question mark", () => {
    expect(stillWaitedFor(["http://127.0.0.1:8080/order?token=secret#part", "https://example.com/a", "https://example.com/b", "https://example.com/c"])).toBe("still waiting for an answer from 127.0.0.1:8080/order, example.com/a, example.com/b");
  });
  test("and says so when nothing is unanswered", () => {
    expect(stillWaitedFor([])).toBe("the page asked the network for nothing that is still unanswered");
    expect(stillWaitedFor(["not an address"])).toBe("still waiting for an answer from an address that cannot be read");
  });
});
