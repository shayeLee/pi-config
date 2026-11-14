import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { electronPiInvocation } from "../electron-invocation.ts";

function fixture() {
 const dir = mkdtempSync(path.join(tmpdir(), "pi-electron-test-"));
 const pkg = path.join(dir, "node_modules/@earendil-works/pi-coding-agent");
 mkdirSync(path.join(pkg, "dist/bundle"), { recursive: true });
 writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: { pi: "dist/bundle/cli.js" } }));
 writeFileSync(path.join(pkg, "dist/bundle/cli.js"), "");
 const runtime = { versions: { electron: "40" }, argv: ["Mochi Helper", path.join(dir, "server.js")], platform: process.platform, env: { PATH: path.dirname(process.execPath) } } as typeof process;
 return { dir, pkg, runtime };
}
test("non-Electron leaves existing Node, Bun and standalone invocation branches untouched", () => {
 assert.equal(electronPiInvocation([], { versions: {} } as typeof process), undefined);
});
test("Electron uses absolute Node and host-declared bundled CLI, preserving arguments", () => {
 const f = fixture();
 try {
  const args = ["--mode", "json", "task with spaces; $(no-shell)"];
  assert.deepEqual(electronPiInvocation(args, f.runtime), { command: process.execPath, args: [path.join(f.pkg, "dist/bundle/cli.js"), ...args] });
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("missing Node fails explicitly instead of launching Helper or searching cwd", () => {
 const f = fixture();
 try { f.runtime.env.PATH = ".:"; assert.throws(() => electronPiInvocation([], f.runtime), /Node.js was not found/); }
 finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("missing host package fails explicitly", () => {
 const f = fixture();
 try { rmSync(path.join(f.pkg, "package.json")); assert.throws(() => electronPiInvocation([], f.runtime), /host Pi package was not found/); }
 finally { rmSync(f.dir, { recursive: true, force: true }); }
});
