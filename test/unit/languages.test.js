const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../../src/languages');
const asm = require('../../src/asm');
const { fixture } = require('../helpers/env');

const guess = (lang, text) => L.guessFunctions(lang, text).map(f => `${f.name} ${f.startLine + 1}-${f.endLine + 1}`);

test('languageOf: VS Code ids, aliases and unsupported languages', () => {
  assert.equal(L.languageOf('cpp').family, 'c');
  assert.equal(L.languageOf('c').id, 'c');
  assert.equal(L.languageOf('objective-cpp').id, 'c++');
  assert.equal(L.languageOf('rust').id, 'rust');
  assert.equal(L.languageOf('FortranFreeForm').key, 'fortran');
  assert.equal(L.languageOf('fortran-modern').id, 'fortran');
  assert.equal(L.languageOf('javascript'), undefined);
  for (const id of L.LANGUAGE_IDS) assert.ok(L.languageOf(id), id);
});

test('pythonRows: functions from "Disassembly of" headers, module code first, opcodes only', () => {
  const rows = [
    { text: '  0           RESUME                   0', source: { line: 0, file: null } },
    { text: '  1           LOAD_CONST               0 (<code object sq at 0x1, file "example.py", line 1>)', source: { line: 1, file: null } },
    { text: '              MAKE_FUNCTION', source: { line: 1, file: null } },
    { text: '' },
    { text: 'Disassembly of <code object sq at 0x1, file "example.py", line 1>:', source: { line: null, file: null } },
    { text: '  1           RESUME                   0', source: { line: 1, file: null } },
    { text: '  2           LOAD_FAST_BORROW_LOAD_FAST_BORROW 0 (x, x)', source: { line: 2, file: null } },
    { text: '              BINARY_OP                5 (*)', source: { line: 2, file: null } },
    { text: '  --    >>    L1:  RETURN_VALUE', source: { line: null, file: null } },
    { text: 'ExceptionTable:' },
    { text: '  L1 to L2 -> L3 [0] lasti' }
  ];
  const out = L.pythonRows(rows);
  assert.deepEqual(out.map(r => r.text.trim()), ['<module>:', 'RESUME 0', 'LOAD_CONST 0 (<code object sq at 0x1, file "example.py", line 1>)', 'MAKE_FUNCTION', 'sq:', 'RESUME 0', 'LOAD_FAST_BORROW_LOAD_FAST_BORROW 0 (x, x)', 'BINARY_OP 5 (*)', 'RETURN_VALUE']);
  const fns = asm.parseFunctions(out, asm.makeRefResolver('M', []));
  assert.deepEqual(fns.map(f => [f.name, f.count]), [['<module>', 3], ['sq', 4]]);
});

test('goRows: TEXT starts a function, FUNCDATA/PCDATA dropped, pc labels become local', () => {
  const rows = [
    { text: '        TEXT    main.Square(SB), NOSPLIT|NOFRAME|ABIInternal, $0-8', source: { file: null, line: 3 } },
    { text: '        FUNCDATA        $0, gclocals·g5==(SB)', source: { file: null, line: 3 } },
    { text: '        IMULQ   AX, AX', source: { file: null, line: 4 } },
    { text: '        RET', source: { file: null, line: 4 } },
    { text: 'command-line-arguments_main_pc0:' },
    { text: '        TEXT    main.main(SB), ABIInternal, $16-0', source: { file: null, line: 7 } },
    { text: '        JLS     command-line-arguments_main_pc48', source: { file: null, line: 7 } },
    { text: 'command-line-arguments_main_pc48:' },
    { text: '        RET', source: { file: null, line: 9 } }
  ];
  const out = L.goRows(rows);
  const fns = asm.parseFunctions(out, asm.makeRefResolver('M', []));
  assert.deepEqual(fns.map(f => [f.name, f.count]), [['main.Square', 2], ['main.main', 2]]);
  assert.ok(out.some(r => r.text.includes('JLS     .Lcommand-line-arguments_main_pc48')));
});

test('goLocalRows: go build -gcflags=-S listing (Unix and Windows paths)', () => {
  const listing = [
    '# command-line-arguments',
    'command-line-arguments.Square STEXT size=16 args=0x8 locals=0x0 funcid=0x0 leaf',
    '\t0x0000 00000 (/tmp/x/geom.go:5)\tTEXT\tcommand-line-arguments.Square(SB), LEAF|NOFRAME|ABIInternal, $0-8',
    '\t0x0000 00000 (/tmp/x/geom.go:5)\tFUNCDATA\t$0, gclocals·g5==(SB)',
    '\t0x0000 00000 (/tmp/x/geom.go:6)\tMUL\tR0, R0, R0',
    '\t0x0004 00004 (C:\\Users\\u\\geom.go:6)\tRET\t(R30)',
    '\t0x0000 1b 00 00 9b c0 03 5f d6                          ......_.',
    '\trel 0+0 t=R_USEIFACE',
    'go:cuinfo.producer.geom SDWARFCUINFO dupok size=0',
    '\t0x0000 2d 4e 20 2d 6c                                   -N -l'
  ].join('\n');
  const rows = L.goLocalRows(listing, 'geom');
  assert.deepEqual(rows.map(r => r.text.trim()), ['geom.Square:', 'MUL R0, R0, R0', 'RET (R30)']);
  assert.deepEqual(rows[1].source, { file: '/tmp/x/geom.go', line: 6 });
  assert.deepEqual(rows[2].source, { file: 'C:\\Users\\u\\geom.go', line: 6 });
  assert.equal(L.goPackageName('// c\npackage geom\n'), 'geom');
  assert.equal(L.goPackageName('/* package x */\npackage   main // y\n'), 'main');
});

