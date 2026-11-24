import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeAccount } from "../src/account.ts";
import { searchFor } from "../src/create.ts";
import { accountPath, configPath } from "../src/config.ts";
import { remove, tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach(remove));
const home = (signedIn: boolean) => {
  const state = tempDir();
  dirs.push(state);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state };
  mkdirSync(dirname(configPath(env)), { recursive: true });
  if (signedIn) writeAccount(accountPath(env), { server: "https://account.example", token: "nv_token", email: "me@example.com" });
  return env;
};

describe("where search goes", () => {
  test("a signed-in computer asks navvied's search with its account, a computer that is not asks as a guest, and the account is read when asked", () => {
    const env = home(true);
    const search = searchFor(env, {}, false);
    expect(search.navvied?.()).toEqual({ server: "https://account.example", token: "nv_token" });
    expect(searchFor(home(false), {}, false).navvied?.()).toEqual({ server: "https://navvied.com" });
    expect(searchFor({ ...home(false), NAVVIED_SERVER: "https://own.example" }, {}, false).navvied?.()).toEqual({ server: "https://own.example" });
  });
  test("the person's own server and order are passed on; a session that reaches the web through the service has no search of its own", () => {
    expect(searchFor({ ...home(false), NAVVIED_SEARCH_URL: "https://s.example/search", NAVVIED_SEARCH_ORDER: " wikipedia, navvied ,," }, {}, false)).toMatchObject({ url: "https://s.example/search", order: ["wikipedia", "navvied"] });
    expect(searchFor(home(true), {}, true).navvied).toBeUndefined();
    expect(searchFor(home(true), { sandboxed: true }, false).navvied).toBeUndefined();
  });
});
