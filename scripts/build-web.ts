// Bundles each page into one self-contained HTML file (CSS and JS inlined), so a
// saved copy of /open keeps working without our server.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const PAGES = ["wall", "capsule", "open", "demo", "seal", "ask"];
const css = readFileSync("web/style.css", "utf8");
mkdirSync("dist/web", { recursive: true });

for (const page of PAGES) {
  const { outputFiles } = await build({
    entryPoints: [`web/${page}.ts`],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const js = outputFiles[0].text;
  if (/<\/script/i.test(js)) throw new Error(`${page}: bundle contains "</script", cannot inline it`);
  const html = readFileSync(`web/${page}.html`, "utf8")
    .replace("<!--CSS-->", () => `<style>${css}</style>`)
    .replace("<!--JS-->", () => `<script type="module">${js}</script>`);
  writeFileSync(`dist/web/${page}.html`, html);
  console.log(`dist/web/${page}.html  ${Math.round(html.length / 1024)} kB`);
}
