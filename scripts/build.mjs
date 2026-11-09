import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

const output = new URL("../dist/", import.meta.url);
const source = new URL("../", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const publicFile = /\.(?:html|webp|png|jpg|mp4|vtt|xml|txt)$/;
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (entry.isFile() && publicFile.test(entry.name)) {
    await cp(new URL(entry.name, source), new URL(entry.name, output));
  }
}
await cp(new URL("assets/", source), new URL("assets/", output), { recursive: true });

const isProduction = process.env.VERCEL_ENV === "production" || process.env.CONTEXT === "production";
if (isProduction && process.env.SITE_INDEXING_ENABLED === "1") {
  const home = new URL("index.html", output);
  const html = await readFile(home, "utf8");
  await writeFile(home, html.replace('<meta name="robots" content="noindex, nofollow">\n', ""));
}
