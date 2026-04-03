/**
 * Production: NODE_ENV=production npm run build
 * Watch: npm run watch (writes dist/; serve with uvicorn from server/)
 */
import * as esbuild from 'esbuild';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dist = join(root, 'dist');
const assets = join(dist, 'assets');

const isProd =
  process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const isWatch = process.argv.includes('--watch');

function copyStaticHtmlAndPublic() {
  mkdirSync(dist, { recursive: true });
  mkdirSync(assets, { recursive: true });

  let html = readFileSync(join(root, 'index.html'), 'utf8');
  html = html.replace(
    /<script src="\/src\/main\.ts" type="module"><\/script>/,
    '<script src="/assets/main.js" type="module"></script>',
  );
  const cssPath = join(assets, 'main.css');
  if (existsSync(cssPath)) {
    if (!html.includes('/assets/main.css')) {
      html = html.replace(
        '</head>',
        '    <link rel="stylesheet" href="/assets/main.css" />\n  </head>',
      );
    }
  }
  writeFileSync(join(dist, 'index.html'), html);
  copyFileSync(join(root, 'public', 'favicon.svg'), join(dist, 'favicon.svg'));
}

const ctx = await esbuild.context({
  absWorkingDir: root,
  entryPoints: [join(root, 'src/main.ts')],
  bundle: true,
  outfile: join(assets, 'main.js'),
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  minify: isProd,
  loader: { '.ts': 'ts', '.css': 'css' },
  plugins: [
    {
      name: 'ark-dist-html',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length === 0) copyStaticHtmlAndPublic();
        });
      },
    },
  ],
});

if (isWatch) {
  await ctx.watch();
  const r = await ctx.rebuild();
  if (r.errors.length) {
    console.error(r.errors);
    process.exit(1);
  }
  console.log('esbuild watch → dist/ (run uvicorn from server/ to serve)');
} else {
  const r = await ctx.rebuild();
  await ctx.dispose();
  if (r.errors.length) {
    console.error(r.errors);
    process.exit(1);
  }
  if (!existsSync(join(assets, 'main.js'))) {
    console.error('missing dist/assets/main.js');
    process.exit(1);
  }
  copyStaticHtmlAndPublic();
  console.log('built dist/');
}