test('localCommand: command lines per language', () => {
  const py = L.localCommand('python', { file: '/p/a.py', out: '/t/o', flags: [], text: 'x=1' });
  assert.deepEqual([py.args[0], py.args[2], py.input, py.format], ['-c', '/p/a.py', 'x=1', 'python']);
  const rs = L.localCommand('rust', { file: '/p/my-lib.rs', out: '/t/o.s', flags: ['-O'] });
  assert.ok(rs.args.includes('--crate-name=my_lib') && rs.args.includes('--edition=2021') && rs.args.includes('--emit=asm=/t/o.s') && rs.args.includes('-O'));
  assert.ok(!L.localCommand('rust', { file: '/p/a.rs', out: 'o', flags: ['--edition=2018'] }).args.includes('--edition=2021'));
  const go = L.localCommand('go', { file: '/t/g.go', out: '/t/o', flags: ['-N', '-l'] });
  assert.deepEqual(go.args.slice(0, 2), ['build', '-gcflags=-S -N -l']);
  assert.ok(go.copy && go.uniqueSuffix && go.output === 'stderr');
  assert.equal(L.localCommand('swift', { file: '/p/9x.swift', out: 'o', flags: [] }).args.includes('_9x'), true);
  assert.ok(L.localCommand('zig', { file: 'a.zig', out: 'o', flags: [] }).cwdTemp);
  assert.deepEqual(L.localCommand('fortran', { file: 'a.f90', out: 'o', flags: ['-O2'] }).args, ['-S', '-g', '-O2', '-o', 'o', 'a.f90']);
  assert.equal(L.localCommand('d', { file: 'a.d', out: 'o', flags: [] }), undefined);
});

test('guessFunctions: Python (methods, async, decorators, multi-line signatures, docstrings, nested)', () => {
  assert.deepEqual(guess('python', fixture('languages', 'geom.py')), ['square 1-2', 'push 6-10', 'uses_lambda 13-14']);
  const src = [
    '@decorator',                    // 1
    'async def fetch(a,',            // 2
    '                b=(1, 2)):',    // 3
    '    """Doc',                    // 4
    'not code at column 0',          // 5
    '    """',                       // 6
    '    def inner(): return 1',     // 7
    '    return inner()',            // 8
    '',                              // 9
    '    # trailing comment',        // 10
    'x = 1',                         // 11
    'def one(): return 2'            // 12
  ].join('\n');
  assert.deepEqual(guess('python', src), ['fetch 2-8', 'inner 7-7', 'one 12-12']);
});

test('guessFunctions: Rust (lifetimes, trait declarations without bodies, raw strings, impl blocks)', () => {
  assert.deepEqual(guess('rust', fixture('languages', 'geom.rs')), ['square 1-3', 'longest 5-7', 'push 12-12']);
  const src = 'trait T {\n    fn decl(&self) -> u8;\n    fn with_body(&self) -> u8 { 1 }\n}\nfn raw() -> &\'static str { r#"} {"# }\nfn chr() -> char { \'{\' }\n';
  assert.deepEqual(guess('rust', src), ['with_body 3-3', 'raw 5-5', 'chr 6-6']);
});

test('guessFunctions: Go (receivers, func-typed parameters, generics, raw strings)', () => {
  assert.deepEqual(guess('go', fixture('languages', 'geom.go')), ['Square 5-7', 'Sum 9-9', 'Apply 11-11']);
  assert.deepEqual(guess('go', 'package m\nfunc Map[T any](xs []T) []T {\n\ts := `}`\n\t_ = s\n\treturn xs\n}\nfunc asm(x int) int\nfunc after() {}\n'), ['Map 2-6', 'after 8-8']);
});

test('guessFunctions: Swift, Zig, D, Fortran', () => {
  assert.deepEqual(guess('swift', fixture('languages', 'geom.swift')), ['square 1-3', 'push 7-7']);
  assert.deepEqual(guess('swift', 'struct S {\n  init(x: Int) { }\n  deinit { }\n  static func + (a: S, b: S) -> S { a }\n}\nprotocol P { func req() }\n'), ['init 2-2', 'deinit 3-3', '+ 4-4']);
  assert.deepEqual(guess('zig', fixture('languages', 'geom.zig')), ['square 1-3', 'add 5-7']);
  assert.deepEqual(guess('d', fixture('languages', 'geom.d')), ['square 1-3', 'add 5-5']);
  assert.deepEqual(guess('fortran', fixture('languages', 'geom.f90')), ['square 1-4', 'twice 6-9']);
  assert.deepEqual(guess('fortran', 'pure real(8) function f(x)\n  real(8) :: x\n  f = x\nend\n'), ['f 1-4']);
});

test('maskBraces: comments (nested in Rust/Swift), strings and literals keep their length', () => {
  const rust = 'a /* x /* { */ } */ "}" \'{\' \'a b';
  const m = L.maskBraces(rust, 'rust');
  assert.equal(m.length, rust.length);
  assert.ok(!m.includes('{') && !m.includes('}'), m);
  assert.ok(m.includes("'a b"), 'lifetimes are left alone');
  assert.ok(!L.maskBraces('x := `{`', 'go').includes('{'));
  assert.ok(!L.maskBraces('const s = \\\\ {', 'zig').includes('{'));
  assert.ok(!L.maskBraces('let s = """\n{\n"""', 'swift').includes('{'));
});

test('PYTHON_DIS is valid for the Python versions it targets', () => {
  assert.match(L.PYTHON_DIS, /get_instructions/);
  assert.match(L.PYTHON_DIS, /line_number/);
  assert.match(L.PYTHON_DIS, /starts_line/);
});
