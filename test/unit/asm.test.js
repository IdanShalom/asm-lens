const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const asm = require('../../src/asm');

const range = (a, b) => ({ start: { line: a }, end: { line: b } });
const sym = (name, a, b) => ({ name, range: range(a, b) });

test('normalizeName: C++ demangled names', () => {
  const cases = {
    'int square<int>(int)': 'square',
    'std::vector<int, std::allocator<int> > mk<int>(int)': 'mk',
    'ns::Foo<int>::bar<std::string>(std::vector<int> const&) const': 'bar',
    'mx::Acc::push(int)': 'push',
    'greet[abi:cxx11]()': 'greet',
    '(anonymous namespace)::anon()': 'anon',
    'foo(int) [clone .constprop.0]': 'foo',
    'foo()::{lambda(int)#1}::operator()(int) const': 'operator()',
    'S::operator==(S) const': 'operator==',
    'S::operator bool() const': 'operatorbool',
    'operator new[](unsigned long)': 'operatornew[]',
    'Foo::~Foo()': '~Foo',
    'S::~S() [base object destructor]': '~S',
    'sq_int(int)': 'sq_int',
    'main': 'main',
    'foo.part.0': 'foo',
    'square(T x)': 'square',
    'square<T>': 'square',
    'Acc::push': 'push',
    '': ''
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(asm.normalizeName(input), expected, input);
});

test('normalizeName: MSVC-mangled names (Clang for Windows/MSVC)', () => {
  const cases = {
    '?push@Acc@mx@@QEAAXH@Z': 'push',
    '??$square@H@@YAHH@Z': 'square',
    '?twice@?$Box@N@mx@@QEBANXZ': 'twice',
    '??0Acc@mx@@QEAA@XZ': 'Acc',
    '??1Acc@mx@@QEAA@XZ': '~Acc',
    '??8S@@QEBA_NU0@@Z': 'operator==',
    '??R<lambda_1>@@QEBAHH@Z': 'operator()',
    '?main@@YAHXZ': 'main',
    '"??$square@H@@YAHH@Z"': 'square',
    '"?push@Acc@mx@@QEAAXH@Z"': 'push'
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(asm.normalizeName(input), expected, input);
});

test('normalizeName: other languages', () => {
  const cases = {
    'example::generic::<i64>': 'generic',
    '<i64 as core::ops::arith::Add>::add': 'add',
    'example::square::h0123456789abcdef': 'square',
    'example::f::{{closure}}': 'lambda',
    'main.(*P).Sum': 'Sum',
    'command-line-arguments.Square': 'Square',
    'output.square(Swift.Int) -> Swift.Int': 'square',
    '$s4geom6squareyS2iF': 'square',
    '$s4geom3AccV4pushyySiF': 'push',
    '_$s4geom6squareyS2iF': 'square',
    'square(_:)': 'square',
    'int example.square(int)': 'square',
    '"square_"': 'square_',
    'f.<locals>.<lambda>': '<lambda>',
    '<module>': '<module>',
    'A.m': 'm'
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(asm.normalizeName(input), expected, input);
});

test('parseFunctions: Compiler Explorer rows with source metadata', () => {
  const rows = [
    { text: 'sq(int):' },
    { text: '        imul    edi, edi', source: { file: null, line: 3, column: 10 } },
    { text: '        mov     eax, edi', source: { file: 'asm_lens/h.hpp', line: 5 } },
    { text: '        ret', source: { file: null, line: 3 } },
    { text: '.LC0:' },
    { text: '        .long   5' },
    { text: 'other():' },
    { text: '# %bb.0:' },
    { text: '        xor     eax, eax', source: { file: null, line: 7 } },
    { text: '        ret', source: { file: null, line: 7 } }
  ];
  const resolve = asm.makeRefResolver(asm.normPath('/w/a.cpp'), [{ virtual: 'asm_lens/h.hpp', real: '/w/h.hpp' }]);
  const fns = asm.parseFunctions(rows, resolve);
  assert.deepEqual(fns.map(f => [f.name, f.count]), [['sq(int)', 3], ['other()', 2]]);
  assert.deepEqual(fns[0].instructionRows.map(r => r.ref && [r.ref.key, r.ref.line, r.ref.column]), [
    [asm.normPath('/w/a.cpp'), 2, 9], [asm.normPath('/w/h.hpp'), 4, undefined], [asm.normPath('/w/a.cpp'), 2, undefined]
  ]);
  assert.deepEqual([...fns[0].fileKeys].sort(), [asm.normPath('/w/a.cpp'), asm.normPath('/w/h.hpp')].sort());
});

test('parseFunctions: falls back to .file/.loc directives when rows carry no metadata', () => {
  const rows = ['f():', '\t.file 1 "/src" "a.c"', '\t.loc 1 4 3', '\tmov eax, 1', '\t.loc 1 5 1', '\tret'].map(text => ({ text }));
  const fns = asm.parseFunctions(rows, asm.makeLocalRefResolver('/src/a.c', '/src'));
  assert.deepEqual(fns[0].instructionRows.map(r => r.ref.line), [3, 4]);
});

test('looksLikeFunctionLabel / isInstructionLine', () => {
  for (const l of ['main', '_Z3fooi', 'ns::f(int)', '"square_"', '<module>', '?f@@YAXXZ']) assert.equal(asm.looksLikeFunctionLabel(l), true, l);
  for (const l of ['.L2', '.LBB0_1', 'LBB0_1', 'Ltmp3', '$LN5', '# %bb.0', '; %bb.0', '// x']) assert.equal(asm.looksLikeFunctionLabel(l), false, l);
  assert.equal(asm.looksLikeFunctionLabel('$s4geom6squareyS2iF'), true);
  assert.equal(asm.looksLikeFunctionLabel('$L12'), false);
  for (const l of ['mov eax, 1', 'ret', 'b.le .L2', 'LOAD_FAST x', 'IMULQ AX, AX', 'vpaddd ymm0, ymm1, ymm2']) assert.equal(asm.isInstructionLine(l), true, l);
  for (const l of ['.loc 1 2', '# comment', 'label:', '.L2:', 'section .text', '']) assert.equal(asm.isInstructionLine(l), false, l);
});

test('localAsmToRows: ELF output from GCC (sections, .file/.loc, debug sections dropped)', () => {
  const s = [
    '\t.file\t"<stdin>"',
    '\t.text',
    '.Ltext0:',
    '\t.file 0 "/home/u/p" "<stdin>"',
    '\t.section\t.text.startup,"ax",@progbits',
    '\t.globl\tmain',
    '\t.type\tmain, @function',
    'main:',
    '.LFB0:',
    '\t.file 1 "<stdin>"',
    '\t.loc 1 3 12 view -0',
    '\t.cfi_startproc',
    '\txorl\t%eax, %eax',
    '\t.loc 1 3 25',
    '\tret',
    '\t.section\t.text._Z1fIiET_S0_,"axG",@progbits,_Z1fIiET_S0_,comdat',
    '_Z1fIiET_S0_:',
    '\t.file 2 "inc/h.hpp"',
    '\t.loc 2 7 3',
    '\tleal\t(%rdi,%rdi), %eax',
    '\t.section\t.rodata',
    'table:',
    '\t.long 1',
    '\t.section\t.debug_info,"",@progbits',
    '.Ldebug_info0:',
    '\t.long\t0x99',
    'not_code_label:',
    '\t.text',
    'back_in_text:',
    '\tnop'
  ].join('\n');
  const rows = asm.localAsmToRows(s, '/home/u/p');
  assert.deepEqual(rows.map(r => r.text.trim()), ['.Ltext0:', 'main:', 'xorl\t%eax, %eax', 'ret', '_Z1fIiET_S0_:', 'leal\t(%rdi,%rdi), %eax', 'back_in_text:', 'nop']);
  assert.equal(rows[2].source.file, '<stdin>');
  assert.equal(rows[2].source.line, 3);
  assert.equal(rows[5].source.file, 'inc/h.hpp');
});

test('localAsmToRows: Mach-O output from Apple Clang (underscores, L labels, ; comments)', () => {
  const raw = [
    '\t.section\t__TEXT,__text,regular,pure_instructions',
    '\t.build_version macos, 12, 0',
    '\t.globl\t__Z6sq_inti                     ; -- Begin function _Z6sq_inti',
    '__Z6sq_inti:                            ; @_Z6sq_inti',
    'Lfunc_begin0:',
    '\t.file\t1 "/Users/u/p" "<stdin>"',
    '\t.loc\t1 3 0',
    '; %bb.0:',
    '\tmul\tw0, w0, w0',
    'Ltmp0:',
    '\tret',
    '_c_function:',
    '\tret',
    '\t.section\t__DWARF,__debug_info,regular,debug',
    'Lsection_info:',
    '\t.long 5',
    '\t.section\t__TEXT,__cstring,cstring_literals',
    'l_.str:',
    '\t.asciz "x"',
    '\t.subsections_via_symbols'
  ].join('\n');
  assert.equal(asm.isMachO(raw), true);
  const prepared = asm.prepareMachO(raw);
  assert.match(prepared, /^__Z6sq_inti:/m, 'C++ names keep the underscore for c++filt');
  assert.match(prepared, /^c_function:/m);
  assert.match(prepared, /^\.Lfunc_begin0:/m);
  assert.equal(asm.finishMachO('__Z6sq_inti:\n'), '_Z6sq_inti:\n');
  const rows = asm.localAsmToRows(asm.finishMachO(prepared), '/Users/u/p');
  assert.deepEqual(rows.map(r => r.text.trim()), ['_Z6sq_inti:', '.Lfunc_begin0:', 'mul\tw0, w0, w0', 'ret', 'c_function:', 'ret']);
  const fns = asm.parseFunctions(rows, asm.makeLocalRefResolver(asm.normPath('/Users/u/p/a.cpp'), '/Users/u/p'));
  assert.deepEqual(fns.map(f => [f.name, f.count]), [['_Z6sq_inti', 2], ['c_function', 1]]);
  assert.equal(fns[0].instructionRows[0].ref.key, asm.normPath('/Users/u/p/a.cpp'), '"<dir>/<stdin>" is the analyzed file');
  assert.equal(asm.isMachO('\t.text\nmain:\n'), false);
});

test('localAsmToRows: COFF output from MinGW (.def blocks, .text$ sections, escaped Windows paths)', () => {
  const raw = [
    '\t.file\t"<stdin>"',
    '\t.text',
    '\t.def\t_Z3addii;\t.scl\t2;\t.type\t32;\t.endef',
    '_Z3addii:',
    '.LFB0:',
    '\t.file 1 "C:\\\\work\\\\proj\\\\<stdin>"',
    '\t.loc 1 2 1',
    '\tleal\t(%rcx,%rdx), %eax',
    '\tret',
    '\t.section\t.text$_Z6squareIiET_S0_,"x"',
    '\t.linkonce discard',
    '_Z6squareIiET_S0_:',
    '\t.file 2 "C:\\\\work\\\\proj\\\\m.hxx"',
    '\t.loc 2 5 3',
    '\timull\t%ecx, %ecx',
    '\t.section\t.rdata,"dr"',
    '.LC0:',
    '\t.ascii "x\\0"',
    '\t.section\t.debug_info,"dr"',
    '\t.long 1'
  ].join('\n');
  const rows = asm.localAsmToRows(raw, 'C:\\work\\proj');
  assert.deepEqual(rows.map(r => r.text.trim()), ['_Z3addii:', 'leal\t(%rcx,%rdx), %eax', 'ret', '_Z6squareIiET_S0_:', 'imull\t%ecx, %ecx']);
  assert.equal(rows[4].source.file, 'C:\\work\\proj\\m.hxx');
  assert.equal(rows[1].source.file, 'C:\\work\\proj\\<stdin>');
});

test('localAsmToRows: CodeView line info (.cv_file/.cv_loc) from Clang on Windows', () => {
  const raw = '\t.text\n\t.cv_file\t1 "C:\\\\p\\\\a.cpp" "ABCD" 1\nf:\n\t.cv_func_id 0\n\t.cv_loc\t0 1 4 0\n\tret\n';
  const rows = asm.localAsmToRows(raw, 'C:\\p');
  assert.deepEqual(rows.map(r => [r.text.trim(), r.source && r.source.line]), [['f:', undefined], ['ret', 4]]);
  assert.equal(rows[1].source.file, 'C:\\p\\a.cpp');
});

test('sectionKind and unescapeAsmString', () => {
  const kinds = {
    '.text': true, '.data': false, '.bss': false, '.section .text.unlikely,"ax",@progbits': true, '.section .rodata.str1.1,"aMS",@progbits,1': false,
    '.section .debug_line,"",@progbits': false, '.section .text$mn,"xr"': true, '.section .rdata,"dr"': false, '.section __TEXT,__text,regular,pure_instructions': true,
    '.section __TEXT,__cstring,cstring_literals': false, '.section __TEXT,__text_startup,regular,pure_instructions': true, '.section __TEXT,__text_cold,regular,pure_instructions': true, '.section __TEXT,__const': false, '.section __DWARF,__debug_info,regular,debug': false, '.section .mytext,"ax"': true,
    '.data_region jt32': undefined, '.p2align 4': undefined, '.cstring': false
  };
  for (const [t, k] of Object.entries(kinds)) assert.equal(asm.sectionKind(t), k, t);
  assert.equal(asm.unescapeAsmString('C:\\\\a\\\\b.h'), 'C:\\a\\b.h');
  assert.equal(asm.unescapeAsmString('caf\\303\\251'), 'caf\u00c3\u00a9');
  assert.equal(asm.unescapeAsmString('q\\"x'), 'q"x');
});

test('makeLocalRefResolver: stdin, temporary copies, symlinked folders, system headers', () => {
  const main = asm.normPath('/w/p/a.cpp');
  const r = asm.makeLocalRefResolver(main, '/w/p', ['/tmp/x/a.cpp'], [['/private/w', '/w']]);
  const at = (file, line = 2) => r({ source: { file, line } });
  assert.deepEqual(at('<stdin>'), { key: main, line: 1, column: undefined });
  assert.equal(at('/w/p/<stdin>').key, main);
  assert.equal(at('-').key, main);
  assert.equal(at('/tmp/x/a.cpp').key, main);
  assert.equal(at('inc/h.hpp').key, asm.normPath('/w/p/inc/h.hpp'));
  assert.equal(at('/private/w/p/inc/h.hpp').key, asm.normPath('/w/p/inc/h.hpp'), 'symlink-resolved folder maps back');
  assert.equal(at('/usr/include/c++/13/bits/vector.tcc'), undefined);
  assert.equal(at('/opt/homebrew/include/x.h'), undefined);
  assert.equal(at('C:/msys64/ucrt64/include/stdio.h'), undefined);
  assert.equal(at('<built-in>'), undefined);
  assert.equal(r({ source: { file: 'a', line: 0 } }), undefined);
  assert.equal(r({}), undefined);
});

test('makeRefResolver: Compiler Explorer files map to uploaded headers, longest virtual path first', () => {
  const r = asm.makeRefResolver('MAIN', [{ virtual: 'asm_lens/h.hpp', real: '/w/h.hpp' }, { virtual: 'asm_lens/sub/h.hpp', real: '/w/sub/h.hpp' }]);
  assert.equal(r({ source: 4 }).key, 'MAIN');
  assert.equal(r({ source: { file: null, line: 3 } }).key, 'MAIN');
  assert.equal(r({ source: { file: 'example.cpp', line: 3, mainsource: true } }).key, 'MAIN');
  assert.equal(r({ source: { file: '/app/asm_lens/sub/h.hpp', line: 3 } }).key, asm.normPath('/w/sub/h.hpp'));
  assert.equal(r({ source: { file: 'asm_lens/h.hpp', line: 3 } }).key, asm.normPath('/w/h.hpp'));
  assert.equal(r({ source: { file: '/usr/include/stdio.h', line: 3 } }), undefined);
  assert.equal(r({ source: { file: '<source>', line: 3 } }).key, 'MAIN');
});

test('matchSourceSymbol: location first, then name; requireName for exact-name languages', () => {
  const fn = (name, lines, key = 'D') => ({ name, instructionRows: lines.map(line => ({ ref: { key, line } })) });
  const symbols = [sym('a', 0, 3), sym('b', 5, 9), sym('A', 20, 30), sym('m', 22, 25)];
  assert.equal(asm.matchSourceSymbol('whatever', symbols, fn('whatever', [6, 7, 1]), 'D').name, 'b');
  assert.equal(asm.matchSourceSymbol('m', symbols, fn('m', [22, 23, 24]), 'D').name, 'm', 'innermost wins on equal hits');
  assert.equal(asm.matchSourceSymbol('h', symbols, fn('h', [2], 'OTHER'), 'D'), undefined, 'code only from other files');
  assert.equal(asm.matchSourceSymbol('b(int)', symbols, fn('b(int)', []), 'D').name, 'b', 'no rows: by name');
  assert.equal(asm.matchSourceSymbol('A', symbols, fn('A', [20, 22]), 'D', { requireName: true }).name, 'A');
  assert.equal(asm.matchSourceSymbol('A', [sym('m', 22, 25)], fn('A', [20, 22]), 'D', { requireName: true }), undefined);
});

test('findAllFunctionResults: headers match by name and by the lines the code comes from', () => {
  const f = (name, key, lines, sourceRange) => ({ name, sourceName: name, fileKeys: new Set([key]), sourceRange, instructionRows: lines.map(line => ({ ref: { key, line } })), count: lines.length });
  const functions = [
    f('int square<int>(int)', 'H', [4, 4]),
    f('double square<double>(double)', 'H', [4]),
    f('square(float)', 'H', [20]),
    { ...f('cube_int(int)', 'H', [9], range(0, 2)), fileKeys: new Set(['H', 'ROOT']) }
  ];
  const sq = asm.findAllFunctionResults(sym('square', 3, 5), functions, 'H', 'ROOT');
  assert.deepEqual(sq.map(x => x.name), ['int square<int>(int)', 'double square<double>(double)']);
  assert.deepEqual(asm.findAllFunctionResults(sym('square', 19, 21), functions, 'H', 'ROOT').map(x => x.name), ['square(float)']);
  assert.deepEqual(asm.findAllFunctionResults(sym('cube', 8, 10), functions, 'H', 'ROOT'), [], 'cube is not cube_int');
  const root = asm.findAllFunctionResults(sym('cube_int', 0, 2), functions, 'ROOT', 'ROOT');
  assert.deepEqual(root.map(x => x.name), ['cube_int(int)']);
});

test('findFunctionResult: compiler-made variants match, other functions with a longer name do not', () => {
  const functions = [{ name: 'foo$1', sourceName: 'foo$1', fileKeys: new Set() }, { name: 'cube_int', sourceName: 'cube_int', fileKeys: new Set() }];
  assert.equal(asm.findFunctionResult({ name: 'foo' }, functions).name, 'foo$1');
  assert.equal(asm.findFunctionResult({ name: 'cube' }, functions), undefined);
});

test('missingIncludesFrom: GCC, Clang and MSVC messages', () => {
  const err = [
    'a.cpp:1:10: fatal error: gen/config.h: No such file or directory',
    "b.cpp:2:10: fatal error: 'other.h' file not found",
    "c.cpp(3): fatal error C1083: Cannot open include file: 'win.h': No such file or directory"
  ].join('\n');
  assert.deepEqual(asm.missingIncludesFrom(err).sort(), ['gen/config.h', 'other.h', 'win.h']);
});

test('errorLocationsFrom: GCC/Clang and MSVC formats, Windows drive letters, messages', () => {
  const err = [
    '<source>:12:5: error: use of undeclared identifier \'x\'',
    'C:\\p\\h.hpp:7:1: fatal error: oops',
    '<source>(40): error C2065: \'y\': undeclared identifier',
    '<source>:3:1: warning: not an error',
    'example.cpp:9: error: old style'
  ].join('\n');
  assert.deepEqual(asm.errorLocationsFrom(err), [
    { file: '<source>', line: 11, message: "use of undeclared identifier 'x'" },
    { file: 'C:\\p\\h.hpp', line: 6, message: 'oops' },
    { file: 'example.cpp', line: 8, message: 'old style' },
    { file: '<source>', line: 39, message: "'y': undeclared identifier" }
  ]);
});

test('preprocessorErrorFilesFrom and stubFilename', () => {
  assert.deepEqual(asm.preprocessorErrorFilesFrom('asm_lens/x.h:3:2: error: #error "need FOO"\n<source>:1:1: error: other'), ['asm_lens/x.h']);
  assert.equal(asm.stubFilename('sub/x.h'), 'sub/x.h');
  assert.equal(asm.stubFilename('sub\\x.h'), 'sub/x.h');
  assert.equal(asm.stubFilename('../x.h'), undefined);
  assert.equal(asm.stubFilename('/abs/x.h'), undefined);
});

test('cleanAssemblyRowsForDisplay: instructions plus only the local labels that are jumped to', () => {
  const result = { rows: ['f():', '.L2:', '\tjmp .L3', '.L3:', '\tret\t# done', '.L9:', '\t.cfi_endproc'].map(text => ({ text })) };
  assert.deepEqual(asm.cleanAssemblyRowsForDisplay(result).map(r => r.text), ['jmp .L3', '.L3:', 'ret']);
});

test('normPath is case-insensitive only on Windows', () => {
  const p = path.resolve('/Some/Path.H');
  assert.equal(asm.normPath(p), process.platform === 'win32' ? p.toLowerCase() : p);
});

test('parseFunctions: Swift on Linux without a demangler (mangled $s labels are functions, $L labels are not)', () => {
  const rows = [
    'main:', '.Lfunc_begin0:', '\txorl\t%eax, %eax', '\tretq',
    '$s4geom6squareyS2iF:', '.Lfunc_begin1:', '\timulq\t%rdi, %rdi', '\tjo\t.LBB1_2', '\tretq', '.LBB1_2:', '\tud2',
    '$s4geom3AccV4pushyySiF:', '\taddq\t(%r13), %rdi', '\tretq', '$L5:', '\tnop'
  ].map(text => ({ text }));
  const fns = asm.parseFunctions(rows, () => undefined);
  assert.deepEqual(fns.map(f => [f.name, f.count, asm.normalizeName(f.name)]), [
    ['main', 2, 'main'], ['$s4geom6squareyS2iF', 4, 'square'], ['$s4geom3AccV4pushyySiF', 3, 'push']
  ]);
});
