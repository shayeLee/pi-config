import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

/** Electron's utility-process executable is not a reusable Node/Pi executable. */
export function electronPiInvocation(args: string[], runtime = process): { command: string; args: string[] } | undefined {
	if (!runtime.versions.electron) return undefined;
	const entry = runtime.argv[1];
	if (!entry || !path.isAbsolute(entry)) throw new Error("Cannot start Pi subagent: Electron host entry is missing.");
	// Resolve the host's installed Pi, not an unrelated global pi installation.
	const roots = createRequire(entry).resolve.paths("@earendil-works/pi-coding-agent") ?? [];
	const manifest = roots.map(root => path.join(root, "@earendil-works/pi-coding-agent/package.json"))
		.find(file => fs.existsSync(file));
	if (!manifest) throw new Error("Cannot start Pi subagent: host Pi package was not found.");
	const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
	const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
	if (typeof bin !== "string") throw new Error("Cannot start Pi subagent: host Pi CLI is not declared.");
	const cli = path.resolve(path.dirname(manifest), bin);
	if (!fs.statSync(cli).isFile()) throw new Error("Cannot start Pi subagent: host Pi CLI is missing.");
	// Mochi imports the login-shell PATH. Resolve it now to an absolute executable;
	// never fall back to Electron Helper, a shell, or the task's working directory.
	const name = runtime.platform === "win32" ? "node.exe" : "node";
	const node = (runtime.env.PATH ?? "").split(path.delimiter).filter(dir => path.isAbsolute(dir))
		.map(dir => path.join(dir, name)).find(file => {
			try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
			catch { return false; }
		});
	if (!node) throw new Error("Cannot start Pi subagent: Node.js was not found in the desktop login-shell PATH.");
	return { command: node, args: [cli, ...args] };
}
