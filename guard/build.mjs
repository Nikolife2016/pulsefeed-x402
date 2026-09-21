// Сборка: tsc даёт dist/index.cjs + dist/index.d.cts из src/index.cts; ESM-обёртка и её типы
// кладутся из шаблонов. Один источник истины — index.cts.
import { execFileSync } from "node:child_process";
import { rmSync, copyFileSync, existsSync } from "node:fs";
rmSync("dist", { recursive: true, force: true });
execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { stdio: "inherit" });
copyFileSync("src/index.mjs.template", "dist/index.js");
copyFileSync("src/index.d.ts.template", "dist/index.d.ts");
for (const f of ["dist/index.cjs", "dist/index.d.cts", "dist/index.js", "dist/index.d.ts"]) if (!existsSync(f)) { console.error("missing", f); process.exit(1); }
console.error("built: dist/index.cjs index.d.cts index.js index.d.ts");   // stderr: stdout у `npm pack --json` должен остаться чистым JSON
