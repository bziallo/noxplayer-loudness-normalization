/* 把打过 patch/rjkm-fork-queue-sync.patch 的播放内核编译成 lib/ + es/。
 *
 *   node tools/build-rjkm-fork.mjs <NoxPlayer 目录>
 *
 * 上游把它当 git 依赖安装（yarn 会自动跑 babel），本地用 file: 依赖时需要自己跑一次。
 * 用宿主工程的 @babel/core，所以不要求内核自己装 devDependencies。
 * 注意：必须 NODE_ENV=production，否则 preset-react 会输出 jsxDEV（生产版 React 里没有）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'production';
process.env.BABEL_ENV = 'production';

const require = createRequire(import.meta.url);
const NoxDir = path.resolve(
  process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
);
const PKG = path.join(NoxDir, 'node_modules', 'react-jinke-music-player');
const SRC = path.join(PKG, 'src');

const babel = require(path.join(NoxDir, 'node_modules', '@babel', 'core'));
const presetEnv = require(path.join(NoxDir, 'node_modules', '@babel', 'preset-env'));
const presetReact = require(path.join(
  NoxDir,
  'node_modules',
  '@babel',
  'preset-react',
));

const files = [];
const walk = dir => {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  });
};
walk(SRC);

const build = (outDir, modules) => {
  let n = 0;
  files.forEach(file => {
    const target = path.join(PKG, outDir, path.relative(SRC, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!file.endsWith('.js')) {
      fs.copyFileSync(file, target);
      return;
    }
    const out = babel.transformFileSync(file, {
      babelrc: false,
      configFile: false,
      filename: file,
      presets: [
        [presetEnv, { modules }],
        [presetReact, { runtime: 'automatic', development: false }],
      ],
    });
    fs.writeFileSync(target, out.code);
    n += 1;
  });
  return n;
};

console.log('lib (cjs):', build('lib', 'commonjs'), 'files');
console.log('es  (esm):', build('es', false), 'files');
