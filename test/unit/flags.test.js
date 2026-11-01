const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const F = require('../../src/flags');

test('stripSyntaxFlags: -masm and -mllvm -x86-asm-syntax are taken out; AT&T is remembered', () => {
  assert.deepEqual(F.stripSyntaxFlags('-O2 -masm=intel'), { flags: '-O2', syntax: 'intel' });
  assert.deepEqual(F.stripSyntaxFlags('-masm=intel -O2 -DX=1'), { flags: '-O2 -DX=1', syntax: 'intel' });
  assert.deepEqual(F.stripSyntaxFlags('-O1 -masm=att'), { flags: '-O1', syntax: 'att' });
  assert.deepEqual(F.stripSyntaxFlags('-O3 -mllvm -x86-asm-syntax=intel -g'), { flags: '-O3 -g', syntax: 'intel' });
  assert.deepEqual(F.stripSyntaxFlags('-mllvm --x86-asm-syntax=att'), { flags: '', syntax: 'att' });
  assert.deepEqual(F.stripSyntaxFlags('-O2 -mllvm -inline-threshold=5'), { flags: '-O2 -mllvm -inline-threshold=5', syntax: 'intel' });
  assert.deepEqual(F.stripSyntaxFlags('"-DNAME=-masm=intel"'), { flags: '"-DNAME=-masm=intel"', syntax: 'intel' }, 'only whole flags');
  assert.deepEqual(F.stripSyntaxFlags(''), { flags: '', syntax: 'intel' });
  assert.deepEqual(F.stripSyntaxArgs(['-O2', '-masm=att', '-mllvm', '-x86-asm-syntax=intel', '-I', 'x']), { args: ['-O2', '-I', 'x'], syntax: 'intel' });
});

test('compilerKind, targetOf, syntaxArgs: the right syntax flag for each compiler and target', () => {
  assert.equal(F.compilerKind('g++ (GCC) 14.2.0\nCopyright (C) 2024 Free Software Foundation, Inc.', 'g++'), 'gcc');
  assert.equal(F.compilerKind('g++.exe (x86_64-posix-seh-rev1, Built by MinGW-Builds project) 15.2.0', 'g++'), 'gcc');
  assert.equal(F.compilerKind('Apple clang version 14.0.0 (clang-1400.0.29.202)', 'g++'), 'clang', 'macOS g++ is Clang');
  assert.equal(F.compilerKind('Ubuntu clang version 18.1.3', 'clang++-18'), 'clang');
  assert.equal(F.compilerKind('Intel(R) oneAPI DPC++/C++ Compiler 2025.0.0', 'icpx'), 'clang');
  assert.equal(F.compilerKind('', 'C:/VS/bin/cl.exe'), 'msvc');
  assert.equal(F.compilerKind('clang version 18 (Target: x86_64-pc-windows-msvc)', 'clang-cl.exe'), 'msvc');
  assert.equal(F.compilerKind('', '/opt/cross/bin/arm-none-eabi-g++'), 'gcc');
  assert.equal(F.compilerKind('tcc version 0.9.27', 'tcc'), 'unknown');
  assert.equal(F.targetOf(['-O2'], 'x86_64-linux-gnu'), 'x86_64-linux-gnu');
  assert.equal(F.targetOf(['--target=aarch64-linux-gnu'], 'x86_64-linux-gnu'), 'aarch64-linux-gnu');
  assert.equal(F.targetOf(['-target', 'riscv64'], 'x86_64-linux-gnu'), 'riscv64');
  for (const t of ['x86_64-pc-linux-gnu', 'i686-w64-mingw32', 'x86_64-apple-darwin23', 'x86_64-pc-windows-msvc', 'amd64-unknown-freebsd']) assert.equal(F.isX86(t), true, t);
  for (const t of ['arm64-apple-darwin23', 'aarch64-linux-gnu', 'riscv64-unknown-elf', 'avr', '']) assert.equal(F.isX86(t), false, t);
  assert.deepEqual(F.syntaxArgs('gcc', 'x86_64-linux-gnu'), ['-masm=intel']);
  assert.deepEqual(F.syntaxArgs('clang', 'x86_64-linux-gnu'), ['-mllvm', '-x86-asm-syntax=intel']);
  assert.deepEqual(F.syntaxArgs('clang', 'arm64-apple-darwin23'), [], 'no -masm for ARM (Apple clang rejects it)');
  assert.deepEqual(F.syntaxArgs('gcc', 'aarch64-linux-gnu'), []);
  assert.deepEqual(F.syntaxArgs('gcc', 'x86_64-linux-gnu', 'att'), []);
  assert.deepEqual(F.syntaxArgs('unknown', 'x86_64-linux-gnu'), []);
});

