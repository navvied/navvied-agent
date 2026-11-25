import { afterAll, describe, expect, test } from "bun:test";
import { PASSWORD_WORDS } from "../src/password-words.ts";
import { secretsIn } from "../src/redact.ts";
import { cleanupAll } from "./helpers.ts";

afterAll(async () => { await cleanupAll(); });
const KEY = "sk-ant-api03-abcdefghijklmnop1234567890XYZ";

describe("what a person typed in their own message", () => {
  test("is found by its shape, by the name it is assigned to, and by being called a password in words; plain words are not", () => {
    expect(secretsIn(`use ${KEY} please`)).toEqual([KEY]);
    expect(secretsIn("export DB_PASSWORD=Zx9!kQ7mPw2 then run it")).toEqual(["Zx9!kQ7mPw2"]);
    expect(secretsIn("my password is Zx9!kQ7mPw2, ssh in")).toEqual(["Zx9!kQ7mPw2"]);
    expect(secretsIn("passphrase: Kuda-Biru-42 for the server")).toEqual(["Kuda-Biru-42"]);
    // Every word for "password" the data knows, in every language, with a colon, with a space, and with the word glued to the value as in Chinese and Japanese.
    for (const [language, words] of Object.entries(PASSWORD_WORDS)) {
      for (const word of words) {
        expect(secretsIn(`${word}: Zx9!kQ7mPw2`), `${language} ${word}`).toEqual(["Zx9!kQ7mPw2"]);
        expect(secretsIn(`my ${word} Zx9!kQ7mPw2 ok`), `${language} ${word} with a space`).toEqual(["Zx9!kQ7mPw2"]);
      }
    }
    expect(secretsIn("密码是Zx9!kQ7mPw2")).toEqual(["Zx9!kQ7mPw2"]);
    expect(secretsIn("パスワードは Zx9!kQ7mPw2")).toEqual(["Zx9!kQ7mPw2"]);
    expect(secretsIn("the password is wrong, and the token is broken")).toEqual([]);
    expect(secretsIn("list the files and fix the build")).toEqual([]);
  });
});
