import { build, context } from "esbuild";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

/**
 * The shared review core imports the server's TypeScript source using NodeNext
 * `.js` specifiers (e.g. `../prompt.js`). tsc resolves those to the `.ts` source
 * natively, but esbuild does not — this plugin rewrites a relative `.js` import
 * to its sibling `.ts` when one exists, so we bundle straight from source with
 * zero changes to the server package.
 */
const jsToTs = {
  name: "js-to-ts",
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.importer) return undefined;
      if (!args.path.startsWith(".")) return undefined;
      const candidate = resolve(dirname(args.importer), args.path.replace(/\.js$/, ".ts"));
      return existsSync(candidate) ? { path: candidate } : undefined;
    });
  },
};

const options = {
  entryPoints: [resolve(root, "src/extension.ts")],
  outfile: resolve(root, "dist/extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  // The VS Code API is injected by the extension host; the Agent SDK is loaded
  // lazily at runtime only when the claude-agent engine is used.
  external: ["vscode", "@anthropic-ai/claude-agent-sdk"],
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
  plugins: [jsToTs],
};

if (watch) {
  // Keep an esbuild context alive so it rebuilds on every source change.
  const ctx = await context(options);
  await ctx.watch();
  console.log("esbuild: watching for changes…");
} else {
  await build(options);
}