test('rejectedFlagsFrom: the messages of GCC, Clang, MSVC, cc65, Norcroft, getopt, clap and TI', () => {
  const cases = [
    ["g++: error: unrecognized command-line option '-masm=intel'", ['-masm=intel']],
    ['cc1plus: error: unrecognized command line option ‘-fno-such’', ['-fno-such']],
    ["clang: error: unknown argument: '-fno-such'", ['-fno-such']],
    ["clang: error: unsupported option '-masm=' for target 'arm64-apple-darwin23'", ['-masm=']],
    ["cl : Command line warning D9002 : ignoring unknown option '-masm=intel'", ['-masm=intel']],
    ['cc65: Unknown option: -O2', ['-O2']],
    ["Error: bad option '-O2': ignored", ['-O2']],
    ["compile: invalid option -- 'O'", ['-O']],
    ["error: Found argument '-O' which wasn't expected, or isn't valid in this context", ['-O']],
    ['>> WARNING: invalid compiler option --fancy (ignored)', ['--fancy']],
    ["<source>:3:5: error: 'x' was not declared in this scope", []],
    ['', []]
  ];
  for (const [err, expected] of cases) assert.deepEqual(F.rejectedFlagsFrom(err), expected, err);
});

test('removeFlags / removeArgs: exact options, option prefixes (-masm=), short options with values (-O2 for -O)', () => {
  assert.deepEqual(F.removeFlags('-O2 -masm=intel -DX', ['-masm=intel']), { flags: '-O2 -DX', removed: ['-masm=intel'] });
  assert.deepEqual(F.removeFlags('-O2 -masm=intel', ['-masm=']), { flags: '-O2', removed: ['-masm=intel'] });
  assert.deepEqual(F.removeFlags('-O2 -Os -g', ['-O']), { flags: '-g', removed: ['-O2', '-Os'] });
  assert.deepEqual(F.removeFlags('-O2 -Ifoo', ['-fno-such']), { flags: '-O2 -Ifoo', removed: [] });
  assert.deepEqual(F.removeFlags('-O2 -Ofast', ['-Ofast']), { flags: '-O2', removed: ['-Ofast'] });
  assert.deepEqual(F.removeArgs(['-O2', '-masm=intel', '-fdiagnostics-color=never'], ['-masm=']), { args: ['-O2', '-fdiagnostics-color=never'], removed: ['-masm=intel'] });
  assert.equal(F.matchesOption('-O', '-O'), true);
  assert.equal(F.matchesOption('-Wall', '-W'), true);
  assert.equal(F.matchesOption('-march=x', '-m'), true);
  assert.equal(F.matchesOption('-masm=intel', '-masm'), false);
});

test('splitCommand: POSIX shell quoting', () => {
  assert.deepEqual(F.splitCommand('/usr/bin/g++ -DNAME="a b" -I\'/x y\' -c a.cpp', false), ['/usr/bin/g++', '-DNAME=a b', '-I/x y', '-c', 'a.cpp']);
  assert.deepEqual(F.splitCommand('cc -DQ=\\"q\\" a\\ b.c', false), ['cc', '-DQ="q"', 'a b.c']);
  assert.deepEqual(F.splitCommand('cc "" -x', false), ['cc', '', '-x']);
  assert.deepEqual(F.splitCommand('  cc   -O2  ', false), ['cc', '-O2']);
});

test('splitCommand: Windows command lines (backslashes are path separators)', () => {
  assert.deepEqual(F.splitCommand('C:\\mingw64\\bin\\g++.exe -IC:\\proj\\inc -c C:\\proj\\a.cpp', true), ['C:\\mingw64\\bin\\g++.exe', '-IC:\\proj\\inc', '-c', 'C:\\proj\\a.cpp']);
  assert.deepEqual(F.splitCommand('"C:\\Program Files\\LLVM\\bin\\clang++.exe" "-DMSG=\\"hi\\"" -I"C:\\a b"', true), ['C:\\Program Files\\LLVM\\bin\\clang++.exe', '-DMSG="hi"', '-IC:\\a b']);
  assert.deepEqual(F.splitCommand('cc "x\\\\" y', true), ['cc', 'x\\', 'y']);
});

test('entryArgs: arguments or command; compiler launchers are skipped', () => {
  assert.deepEqual(F.entryArgs({ arguments: ['g++', '-c', 'a.cpp'] }), ['g++', '-c', 'a.cpp']);
  assert.deepEqual(F.entryArgs({ command: 'ccache g++ -c a.cpp' }, false), ['g++', '-c', 'a.cpp']);
  assert.deepEqual(F.entryArgs({ command: '/usr/bin/sccache /usr/bin/clang++ -O2 -c a.cpp' }, false), ['/usr/bin/clang++', '-O2', '-c', 'a.cpp']);
});

