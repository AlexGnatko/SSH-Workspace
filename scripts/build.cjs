const { existsSync } = require('node:fs');
const { copyFile, mkdir, readdir } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { dirname, join } = require('node:path');
const { build } = require('esbuild');
const { packages } = require('../package-lock.json');

async function copyLicenses() {
  const destination = join('dist', 'licenses');
  const electron = dirname(require.resolve('electron/package.json'));
  const executable = require('electron');
  const electronDist = process.env.ELECTRON_OVERRIDE_DIST_PATH ?? join(electron, 'dist');
  const chromiumNotices = 'LICENSES.chromium.html';
  const chromiumPath = [
    join(electronDist, chromiumNotices),
    join(dirname(executable), '..', 'Resources', chromiumNotices),
  ].find((path) => existsSync(path));
  if (!chromiumPath) throw new Error('Electron is missing its Chromium license notices.');

  await mkdir(destination, { recursive: true });
  const copies = [
    copyFile('LICENSE', join(destination, 'SSH-Workspace.txt')),
    copyFile(join(electron, 'LICENSE'), join(destination, 'Electron.txt')),
    copyFile(chromiumPath, join(destination, chromiumNotices)),
  ];
  if (process.platform === 'win32') copies.push(
    copyFile('licenses/ConPTY.txt', join(destination, 'ConPTY.txt')),
    copyFile('node_modules/node-pty/deps/winpty/LICENSE', join(destination, 'winpty.txt')),
  );
  const cpuFeaturesLicense = 'node_modules/cpu-features/deps/cpu_features/LICENSE';
  if (existsSync(cpuFeaturesLicense)) {
    copies.push(copyFile(cpuFeaturesLicense, join(destination, 'google-cpu-features.txt')));
  }
  for (const [path, pkg] of Object.entries(packages)) {
    if (!path || pkg.dev || !existsSync(path)) continue;
    const names = (await readdir(path)).filter((name) => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name));
    if (!names.length) throw new Error('Missing license for runtime dependency ' + path);
    const packageName = path.split('node_modules/').at(-1).replace('/', '-');
    for (const name of names) {
      copies.push(copyFile(join(path, name), join(destination, packageName + '-' + pkg.version + '-' + name + '.txt')));
    }
  }
  await Promise.all(copies);
}

async function bundle() {
  if (process.platform === 'win32') {
    const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
    const source = join(process.cwd(), 'src', 'ssh-windows.cs');
    const target = join(process.cwd(), 'dist', 'ssh-windows.exe');
    const result = spawnSync(compiler, [
      '/nologo', '/optimize+', '/codepage:65001', '/utf8output', '/target:exe', '/out:' + target, source,
    ], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw result.error ?? new Error('Could not build the Windows OpenSSH wrapper.');
  }
  await Promise.all([
    build({
      entryPoints: ['src/renderer.ts'],
      bundle: true,
      outfile: 'dist/renderer.js',
    }),
    copyFile('src/index.html', 'dist/index.html'),
    copyFile('src/style.css', 'dist/style.css'),
    copyFile('node_modules/@xterm/xterm/css/xterm.css', 'dist/xterm.css'),
    copyLicenses(),
  ]);
}

bundle().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
