#!/usr/bin/env node
/**
 * Build a fully static, GitHub Pages friendly copy of the app.
 *
 * The only difference from ./public is config.js:
 *   mode: "pages"  -> the browser calls api.deepseek.com directly
 *   mode: "server" -> the local Node proxy calls the API
 *
 * No bundler and no dependencies; every asset uses relative paths so the
 * output works at https://<user>.github.io/<repo>/ as well as at a domain root.
 */

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'dist-pages');
const API_BASE = (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await cp(SOURCE, OUT, { recursive: true });

const config = {
  mode: 'pages',
  apiBase: API_BASE,
};
await writeFile(
  path.join(OUT, 'config.js'),
  `window.DSC_CONFIG = ${JSON.stringify(config, null, 2)};\n`,
  'utf8',
);

// GitHub Pages serves static files only. The app has no client-side router,
// but this keeps an unknown sub-path from showing the default 404 page.
const fallback = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=./" />
    <title>DeepSeek Chatbox</title>
  </head>
  <body>
    <p><a href="./">打开 DeepSeek Chatbox</a></p>
    <script>location.replace(new URL('./', location.href).href);</script>
  </body>
</html>
`;
await writeFile(path.join(OUT, '404.html'), fallback, 'utf8');
await writeFile(path.join(OUT, '.nojekyll'), '', 'utf8');

console.log(`Built static site: ${OUT}`);
console.log(`API base: ${API_BASE}`);
console.log('Upload the contents of dist-pages/ to GitHub Pages.');
