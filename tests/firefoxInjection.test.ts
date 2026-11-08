import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function fixture() {
  const source = ts.createSourceFile(
    "background.js",
    readFileSync("packages/firefox-attach-extension/src/background.js", "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = source.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "buildTabActionCode",
  )!;
  const build = new Function(
    declaration.getText(source) + ";return buildTabActionCode;",
  )() as (action: string, payload: unknown) => string;
  const page: Record<string, unknown> = {
    location: { href: "https://fixture.test/" },
  };
  const context = vm.createContext(page);
  page.window = page;
  const document = {
    title: "fixture",
    body: { scrollIntoView() {} },
    createElement: () => ({ textContent: "", remove() {} }),
    documentElement: {
      appendChild(script: { textContent: string }) {
        new vm.Script(script.textContent).runInContext(context);
      },
    },
  };
  page.document = document;
  return {
    page,
    inject: async (namespace: string, script: string) =>
      await new vm.Script(
        build("inject_script", { namespace, source: script }),
      ).runInContext(context),
  };
}
describe("Firefox page script injection", () => {
  it("executes repeatedly and refreshes previously exported global helpers", async () => {
    const { page, inject } = fixture();
    await expect(
      inject("TELLY", "window.sampleHelper=()=>1; TELLY.count=1;"),
    ).resolves.toMatchObject({ ok: true });
    const ns = page.TELLY as { sampleHelper: () => number; count: number };
    expect(ns.sampleHelper()).toBe(1);
    await expect(
      inject("TELLY", "window.sampleHelper=()=>2; TELLY.count++;"),
    ).resolves.toMatchObject({ ok: true });
    expect(ns.sampleHelper()).toBe(2);
    expect(ns.count).toBe(2);
    expect(page.__tellyNamespace).toBeUndefined();
    expect(page.__tellyBeforeKeys).toBeUndefined();
  });
  it("keeps the default namespace when a different namespace is used", async () => {
    const { page, inject } = fixture();
    await inject("TELLY", "TELLY.value='default';");
    await inject("OTHER", "TELLY.value='other';");
    expect(page.TELLY).toMatchObject({ value: "default" });
    expect(page.OTHER).toMatchObject({ value: "other" });
    await inject("OTHER", "TELLY.value='updated';");
    expect(page.TELLY).toMatchObject({ value: "default" });
    expect(page.OTHER).toMatchObject({ value: "updated" });
  });
});