test('compileFlagsOf: removes -c, -o x, -M*, -Werror*, -x lang, the source file; keeps the rest in order', () => {
  const dir = path.resolve('/proj/build');
  const entry = {
    directory: dir,
    file: '../src/main.cpp',
    arguments: ['g++', '-DNDEBUG', '-I../include', '-isystem', '/opt/x', '-O2', '-std=c++20', '-Werror', '-Werror=return-type', '-Wall',
      '-MD', '-MT', 'main.o', '-MF', 'main.o.d', '-MMD', '-MP', '-MQ', 'q', '-MJ', 'j.json', '-x', 'c++',
      '-o', 'CMakeFiles/app.dir/main.cpp.o', '-c', '../src/main.cpp', '-fdiagnostics-color=always']
  };
  assert.deepEqual(F.compileFlagsOf(entry), ['-DNDEBUG', '-I../include', '-isystem', '/opt/x', '-O2', '-std=c++20', '-Wall']);
  assert.deepEqual(F.compileFlagsOf({ directory: dir, file: path.resolve('/proj/src/a.c'), command: 'gcc -oout.o -xc -c /proj/src/a.c -- ' }, false), []);
  assert.deepEqual(F.compileFlagsOf({ directory: dir, file: 'a.cpp', arguments: ['clang++', '-c', 'a.cpp', '@flags.rsp'] }), ['@flags.rsp']);
  assert.equal(F.entryCompiler({ directory: dir, arguments: ['../tools/g++', '-c', 'a.cpp'] }), path.resolve(dir, '../tools/g++'));
  assert.equal(F.entryCompiler({ directory: dir, arguments: ['g++', '-c', 'a.cpp'] }), 'g++');
});

test('isMsvcStyle: cl.exe and clang-cl on Compiler Explorer, by id or name', () => {
  for (const id of ['vcpp_v19_latest_x64', 'vcpp_v19_29_VS16_11_arm64', 'vc_v19_latest_x86', 'cl19_2015_u3_arm_exwine', 'ccl19_2015_u3_arm_exwine', 'cl_new_arm64_exwine', 'clang-cl2216', 'cclang-cl1810']) assert.equal(F.isMsvcStyle(id, ''), true, id);
  assert.equal(F.isMsvcStyle('anything', 'x64 msvc v19.latest'), true);
  assert.equal(F.isMsvcStyle('clang_cl_1900', 'x64 clang-cl 19.1'), true);
  for (const id of ['g152', 'clang2010', 'cclang2010', 'icx202500', 'armv8-clang1810', 'cl4302161', 'clad_trunk', 'vcs']) assert.equal(F.isMsvcStyle(id, id), false, id);
});

test('adaptFlags: GCC/Clang flags for MSVC (/EHsc added for C++), unknown ones kept, ones without an equivalent left out', () => {
  const m = (f, o) => F.adaptFlags(f, true, o).flags;
  assert.equal(m('-O2'), '/O2 /EHsc');
  assert.equal(m('-O3 -std=c++20 -Wall -DX=1 -Iinc'), '/O2 /std:c++20 /W4 -DX=1 -Iinc /EHsc');
  assert.equal(m('-O0 -std=gnu++17 -fno-exceptions -fno-rtti'), '/Od /std:c++17 /EHs-c- /GR-');
  assert.equal(m('-Os -std=c++23 -march=native -mtune=generic -g -m64 -Wextra -pedantic'), '/O1 /std:c++latest /EHsc');
  assert.equal(m('-Ofast -mavx2 -fopenmp'), '/O2 /fp:fast /arch:AVX2 /openmp /EHsc');
  assert.equal(m('-O2 -std=c11', { cxx: false }), '/O2 /std:c11', 'no /EHsc for C');
  assert.equal(m('/O2 /std:c++latest /EHsc /permissive-'), '/O2 /std:c++latest /EHsc /permissive-', 'MSVC flags are kept as written');
  assert.equal(m('-O2 -DMSG="a b"'), '/O2 "-DMSG=a b" /EHsc');
  assert.deepEqual(F.adaptFlags('-O3 -march=native', true).changes, ['-O3 -> /O2', '-march=native -> (left out)', 'added /EHsc (as Visual Studio does)']);
});

test('adaptFlags: MSVC flags for GCC/Clang; GCC flags and paths are never touched', () => {
  const g = f => F.adaptFlags(f, false);
  assert.deepEqual(g('-O2 -O1 -Os -O3 -MD -Wall -w -std=c++20 -DA'), { flags: '-O2 -O1 -Os -O3 -MD -Wall -w -std=c++20 -DA', changes: [] });
  assert.equal(g('/O2 /std:c++20 /W4 /EHsc /DFOO=1 /UBAR /permissive- -Zi /Zc:__cplusplus').flags, '-O2 -std=c++20 -Wall -DFOO=1 -UBAR');
  assert.equal(g('/Od /std:c++latest /GR- /EHs-c- /fp:fast /arch:AVX2').flags, '-O0 -std=c++2b -fno-rtti -fno-exceptions -ffast-math -mavx2');
  assert.equal(g('-I /Users/me/include /usr/include/x').flags, '-I /Users/me/include /usr/include/x');
  assert.deepEqual(F.adaptFlags('', false), { flags: '', changes: [] });
});

test('needsNewerStd: C++11 code compiled as C++98 by Apple clang 14 or old GCC', () => {
  assert.equal(F.needsNewerStd("<stdin>:22:3: warning: 'auto' type specifier is a C++11 extension [-Wc++11-extensions]\n<stdin>:22:13: error: expected expression"), true);
  assert.equal(F.needsNewerStd("a.cpp:3:12: error: 'v' was not declared\nnote: extended initializer lists only available with '-std=c++11' or '-std=gnu++11'"), true);
  assert.equal(F.needsNewerStd("a.cpp:1:5: error: use of undeclared identifier 'x'"), false);
});
