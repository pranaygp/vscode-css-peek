import * as assert from "assert";

import selectorToString from "../../server/out/utils/selectorToString";

suite("selectorToString", () => {
  test("formats id", () => {
    const str = selectorToString({ attribute: "id", value: "foo" });
    assert.strictEqual(str, "#foo");
  });

  test("formats class", () => {
    const str = selectorToString({ attribute: "class", value: "bar" });
    assert.strictEqual(str, ".bar");
  });

  test("formats tag", () => {
    const str = selectorToString({ attribute: null as any, value: "div" });
    assert.strictEqual(str, "div");
  });
});
