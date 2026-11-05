// Runs the extension inside a real VS Code, where a mock cannot lie: the editor's
// own CodeLens and document symbol commands, its dialogs and its language detection.
//   VSCODE_EXECUTABLE=/path/to/Code node test/e2e/run.js      a VS Code that is installed
//   node test/e2e/run.js                                      downloads one (npm i --no-save @vscode/test-electron)
// It uses a temporary profile and needs a C++ compiler on PATH. On Linux without a display: xvfb-run -a.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const has = cmd => { const r = spawnSync(cmd, ['--version'], { windowsHide: true }); return !r.error && r.status === 0; };

async function main() {
  const compiler = ['g++', 'clang++'].find(has);
  if (!compiler) throw new Error('No C++ compiler on PATH.');
  const executable = process.env.VSCODE_EXECUTABLE || await require('@vscode/test-electron').downloadAndUnzipVSCode('stable');
  // Short: VS Code's socket lives in the profile, and socket paths are limited to about 100 characters.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asl-')));
  const profile = path.join(tmp, 'u');
  const project = path.join(tmp, 'p');
  fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
    'workbench.startupEditor': 'none', 'extensions.autoUpdate': false, 'window.restoreWindows': 'none', 'git.enabled': false
  }));
  fs.cpSync(path.join(__dirname, '..', 'fixtures', 'auto'), project, { recursive: true });
  fs.writeFileSync(path.join(project, '.asm-lens.json'), JSON.stringify({ mode: 'local', compiler, flags: '-O2 -std=c++20' }));
  // Remote compiles of this one folder go to a port nobody listens on: only the question before sending is tested.
  fs.mkdirSync(path.join(project, 'remote'));
  fs.writeFileSync(path.join(project, 'remote', 'r.cpp'), 'int r() { return 1; }\n');
  fs.writeFileSync(path.join(project, 'remote', '.asm-lens.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:9', compilers: [{ id: 'g152' }] }));

  // A project with compile_commands.json: a header is compiled the way the files listed there see it.
  const db = path.join(project, 'db');
  fs.cpSync(path.join(__dirname, '..', 'fixtures', 'db'), db, { recursive: true });
  fs.writeFileSync(path.join(db, 'compile_commands.json'), JSON.stringify([
    { directory: '.', file: 'src/a.cpp', command: `${compiler} -DFEATURE_A -Iinclude -O2 -std=c++17 -c src/a.cpp -o a.o` },
    { directory: '.', file: 'src/b.cpp', command: `${compiler} -DFEATURE_B -Iinclude -O2 -std=c++17 -c src/b.cpp -o b.o` }
  ]));
  fs.writeFileSync(path.join(db, '.asm-lens.json'), JSON.stringify({ mode: 'local', compileCommands: 'compile_commands.json' }));

  // The same file listed for two builds, and a chosen type that needs the .cpp's includes.
  const builds = path.join(project, 'builds');
  fs.cpSync(path.join(__dirname, '..', 'fixtures', 'builds'), builds, { recursive: true });
  const entry = flag => ({ directory: '.', file: 'u.cpp', command: `${compiler} ${flag} -O2 -std=c++17 -c u.cpp -o u.o` });
  fs.writeFileSync(path.join(builds, 'compile_commands.json'), JSON.stringify([entry('-DBUILD_A'), entry('-DBUILD_B')]));
  fs.writeFileSync(path.join(builds, '.asm-lens.json'), JSON.stringify({ mode: 'local', compileCommands: 'compile_commands.json' }));

  const result = path.join(tmp, 'result.json');
  const env = { ...process.env, ASM_LENS_E2E_RESULT: result };
  for (const k of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|VSCODE_)/.test(k)) delete env[k];
  const args = [
    `--user-data-dir=${profile}`, `--extensions-dir=${path.join(tmp, 'e')}`, `--extensionDevelopmentPath=${ROOT}`,
    `--extensionTestsPath=${path.join(__dirname, 'suite.js')}`, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    '--disable-updates', '--disable-telemetry', '--new-window', ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : []), project
  ];
  const run = spawnSync(executable, args, { env, stdio: 'inherit', timeout: 300000, shell: process.platform === 'win32' && /\.cmd$/i.test(executable) });
  if (!fs.existsSync(result)) throw new Error(`VS Code ended without results (exit ${run.status}${run.error ? `, ${run.error.message}` : ''}).`);
  const { version, tests } = JSON.parse(fs.readFileSync(result, 'utf8'));
  console.log(`VS Code ${version}, compiler ${compiler}`);
  for (const t of tests) console.log(`${t.error ? 'not ok' : 'ok'} - ${t.name}${t.error ? `\n${t.error}` : ''}`);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  const failed = tests.filter(t => t.error).length;
  console.log(`${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
