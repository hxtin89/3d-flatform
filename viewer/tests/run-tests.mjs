import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testFiles = readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.ts'))
  .sort();

for (const testFile of testFiles) {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, testFile)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [{
      name: 'viewer-config-stub',
      setup(build) {
        build.onResolve({ filter: /^\.\/viewer$/ }, () => ({
          path: 'viewer-config-stub',
          namespace: 'stub',
        }));
        build.onResolve({ filter: /^cesium$/ }, () => ({
          path: 'cesium-stub',
          namespace: 'stub',
        }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
          if (args.path === 'cesium-stub') {
            return {
              contents: `
                export class Cesium3DTileStyle {
                  constructor(options) { Object.assign(this, options); }
                }
              `,
              loader: 'js',
            };
          }
          return {
            contents: 'export const TILE_CONFIG = { baseUrl: "" };',
            loader: 'js',
          };
        });
      },
    }],
  });

  const code = result.outputFiles[0].text;
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

console.log(`viewer tests passed (${testFiles.length} files)`);
