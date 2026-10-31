import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const HTML_RENDERER_MARKER = 'i.innerHTML=o,i.getElementsByTagName("script").length>0';
const RENDERER_PATCH_MARKER = "function rewritePublicFileIframes";

export function rewritePublicFileIframes(html, currentUrl) {
  const appBase = new URL("../", currentUrl);
  const routes = new Map([
    ["datax-now.github.io", ["/go/public-files/"]],
    ["datax.now", ["/public-files/"]],
    ["datax-now.pages.dev", ["/public-files/"]],
    ["datax-now.readthedocs.io", ["/en/latest/_static/public-files/"]],
  ]);

  return html.replace(
    /(<iframe\b[^>]*?\bsrc\s*=\s*)(["'])(https:\/\/[^"']+)\2/gi,
    (match, attribute, quote, sourceUrl) => {
      let remote;
      try {
        remote = new URL(sourceUrl.replace(/&amp;/gi, "&"));
      } catch {
        return match;
      }
      const pathPrefix = routes.get(remote.hostname)?.find(prefix => remote.pathname.startsWith(prefix));
      if (!pathPrefix) return match;

      const local = new URL(`public-files/${remote.pathname.slice(pathPrefix.length)}`, appBase);
      local.search = remote.search;
      local.hash = remote.hash;
      return `${attribute}${quote}${local.href.replace(/&/g, "&amp;")}${quote}`;
    },
  );
}

export function patchCoreBundle(target) {
  const isFile = statSync(target).isFile();
  const candidates = isFile
    ? [target]
    : readdirSync(target)
      .filter(name => /^jlab_core\..+\.js$/.test(name))
      .map(name => join(target, name));
  if (candidates.length !== 1) {
    throw new Error(`Expected one JupyterLab core bundle in ${target}, found ${candidates.length}`);
  }

  const bundlePath = candidates[0];
  if (basename(bundlePath).endsWith(".map")) {
    throw new Error(`Expected a JavaScript bundle, got ${bundlePath}`);
  }
  const source = readFileSync(bundlePath, "utf8");
  if (source.includes(RENDERER_PATCH_MARKER)) return false;
  const matches = source.split(HTML_RENDERER_MARKER).length - 1;
  if (matches !== 1) {
    throw new Error(`Could not locate JupyterLab's HTML renderer in ${bundlePath} (found ${matches} markers)`);
  }

  const replacement =
    `i.innerHTML=(${rewritePublicFileIframes.toString()})(o,location.href),` +
    'i.getElementsByTagName("script").length>0';
  writeFileSync(bundlePath, source.replace(HTML_RENDERER_MARKER, replacement));
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!target) throw new Error("Usage: node scripts/patch-public-file-iframes.mjs <dist/build-or-bundle>");
  const changed = patchCoreBundle(target);
  console.log(changed
    ? "  ✓ HTML output iframes use same-origin public files"
    : "  ✓ HTML output iframe routing already patched");
}
