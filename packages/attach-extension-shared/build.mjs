import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import process from "node:process";

const root = path.dirname(fileURLToPath(import.meta.url));
const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  strict: true,
  skipLibCheck: true,
  types: [],
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  noEmit: true,
};
export function inspectorBundle(entry) {
  const included = ["context", entry];
  const bodies = included
    .map(
      (name) =>
        `${JSON.stringify("./" + name)}:(module,exports,require)=>{\n${ts.transpileModule(readFileSync(path.join(root, "src", name + ".ts"), "utf8"), { compilerOptions: options }).outputText}\n}`,
    )
    .join(",\n");
  return `(()=>{"use strict";const modules={${bodies}};const cache={};function require(id){if(!cache[id]){const module={exports:{}};cache[id]=module;modules[id](module,module.exports,require);}return cache[id].exports;}require(${JSON.stringify("./" + entry)});})();\n`;
}
export function buildInspector(dist) {
  const modules = ["context", "controller", "background"];
  const files = modules.map((name) => path.join(root, "src", name + ".ts"));
  const diagnostics = ts.getPreEmitDiagnostics(
    ts.createProgram(files, options),
  );
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (x) => x,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => "\n",
      }),
    );
  writeFileSync(
    path.join(dist, "inspector-content.js"),
    inspectorBundle("controller"),
  );
  const background = path.join(dist, "background.js");
  writeFileSync(
    background,
    inspectorBundle("background") + readFileSync(background, "utf8"),
  );
}
