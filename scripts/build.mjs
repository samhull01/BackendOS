import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const url = process.env.SUPABASE_URL || "";
const key = process.env.SUPABASE_PUBLISHABLE_KEY || "";
if (key && !key.startsWith("sb_publishable_"))
  throw Error(
    "Use a Supabase publishable key, never a secret/service-role key.",
  );
if (url && (!url.startsWith("https://") || new URL(url).pathname !== "/"))
  throw Error("SUPABASE_URL must be an HTTPS project origin.");
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/client.js"],
  bundle: true,
  format: "iife",
  outfile: "dist/client.js",
  define: { BUILD_URL: JSON.stringify(url), BUILD_KEY: JSON.stringify(key) },
});
await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  format: "iife",
  outfile: "dist/app.js",
});
await build({
  entryPoints: ["src/hotel-tax.js"],
  bundle: true,
  format: "iife",
  outfile: "dist/hotel-tax.js",
});
await writeFile("dist/index.html", await readFile("index.html"));
