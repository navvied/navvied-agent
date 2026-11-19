import { expect, test } from "bun:test";
import { greet } from "../src/greet.ts";
import { profileLine } from "../src/profile.ts";
import { fetchUser } from "../src/users.ts";

test("fetchUser", () => expect(fetchUser(2)).toEqual({ id: 2, name: "user-2" }));
test("greet", () => expect(greet(3)).toBe("Hello, user-3!"));
test("profileLine", () => expect(profileLine(4)).toBe("#4 user-4"));
