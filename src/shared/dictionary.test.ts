import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Dictionary } from "./dictionary";

describe("Dictionary", () => {
  it("rejects the permissive short junk words seen in production", () => {
    const content = readFileSync(resolve(process.cwd(), "public/dictionary/en-large.txt"), "utf8");
    const dictionary = new Dictionary(content);

    expect(dictionary.has("APPLE")).toBe(true);
    expect(dictionary.has("HELLO")).toBe(true);
    expect(dictionary.has("QUIZ")).toBe(true);

    expect(dictionary.has("ZS")).toBe(false);
    expect(dictionary.has("EU")).toBe(false);
    expect(dictionary.has("LL")).toBe(false);
    expect(dictionary.has("AF")).toBe(false);
    expect(dictionary.has("NA")).toBe(false);
    expect(dictionary.has("QV")).toBe(false);
    expect(dictionary.has("LG")).toBe(false);
    expect(dictionary.has("IE")).toBe(false);
    expect(dictionary.has("ZELANT")).toBe(false);
  });
});
