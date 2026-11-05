const test = require('node:test');
const assert = require('node:assert/strict');
const scan = require('../../src/cppScan');
const { fixture } = require('../helpers/env');

const fns = text => scan.scanDefinitions(text).filter(d => d.kind === 'function');
const names = text => fns(text).map(d => d.name);

test('scanDefinitions: the header fixture (templates, static inline, inline, in-class methods)', () => {
  const defs = scan.scanDefinitions(fixture('headers', 'mathx.hxx'));
  const summary = defs.map(d => `${d.kind} ${d.name} ${d.startLine + 1}-${d.endLine + 1}${d.templated ? ' T' : ''} [${d.scopes.map(s => s.name).join('/')}]`);
  assert.deepEqual(summary, [
    'function square 4-5 T []',
    'function clamp_to 7-12 T []',
    'function add_ints 14-14 []',
    'function mul_ints 16-18 []',
    'function cube 21-21 T [mx]',
    'class Acc 23-27 [mx]',
    'function push 25-25 [mx/Acc]',
    'function get 26-26 [mx/Acc]',
    'class Box 29-33 T [mx]',
    'function twice 32-32 T [mx/Box]'
  ]);
});

test('scanDefinitions: one-line bodies, multi-line signatures and K&R-style brace placement', () => {
  assert.deepEqual(names('int a() { return 1; }\nint b(int x,\n      int y)\n{\n  return x + y;\n}\nvoid c(void){}\n'), ['a', 'b', 'c']);
  const b = fns('int a() { return 1; }\nint b(int x,\n      int y)\n{\n  return x + y;\n}\n')[1];
  assert.equal(b.startLine, 1);
  assert.equal(b.nameLine, 1);
  assert.equal(b.endLine, 5);
});

test('scanDefinitions: constructor initializer lists with braces belong to the head', () => {
  const src = 'struct S {\n  int a, b;\n  S() : a{1}, b{2} {}\n  S(int x) : a(x), b{x} { a++; }\n};\n';
  assert.deepEqual(names(src), ['S', 'S']);
  assert.deepEqual(fns(src).map(f => f.startLine), [2, 3]);
});

test('scanDefinitions: trailing return types with :: are not initializer lists', () => {
  assert.deepEqual(names('auto f() -> ns::T { return {}; }\nauto g(int x) -> decltype(x) { return x; }\n'), ['f', 'g']);
});

test('scanDefinitions: operators, conversion operators, destructors', () => {
  const src = [
    'struct V {',
    '  bool operator==(const V&) const { return true; }',
    '  int operator()(int x) const { return x; }',
    '  V& operator<<(int) { return *this; }',
    '  bool operator<(const V&) const { return false; }',
    '  explicit operator bool() const { return true; }',
    '  ~V() {}',
    '  void* operator new(unsigned long n) { return nullptr; }',
    '};',
    'V operator+(V a, V b) { return a; }'
  ].join('\n');
  assert.deepEqual(names(src), ['operator==', 'operator()', 'operator<<', 'operator<', 'operator bool', '~V', 'operator new', 'operator+']);
});

test('scanDefinitions: out-of-line members keep their qualification', () => {
  const src = 'struct Acc { int get() const; };\nint Acc::get() const { return 1; }\ntemplate <class T> struct Box { T get() const; };\ntemplate <class T>\nT Box<T>::get() const { return T(); }\nns::X::~X() {}\n';
  const f = fns(src);
  assert.deepEqual(f.map(x => x.name), ['Acc::get', 'Box<T>::get', 'ns::X::~X']);
  assert.equal(f[0].templated, false);
  assert.equal(f[1].templated, true);
});

test('scanDefinitions: namespaces (nested, inline, anonymous) and extern "C" blocks', () => {
  const src = 'namespace a::b { int f() { return 1; } }\ninline namespace v1 { int g() { return 2; } }\nnamespace { int h() { return 3; } }\nextern "C" {\nint c_fn(void) { return 4; }\n}\nextern "C" int c2(void) { return 5; }\n';
  const f = fns(src);
  assert.deepEqual(f.map(x => x.name), ['f', 'g', 'h', 'c_fn', 'c2']);
  assert.deepEqual(f[0].scopes.map(s => s.name), ['a::b']);
  assert.deepEqual(f[2].scopes.map(s => s.name), ['']);
  assert.deepEqual(f[3].scopes.map(s => s.kind), ['linkage']);
});

test('scanDefinitions: initializers, enums, lambdas and control blocks are not functions', () => {
  const src = [
    'auto lam = [](int x) { return x + 1; };',
    'int arr[] = { 1, 2, 3 };',
    'enum class E : int { A, B };',
    'std::vector<int> v = { 1, 2 };',
    'struct P { int x{5}; int y = {6}; };',
    'int real(int x) { if (x) { return 1; } for (;;) { break; } return 0; }'
  ].join('\n');
  assert.deepEqual(names(src), ['real']);
});

test('scanDefinitions: braces in comments, strings, raw strings and directives are ignored', () => {
  const src = [
    '// int fake() {',
    '/* void also_fake() { */',
    '#define OPEN {',
    '#if 0 /* { */',
    '#endif',
    'const char* s() { return "}{"; }',
    "char c() { return '{'; }",
    'const char* r() { return R"x( } { )x"; }',
    'int after() { return 1; }'
  ].join('\n');
  assert.deepEqual(names(src), ['s', 'c', 'r', 'after']);
});

test('scanDefinitions: access specifiers, attributes, noexcept, requires, function-pointer parameters', () => {
  const src = [
    'class K {',
    'public:',
    '  [[nodiscard]] int a() const noexcept { return 1; }',
    'private:',
    '  __attribute__((always_inline)) inline int b() noexcept(true) { return 2; }',
    'protected:',
    '  void reg(void (*cb)(int)) { cb(1); }',
    '};',
    'template <class T> requires (sizeof(T) > 1) T need(T x) { return x; }',
    'decltype(auto) dd(int& x) { return (x); }'
  ].join('\n');
  assert.deepEqual(names(src), ['a', 'b', 'reg', 'need', 'dd']);
});

test('scanDefinitions: templates, explicit specializations, abbreviated templates, nested classes', () => {
  const src = [
    'template <typename T, int N = 4, typename... Rest> T many(T x) { return x * N; }',
    'template <> int many<int>(int x) { return x; }',
    'void abbreviated(auto x) { (void)x; }',
    'template <class T> struct Outer { struct Inner { int f() { return 1; } }; };',
    'template <class T> struct Part<T*> { int g() { return 2; } };',
    'template <> struct Box<int> { int h() { return 3; } };'
  ].join('\n');
  const f = fns(src);
  assert.deepEqual(f.map(x => [x.name, x.templated, x.explicitSpecialization]), [
    ['many', true, false], ['many<int>', false, true], ['abbreviated', true, false], ['f', true, false], ['g', true, false], ['h', false, false]
  ]);
});

test('scanDefinitions: macros such as TEST(a, b) { } are marked macroLike; struct-returning functions are functions', () => {
  const f = fns('TEST(Suite, Name) { int x = 1; }\nstruct S make() { struct S s; return s; }\n');
  assert.deepEqual(f.map(x => [x.name, x.macroLike]), [['TEST', true], ['make', false]]);
});

test('scanDefinitions: CRLF line endings keep line numbers', () => {
  const f = fns('int a()\r\n{\r\n  return 1;\r\n}\r\nint b() { return 2; }\r\n');
  assert.deepEqual(f.map(x => [x.name, x.startLine, x.endLine]), [['a', 0, 3], ['b', 4, 4]]);
});

test('scanDefinitions: unbalanced input does not throw', () => {
  assert.doesNotThrow(() => scan.scanDefinitions('int f() {\n  if (x) {\n'));
  assert.doesNotThrow(() => scan.scanDefinitions('}}}} int g() { return 1; }'));
  assert.doesNotThrow(() => scan.scanDefinitions(''));
});

test('keepHeaderFunctions: marks non-template definitions only, on the same line', () => {
  const src = fixture('headers', 'mathx.hxx');
  const kept = scan.keepHeaderFunctions(src);
  assert.equal(kept.split('\n').length, src.split('\n').length);
  const marked = kept.split('\n').map((l, i) => l.includes('__attribute__((used))') ? i + 1 : 0).filter(Boolean);
  assert.deepEqual(marked, [14, 16, 25, 26]);
  assert.match(kept.split('\n')[13], /^__attribute__\(\(used\)\) static inline int add_ints/);
  assert.match(kept.split('\n')[24], /^ {2}__attribute__\(\(used\)\) void push/);
});

test('keepHeaderFunctions: placement after [[attributes]], extern "C" and template<>', () => {
  const kept = scan.keepHeaderFunctions([
    '[[nodiscard]] inline int a() { return 1; }',
    'extern "C" inline int b() { return 2; }',
    'template <class T> T t(T x) { return x; }',
    'template <> inline int t<int>(int x) { return x; }',
    'consteval int ce() { return 3; }',
    'TEST(A, B) { }'
  ].join('\n')).split('\n');
  assert.equal(kept[0], '[[nodiscard]] __attribute__((used)) inline int a() { return 1; }');
  assert.equal(kept[1], 'extern "C" __attribute__((used)) inline int b() { return 2; }');
  assert.equal(kept[2], 'template <class T> T t(T x) { return x; }');
  assert.equal(kept[3], 'template <> __attribute__((used)) inline int t<int>(int x) { return x; }');
  assert.equal(kept[4], 'consteval int ce() { return 3; }');
  assert.equal(kept[5], 'TEST(A, B) { }');
});

test('keepHeaderFunctions: earlier line-start rule still applies to lines the scanner skips, never twice', () => {
  const kept = scan.keepHeaderFunctions('static inline int decl(int);\nstatic inline int def(int x) { return x; }\ninline namespace v2 {}\n').split('\n');
  assert.equal(kept[0], '__attribute__((used)) static inline int decl(int);');
  assert.equal(kept[1], '__attribute__((used)) static inline int def(int x) { return x; }');
  assert.equal(kept[2], 'inline namespace v2 {}');
});

test('templateTargetAt: free function templates take the address of a specialization', () => {
  const src = fixture('headers', 'mathx.hxx');
  const sq = scan.templateTargetAt(src, 4);
  assert.equal(sq.label, 'square<T>');
  assert.deepEqual(sq.prompts, [{ name: 'square', params: 'typename T', suggestion: 'int' }]);
  assert.deepEqual(sq.make(['long']), { kind: 'address', expr: 'square<long>' });
  assert.deepEqual(scan.templateTargetAt(src, 20).make(['int']), { kind: 'address', expr: 'mx::cube<int>' });
  assert.equal(scan.templateTargetAt(src, 13), undefined, 'add_ints is not a template');
  assert.equal(scan.templateTargetAt(src, 0), undefined, 'line outside any function');
});

test('templateTargetAt: members of class templates instantiate the class', () => {
  const t = scan.templateTargetAt(fixture('headers', 'mathx.hxx'), 31);
  assert.equal(t.label, 'mx::Box<T>');
  assert.deepEqual(t.make(['std::pair<int, int>']), { kind: 'class', expr: 'mx::Box<std::pair<int, int>>', keyword: 'struct', member: 'mx::Box<std::pair<int, int>>::twice' });
});

test('templateTargetAt: member templates, nested classes, out-of-line definitions, anonymous namespaces', () => {
  const src = [
    'namespace ns {',                                                          // 1
    'struct Acc { template <class U> U conv() const { return U(); } };',       // 2
    'template <class T> class Box {',                                          // 3
    ' public:',                                                                // 4
    '  template <class U> U mix(U u) const { return u; }',                     // 5
    '  T get() const;',                                                        // 6
    '  struct Inner { int f() { return 1; } };',                               // 7
    '};',                                                                      // 8
    'template <class T> T Box<T>::get() const { return T(); }',                // 9
    'namespace { template <class T> T hidden(T x) { return x; } }',            // 10
    '}'                                                                        // 11
  ].join('\n');
  assert.deepEqual(scan.templateTargetAt(src, 1).make(['long']), { kind: 'address', expr: 'ns::Acc::conv<long>' });
  const mix = scan.templateTargetAt(src, 4);
  assert.deepEqual(mix.prompts.map(p => p.name), ['Box', 'mix']);
  assert.deepEqual(mix.make(['int', 'double']), { kind: 'address', expr: 'ns::Box<int>::mix<double>' });
  assert.deepEqual(scan.templateTargetAt(src, 6).make(['int']), { kind: 'class', expr: 'ns::Box<int>::Inner', keyword: 'struct', member: 'ns::Box<int>::Inner::f' });
  assert.deepEqual(scan.templateTargetAt(src, 8).make(['char']), { kind: 'class', expr: 'ns::Box<char>', keyword: 'class', member: 'ns::Box<char>::get' });
  assert.deepEqual(scan.templateTargetAt(src, 9).make(['int']), { kind: 'address', expr: 'ns::hidden<int>' });
});

test('templateTargetAt: template constructors are reported as unsupported; abbreviated templates prompt for auto', () => {
  const src = 'struct W { template <class U> W(U u) {} };\nint use(auto x) { return 0; }\n';
  assert.match(scan.templateTargetAt(src, 0).unsupported, /Constructors/);
  const ab = scan.templateTargetAt(src, 1);
  assert.deepEqual(ab.prompts, [{ name: 'use', params: 'auto', suggestion: 'int' }]);
  assert.deepEqual(ab.make(['short']), { kind: 'address', expr: 'use<short>' });
});

test('defaultTemplateArgs: types, values, defaults, packs, template templates, concepts', () => {
  assert.equal(scan.defaultTemplateArgs('typename T'), 'int');
  assert.equal(scan.defaultTemplateArgs('class A, class B'), 'int, int');
  assert.equal(scan.defaultTemplateArgs('typename T, int N'), 'int, 1');
  assert.equal(scan.defaultTemplateArgs('bool B, std::size_t N'), 'true, 1');
  assert.equal(scan.defaultTemplateArgs('typename T, typename U = int'), 'int');
  assert.equal(scan.defaultTemplateArgs('typename... Ts'), 'int');
  assert.equal(scan.defaultTemplateArgs('template <class> class C'), 'std::vector');
  assert.equal(scan.defaultTemplateArgs('std::integral T'), 'int');
  assert.equal(scan.defaultTemplateArgs('typename T = std::map<int, int>'), '');
});

test('appendInstantiations: requests go after the last line, one per line', () => {
  const list = [{ kind: 'address', expr: 'f<int>' }, { kind: 'class', expr: 'ns::B<int>', keyword: 'struct' }];
  const a = scan.appendInstantiations('line0\nline1', list);
  assert.equal(a.firstLine, 2);
  assert.deepEqual(a.text.split('\n'), ['line0', 'line1', 'auto __asm_lens_inst_0 = &f<int>;', 'template struct ns::B<int>;', '']);
  const b = scan.appendInstantiations('line0\n', list);
  assert.equal(b.firstLine, 1);
  assert.equal(b.text.split('\n')[1], 'auto __asm_lens_inst_0 = &f<int>;');
  assert.deepEqual(scan.appendInstantiations('x', []), { text: 'x', firstLine: -1 });
});

test('maskCode: comments, strings, char literals, raw strings and directives become spaces', () => {
  const src = 'int a; // c {\n/* b { */ const char* s = "x{";\n#define M {\\\n }\nchar c = \'{\'; auto r = R"d({)d";\n';
  const { text, directiveEnds } = scan.maskCode(src);
  assert.equal(text.length, src.length);
  assert.equal(text.split('\n').length, src.split('\n').length);
  assert.ok(!text.includes('{'), text);
  assert.equal(directiveEnds.length, 1);
});

test('blankEnclosingDeclaration: blanks the function around a line, keeping line numbers', () => {
  const src = 'int ok() { return 1; }\n\nint bad() {\n  return missing();\n}\nint later() { return 2; }\n';
  const cut = scan.blankEnclosingDeclaration(src, 3);
  assert.equal(cut.name, 'bad');
  assert.equal(cut.startLine, 2);
  assert.equal(cut.endLine, 4);
  assert.equal(cut.text.split('\n').length, src.split('\n').length);
  assert.ok(cut.text.includes('int ok()') && cut.text.includes('int later()') && !cut.text.includes('missing'));
  const decl = scan.blankEnclosingDeclaration('int x = undefined_y;\nint z;\n', 0);
  assert.equal(decl.name, undefined);
  assert.ok(!decl.text.includes('undefined_y'));
  assert.equal(scan.blankEnclosingDeclaration('int z;\n', 5), undefined);
});

test('splitQualified and splitTemplatePrefixes', () => {
  assert.deepEqual(scan.splitQualified('ns::Box<std::pair<int, int>>::get'), ['ns', 'Box<std::pair<int, int>>', 'get']);
  assert.deepEqual(scan.splitQualified('operator<<'), ['operator<<']);
  assert.deepEqual(scan.splitQualified('A::operator<'), ['A', 'operator<']);
  const t = scan.splitTemplatePrefixes('template <class T = std::vector<int>> template <int N = (1 > 0)> void f()');
  assert.deepEqual(t.params, ['class T = std::vector<int>', 'int N = (1 > 0)']);
});

test('scanDefinitions: namespaces and classes opened after statement macros (json.hpp style)', () => {
  const src = [
    'NLOHMANN_JSON_NAMESPACE_BEGIN',
    'namespace detail {',
    'inline int a() { return 1; }',
    '}',
    'NLOHMANN_JSON_NAMESPACE_END NLOHMANN_JSON_NAMESPACE_BEGIN namespace detail2 {',
    'inline int b() { return 2; }',
    '}',
    'TPL_DECLARATION class basic { int get() const { return 3; } };'
  ].join('\n');
  const f = fns(src);
  assert.deepEqual(f.map(x => [x.name, x.scopes.map(s => s.name).join('/')]), [['a', 'detail'], ['b', 'detail2'], ['get', 'basic']]);
  assert.equal(f[2].scopes[0].maybeTemplate, true, 'the macro may be template<...>');
});

test('scanDefinitions: braces inside unclosed parentheses are expressions, not bodies', () => {
  const src = 'template <typename T>\nauto f(const T& j)\n-> decltype(g(j, tag<3> {}), void())\n{\n  return g(j, tag<3> {});\n}\nint after() { return 1; }\n';
  assert.deepEqual(fns(src).map(x => [x.name, x.startLine, x.endLine]), [['f', 0, 5], ['after', 6, 6]]);
});

test('keepHeaderFunctions: marks go after macros; a type in capitals is no reason to leave a function out; classes behind a macro are', () => {
  const kept = scan.keepHeaderFunctions([
    'DOCTEST_NORETURN void a() { throw 1; }',
    'FMT_API inline int b() { return 2; }',
    'DOCTEST_APPROX_PREFIX operator==(const T& l, const A& r) { return true; }',
    'TPL_DECLARATION class basic { int m() const { return 3; } };',
    'BOOL WINAPI c() { return 0; }'
  ].join('\n')).split('\n');
  assert.equal(kept[0], 'DOCTEST_NORETURN __attribute__((used)) void a() { throw 1; }');
  assert.equal(kept[1], 'FMT_API __attribute__((used)) inline int b() { return 2; }');
  assert.equal(kept[2], '__attribute__((used)) DOCTEST_APPROX_PREFIX operator==(const T& l, const A& r) { return true; }', 'if it does not fit, the compiler says so and only this function loses it');
  assert.equal(kept[3], 'TPL_DECLARATION class basic { int m() const { return 3; } };');
  assert.equal(kept[4], 'BOOL __attribute__((used)) WINAPI c() { return 0; }');
});

test('scanDefinitions: long runs of macro-like words do not slow it down (no catastrophic backtracking)', () => {
  const caps = Array.from({ length: 400 }, (_, i) => `MACRO_NUMBER_${i}_WITH_A_LONG_NAME`).join(' ');
  const src = `${caps} x\n${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(40)} int f() { return 1; }\nDOCTEST_RELATIONAL_OP(eq, ==)\nDOCTEST_RELATIONAL_OP(ne, !=)\n${'A_B_C_D_E_F_G_H '.repeat(200)}( int g() { return 2; }\n`;
  const t0 = Date.now();
  scan.scanDefinitions(src);
  scan.keepHeaderFunctions(src);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

// ---------------------------------------------------------------------------
// 0.8.0: functions defined in classes (and other droppable ones) in .cpp files

const CLASSES = [
  'class Counter {',                                              // 1
  'public:',                                                      // 2
  '  void add(int x) { total += x; }',                             // 3
  '  static int helper(int v) { return v + 1; }',                  // 4
  '  int outOfLine(int k) const;',                                 // 5
  '  friend bool operator==(const Counter&, const Counter&) { return true; }', // 6
  '  Counter() = default;',                                        // 7
  '  explicit Counter(int t) : total(t) {}',                       // 8
  '  ~Counter() {}',                                               // 9
  'private:',                                                     // 10
  '  int secret() const { return total; }',                        // 11
  '  int total = 0;',                                              // 12
  '};',                                                           // 13
  'int Counter::outOfLine(int k) const { return total * k; }',    // 14
  'static int file_local(int x) { return x; }',                   // 15
  'inline int inl(int x) { return x; }',                          // 16
  'constexpr int cx(int x) { return x; }',                        // 17
  'int external(int x) { return x; }',                            // 18
  'namespace { int anon(int x) { return x; } }',                  // 19
  'template <class T> struct Box { T get() const { return T(); } };', // 20
  'static int count = 0;',                                        // 21
  'int main() { auto l = [](int a) { return a; }; return l(1); }' // 22
].join('\n');

test('keepable / { all: false }: in-class, static, inline, constexpr and anonymous-namespace functions; not main, templates or external ones', () => {
  const kept = scan.keepHeaderFunctions(CLASSES, { all: false }).split('\n');
  const marked = kept.map((l, i) => l.includes('__attribute__((used))') ? i + 1 : 0).filter(Boolean);
  assert.deepEqual(marked, [3, 4, 6, 8, 9, 11, 15, 16, 17, 19]);
  assert.equal(kept[2], '  __attribute__((used)) void add(int x) { total += x; }');
  assert.equal(kept[13], CLASSES.split('\n')[13], 'an out-of-line member is always emitted: left alone');
  assert.equal(kept[17], CLASSES.split('\n')[17], 'an external function is always emitted: left alone');
  assert.equal(kept[20], 'static int count = 0;', 'variables are not marked in a .cpp file');
  assert.equal(kept[21], CLASSES.split('\n')[21], 'main is never marked');
  assert.equal(kept.length, CLASSES.split('\n').length);
  // In a header everything is kept, the earlier line-start rule included.
  const header = scan.keepHeaderFunctions(CLASSES).split('\n');
  assert.ok(header[13].includes('__attribute__((used))') && header[17].includes('__attribute__((used))'));
  assert.ok(!header[21].includes('__attribute__((used))'), 'main is not marked in a header either');
});

test('keepByAddress / { all: false }: qualified names for members; constructors and destructors through a call; friends, main and templates are left out', () => {
  assert.deepEqual(scan.keepByAddress(CLASSES, { all: false }), [
    '#include <new>',
    'auto __asm_lens_keep_0 = &Counter::add;',
    'auto __asm_lens_keep_1 = &Counter::helper;',
    'void __asm_lens_keep_2(void* __asm_lens_at, int t) { ::new (__asm_lens_at) Counter(t); }',
    'void __asm_lens_keep_3(Counter* __asm_lens_at) { __asm_lens_at->~Counter(); }',
    'auto __asm_lens_keep_4 = &Counter::secret;',
    'auto __asm_lens_keep_5 = &file_local;',
    'auto __asm_lens_keep_6 = &inl;',
    'auto __asm_lens_keep_7 = &cx;',
    'auto __asm_lens_keep_8 = &anon;'
  ]);
  assert.ok(scan.keepByAddress('int main() { return 0; }\nint wmain() { return 0; }\n').length === 0);
  assert.ok(scan.keepByAddress(CLASSES).some(l => /&outOfLine|&Counter::outOfLine/.test(l)), 'a header keeps out-of-line members too');
});

test('templateTargetAt: a partial specialization is instantiated in its own form; constructors have no member to fall back to', () => {
  const src = [
    'template <class T, int N> struct Buf<T*, N> {',  // 1
    '  T at(T* p) const { return p[N]; }',            // 2
    '};',                                             // 3
    'template <class T> struct Plain {',              // 4
    '  Plain() { }',                                  // 5
    '  ~Plain() { }',                                 // 6
    '  T get() const { return T(); }',                // 7
    '};'
  ].join('\n');
  const buf = scan.templateTargetAt(src, 1);
  assert.equal(buf.label, 'Buf<T*, N>');
  assert.deepEqual(buf.make(['int, 4']), { kind: 'class', expr: 'Buf<int*, 4>', keyword: 'struct', member: 'Buf<int*, 4>::at' });
  assert.equal(scan.templateTargetAt(src, 4).make(['int']).member, undefined);
  assert.equal(scan.templateTargetAt(src, 5).make(['int']).member, undefined);
  assert.equal(scan.templateTargetAt(src, 6).make(['int']).member, 'Plain<int>::get');
});

test('blankEnclosingDeclaration: attributes are not taken for the function name', () => {
  for (const text of ['__attribute__((used)) static inline int f(int a) { return a; }\n', 'static inline __attribute__((always_inline)) int f(int a) { return a; }\n', '[[nodiscard]] inline int f(int a) { return a; }\n']) {
    assert.equal(scan.blankEnclosingDeclaration(text, 0).name, 'f', text);
  }
});

// ---------------------------------------------------------------------------
// 0.8.4: requires clauses, friends, overloads, templates compiled without being asked

test('scanDefinitions: a class template with a requires clause is a template', () => {
  const src = [
    'template <class T> requires (sizeof(T) >= 1)',
    'struct A { T a() const { return T{}; } };',
    'template <class T> requires C<T> && D<T> struct B { T b() const { return T{}; } };',
    'template <class T> requires requires(T x) { x + x; } struct E { T e() const { return T{}; } };',
    'template <class T> struct F { T f() const requires C<T> { return T{}; } };',
    'template <class T> requires C<T> T g(T x) { return x; }',
    'decltype(auto) after(int& x) { return (x); }'
  ].join('\n');
  const fns = scan.scanDefinitions(src).filter(d => d.kind === 'function');
  assert.deepEqual(fns.map(d => d.name), ['a', 'b', 'e', 'f', 'g', 'after']);
  assert.deepEqual(fns.map(d => d.templated), [true, true, true, true, true, false]);
  assert.equal(scan.templateTargetAt(src, 1).make(['int']).expr, 'A<int>');
  assert.equal(scan.templateTargetAt(src, 2).make(['int']).expr, 'B<int>');
});

test('scanDefinitions: `struct NAME final` is called NAME, a macro in front is not', () => {
  const classes = src => scan.scanDefinitions(src).filter(d => d.kind === 'class').map(d => d.name);
  assert.deepEqual(classes('template <class T> struct F16 final { T f() { return T{}; } };'), ['F16']);
  assert.deepEqual(classes('struct ABC final : Base { };'), ['ABC']);
  assert.deepEqual(classes('struct EXPORT_API Mine final { };'), ['Mine']);
  assert.deepEqual(classes('struct ABC : Base { };'), ['ABC']);
});

test('keepByAddress: overloads are cast to their type, in their namespace; a call is not an overload', () => {
  const lines = scan.keepByAddress([
    'static inline int over(int x) { return x; }',
    'static inline float over(float x = 1.0f) { return x; }',
    'namespace ns { struct Foo {}; static inline int inner(Foo f) { return 1; } static inline int inner(int a, Foo f) { return 2; } }',
    'struct C { int m(int) const { return 1; } int m(float) { return 2; } static int s(int) { return 3; } static int s(float) { return 4; } };',
    'int plain(int x) { return x; }',
    'int caller() { plain(1); return plain(2); }'
  ].join('\n'));
  assert.deepEqual(lines, [
    'auto __asm_lens_keep_0 = static_cast<int (*)(int x)>(&over);',
    'auto __asm_lens_keep_1 = static_cast<float (*)(float x)>(&over);',
    'namespace ns { auto __asm_lens_keep_2 = static_cast<int (*)(Foo f)>(&inner); }',
    'namespace ns { auto __asm_lens_keep_3 = static_cast<int (*)(int a, Foo f)>(&inner); }',
    'auto __asm_lens_keep_4 = static_cast<int (C::*)(int) const>(&C::m);',
    'auto __asm_lens_keep_5 = static_cast<int (C::*)(float)>(&C::m);',
    'auto __asm_lens_keep_6 = static_cast<int (*)(int)>(&C::s);',
    'auto __asm_lens_keep_7 = static_cast<int (*)(float)>(&C::s);',
    'auto __asm_lens_keep_8 = &plain;',
    'auto __asm_lens_keep_9 = &caller;'
  ]);
});

test('keepByAddress: a prototype next to the definition is an overload too', () => {
  assert.deepEqual(scan.keepByAddress('int f(int);\ninline int f(float x) { return 1; }\n'), ['auto __asm_lens_keep_0 = static_cast<int (*)(float x)>(&f);']);
});

test('templateTargetAt: an overloaded function template is selected by its type', () => {
  const src = 'template <class T> T pick(T a) { return a; }\ntemplate <class T> T pick(T a, T b) { return b; }\n';
  assert.deepEqual(scan.templateTargetAt(src, 1).make(['int']), { kind: 'address', expr: 'pick<int>', cast: 'int (*)(int a, int b)' });
  // The plain form first: explicit arguments often leave one overload, and the cast is copied from the source.
  const { text, lines } = scan.appendInstantiations('', [scan.templateTargetAt(src, 0).make(['long'])]);
  assert.equal(text.trim(), 'auto __asm_lens_inst_0 = &pick<long>;');
  assert.equal(lines[0].fallback, 'auto __asm_lens_inst_0 = static_cast<long (*)(long a)>(&pick<long>);');
});

test('templateUsesIn: arguments where a template is used, not inside templates or template heads', () => {
  const src = [
    'template <class T> struct Box { Box<T> self() { return *this; } };',
    'template <> struct Box<char> { };',
    'template <class T> Box<T> make(T x) { Box<T> b; return b; }',
    'Box<int> a;',
    'ns::Box<std::pair<int, long>> b;',
    'Box<int> c;',
    '// Box<float> in a comment',
    'int n = sizeof(Box<double>);',
    'bool lt = OtherBox < 3;'
  ].join('\n');
  assert.deepEqual(scan.templateUsesIn(src, 'Box'), ['int', 'std::pair<int, long>', 'double']);
});

test('autoInstantiations: the types used, else suggested ones; what was asked for wins; nested classes once', () => {
  const header = [
    'template <class T> struct Box { T get() const { return T{}; } struct In { T i() { return T{}; } }; };',
    'template <class T> struct Box<T*> { T* p() const { return nullptr; } };',
    'template <class T, int N> struct Arr { T a() const { return T{}; } };',
    'template <class T> T twice(T x) { return x + x; }',
    'namespace ns { template <class T> struct Q { T q() const { return T{}; } }; }'
  ].join('\n');
  const exprs = o => scan.autoInstantiations(header, o).map(it => it.expr);
  assert.deepEqual(exprs({}), ['Box<int>', 'Box<int*>', 'Arr<int, 1>', 'twice<int>', 'ns::Q<int>'], 'Box<int>::In comes with Box<int>');
  assert.deepEqual(exprs({ contexts: ['Box<float> f;\nBox<long> g;\nArr<char, 8> h;\nns::Q<short> q;\nauto z = twice<double>(1);\n'] }),
    ['Box<float>', 'Box<long>', 'Box<int*>', 'Arr<char, 8>', 'twice<double>', 'ns::Q<short>']);
  assert.deepEqual(exprs({ manual: [{ kind: 'class', expr: 'Box<char>' }] }), ['Arr<int, 1>', 'twice<int>', 'ns::Q<int>'], 'requests of its own: that template is left alone');
  assert.equal(exprs({ max: 2 }).length, 2);
  assert.deepEqual(exprs({ rejected: new Set(['Box<int>', 'twice<int>']) }), ['Box<int>', 'Box<int*>', 'Arr<int, 1>', 'ns::Q<int>'], 'a function template known not to compile is left out; a class stays, since its members may');
  assert.deepEqual(scan.autoInstantiations(header, { manual: [{ kind: 'address', expr: 'Arr<int, 1>::a' }] }).map(it => it.expr).includes('Arr<int, 1>'), false, 'its class does not compile as a whole');
  assert.ok(scan.autoInstantiations(header, { manual: [{ kind: 'address', expr: 'Box<int>::conv<float>' }] }).some(it => it.expr === 'Box<int>'), 'a member template asked for says nothing about the class');
  const written = 'template <class T> struct W { T w() const { return T{}; } };\ntemplate struct W<int>;\nextern template struct W<char>;\nW<char> c;\n';
  assert.deepEqual(scan.autoInstantiations(written).map(it => it.expr), ['W<char>'], 'a second explicit instantiation of W<int> would be an error; extern template asks for one');
});

test('friendUseLines: a friend of a class template is called with its arguments', () => {
  const src = [
    '#include <ostream>',
    'namespace ns {',
    'template <class T, int N> struct Box {',
    '  friend Box operator-(const Box& a, const Box&) { return a; }',
    '  friend std::ostream& operator<<(std::ostream& os, const Box<T, N>& c) { return os; }',
    '  friend T peek(const Box& b, T d = T{}) { return d; }',
    '  friend void none() { }',
    '};',
    '}'
  ].join('\n');
  assert.deepEqual(scan.friendUseLines(src, [{ kind: 'class', expr: 'ns::Box<int, 3>' }]), [
    'namespace ns { decltype(auto) __asm_lens_use_0(const Box<int, 3>& a, const Box<int, 3>& __asm_lens_p1) { return operator-(a, __asm_lens_p1); } }',
    'namespace ns { decltype(auto) __asm_lens_use_1(std::ostream& os, const Box<int, 3>& c) { return operator<<(os, c); } }',
    'namespace ns { decltype(auto) __asm_lens_use_2(const Box<int, 3>& b, int d) { return peek(b, d); } }'
  ]);
  assert.deepEqual(scan.friendUseLines(src, [{ kind: 'address', expr: 'ns::Box<int, 3>::x' }]), []);
});

test('conditionAt: the condition around a line; an include guard does not count', () => {
  const src = ['#ifndef G_H', '#define G_H', 'int a;', '#ifdef X // why', 'int b;', '#else', 'int c;', '#endif', '#if defined(Y)', '#  if Z', 'int d;', '#  endif', 'int e;', '#endif', 'int f;', '#endif'].join('\n');
  const at = l => scan.conditionAt(src, l - 1);
  assert.equal(at(3), undefined);
  assert.equal(at(5), '#ifdef X');
  assert.equal(at(7), '#else');
  assert.equal(at(11), '# if Z');
  assert.equal(at(13), '#if defined(Y)');
  assert.equal(at(15), undefined);
  assert.equal(scan.conditionAt('/*\n#ifdef NO\n*/\nint a;\n', 3), undefined, 'in a comment');
});

test('includeContext: the preprocessor lines before an #include, closed, through other headers', async () => {
  const cpp = ['#pragma once', '#define A 1', 'int code_is_left_out;', '#ifdef A', '#include <vector>', '#define MULTI \\', '  2', '#include "sub/x.hxx"', '#endif', '#define AFTER'].join('\n');
  assert.deepEqual(await scan.includeContext(cpp, 'x.hxx', { dir: '/p' }), {
    text: ['#define A 1', '#ifdef A', '#include <vector>', '#define MULTI \\\n  2', '#endif'].join('\n'),
    dirs: ['/p'], after: []
  });
  assert.deepEqual((await scan.includeContext('#include "x.hxx"\n#include "types.h"\n#ifdef Q\n#include "off.h"\n#endif\nusing namespace app;\nint f();\n', 'x.hxx', { dir: '/p' })).after, ['#include "types.h"', 'using namespace app;'], 'what the types it is used with need');
  assert.equal(await scan.includeContext(cpp, 'y.hxx', { dir: '/p' }), undefined);
  const follow = async (name, dir) => (name === 'mid.h' ? { text: '#define M\n#include "x.hxx"\n', dir: `${dir}/inc` } : undefined);
  assert.deepEqual(await scan.includeContext('#define T\n#include "other.h"\n#include "mid.h"\n', 'x.hxx', { follow, dir: '/p' }), {
    text: ['#define T', '#include "other.h"', '#define M'].join('\n'),
    dirs: ['/p', '/p/inc'], after: []
  });
});

// ---------------------------------------------------------------------------
// 0.8.5: every function a compiler could emit is found and kept

test('scanDefinitions: macros after the parameters, and a macro call in front', () => {
  const src = [
    'static inline int a(int x) NOEXC { return x; }',
    'static inline int b(int x) __THROW { return x; }',
    'static inline int c(int x) ATTR(1, 2) NOEXC { return x; }',
    'struct S { int d(int x) const NOEXC { return x; } };',
    'static inline EXPORT(int) e(int x) { return x; }',
    'S(int x) noexcept(true) { }',
    'int f(int x) API(noexcept) { return x; }',
    'FOO(a) { }'
  ].join('\n');
  assert.deepEqual(scan.scanDefinitions(src).filter(d => d.kind === 'function').map(d => d.name), ['a', 'b', 'c', 'd', 'e', 'S', 'f', 'FOO']);
});

test('keepHeaderFunctions: functions returning a type in capitals are kept, in a .cpp too', () => {
  const src = 'static inline U32 a(U32 x) { return x; }\nINLINE BOOL b(int x) { return x; }\nstruct S { BOOL c() const { return 1; } };\n';
  const kept = scan.keepHeaderFunctions(src, { all: false }).split('\n');
  assert.equal(kept[0], '__attribute__((used)) static inline U32 a(U32 x) { return x; }');
  assert.equal(kept[1], 'INLINE __attribute__((used)) BOOL b(int x) { return x; }');
  assert.equal(kept[2], 'struct S { __attribute__((used)) BOOL c() const { return 1; } };');
});

test('callLines: free functions, namespaces, static and const members; constructors and main are left out', () => {
  const defs = scan.scanDefinitions([
    'extern inline int a(int x, int) { return x; }',
    'namespace ns { inline void b() { } }',
    'struct S { static int c(int x) { return x; } int d() const { return 1; } int e(float f = 1.0f) { return 2; } S() { } ~S() { } };',
    'int main() { return 0; }',
    'inline int g(int (*cb)(int)) { return cb(1); }'
  ].join('\n')).filter(d => d.kind === 'function');
  assert.deepEqual([...scan.callLines(defs)], [
    'decltype(auto) __asm_lens_call_0(int x, int __asm_lens_p1) { return a(x, __asm_lens_p1); }',
    'namespace ns { decltype(auto) __asm_lens_call_1() { return b(); } }',
    'decltype(auto) __asm_lens_call_2(int x) { return S::c(x); }',
    'decltype(auto) __asm_lens_call_3(const S& __asm_lens_self) { return __asm_lens_self.d(); }',
    'decltype(auto) __asm_lens_call_4(S& __asm_lens_self, float f) { return __asm_lens_self.e(f); }'
  ]);
  assert.deepEqual(scan.callLines(defs).targets.map(d => d.name), ['a', 'b', 'c', 'd', 'e'], 'which function each line calls');
  assert.deepEqual([...scan.callLines(scan.scanDefinitions('extern inline int h(int x) { return x; }\nextern inline void i(void) { }\n').filter(d => d.kind === 'function'), { c: true })], [
    'int __asm_lens_call_0(int x) { return h(x); }',
    'void __asm_lens_call_1(void) { return i(); }'
  ]);
});

test('scanDefinitions: what follows code the preprocessor splits, digit separators and macro lines is still found', () => {
  const names = src => scan.scanDefinitions(src).filter(d => d.kind === 'function').map(d => d.name);
  assert.deepEqual(names('static inline int f(int x) {\n#ifdef FAST\n  if (x) {\n#else\n  if (x > 1) {\n#endif\n    return 1;\n  }\n  return 0;\n}\nstatic inline int after(int x) { return x; }\n'), ['f', 'after'], 'braces');
  assert.deepEqual(names('#ifdef A\nstatic inline int f(int x) {\n#else\nstatic inline int f(long x) {\n#endif\n  return 1;\n}\nstatic inline int after(int x) { return x; }\n'), ['f', 'after'], 'signature');
  assert.deepEqual(names('#ifdef _WIN32\nstatic inline int w(int x) { return x; }\n#else\nstatic inline int p(int x) { return x; }\n#endif\nstatic inline int after(int x) { return x; }\n'), ['w', 'p', 'after'], 'complete branches all stay');
  assert.deepEqual(names('#if 0\nstatic inline int dead(int x) {\n#endif\nstatic inline int after(int x) { return x; }\n'), ['after'], '#if 0 with half a function');
  assert.deepEqual(names('#ifdef __cplusplus\nextern "C" {\n#endif\nstatic inline int f(int x) { return x; }\n#ifdef __cplusplus\n}\n#endif\nstatic inline int after(int x) { return x; }\n'), ['f', 'after'], 'extern "C" guards');
  assert.deepEqual(names("static inline int f(int x) { int k = 1'000'000; if (x) { return k; } return 0; }\nstatic inline int after(int x) { return x; }\n"), ['f', 'after'], 'digit separators');
  assert.deepEqual(names("static inline char f() { char c = '{'; return c; }\nstatic inline wchar_t g() { return L'}'; }\nstatic inline int after(int x) { return x; }\n"), ['f', 'g', 'after'], 'characters are still characters');
  assert.deepEqual(names('DECLARE_THING(foo)\nstatic inline int f(int x) { return x; }\nREGISTER(foo, bar)\nint g(int x) { return x; }\n'), ['f', 'g'], 'macro lines');
  assert.deepEqual(names('class C {\n  DISALLOW_COPY(C)\n  int b() { return 2; }\npublic:\n  Q_DECLARE(x)\n  C(int x)\n    : v(x) { }\n  C()\n  {\n  }\n};\n'), ['b', 'C', 'C'], 'in a class; constructors stay constructors');
  assert.deepEqual(names('TEST(a, b)\n{\n}\nFoo::Foo(int x)\n  noexcept\n{\n}\n'), ['TEST', 'Foo::Foo'], 'not a macro line: the function itself');
  const marks = scan.keepHeaderFunctions('static inline int f(int x) {\n#ifdef FAST\n  if (x) {\n#else\n  if (x > 1) {\n#endif\n    return 1;\n  }\n  return 0;\n}\nstruct S { int m() const { return 1; } };\n', { all: false });
  assert.equal((marks.match(/__attribute__\(\(used\)\)/g) || []).length, 2, 'and they are kept');
});

test('includesForTypes: what a chosen type needs', () => {
  const lines = it => scan.includesForTypes([{ expr: it }]);
  assert.deepEqual(lines('count<std::vector<int>>'), ['#include <vector>']);
  assert.deepEqual(lines('Box<std::array<int, 3>>'), ['#include <array>']);
  assert.deepEqual(lines('Box<std::map<std::string, int>>'), ['#include <map>', '#include <string>']);
  assert.deepEqual(lines('Box<uint32_t>'), ['#include <cstdint>']);
  assert.deepEqual(lines('Box<size_t>'), ['#include <cstddef>']);
  assert.deepEqual(lines('Box<int>'), []);
});

test('autoInstantiations: a member template of a class whose types were chosen uses those types', () => {
  const src = 'template <class T> struct Box { T get() const { return T{}; } template <class U> U conv() const { return U{}; } };\n';
  assert.deepEqual(scan.autoInstantiations(src, { manual: [{ kind: 'class', expr: 'Box<float>' }] }).map(it => it.expr), ['Box<float>::conv<int>']);
});

test('appendInstantiations: lines the requests need come before them, and requests start after those', () => {
  const r = scan.appendInstantiations('int a;\n', [{ kind: 'class', expr: 'B<int>' }], [], ['#include <x>']);
  assert.equal(r.text, 'int a;\n#include <x>\ntemplate class B<int>;\n');
  assert.equal(r.firstLine, 2);
});

// ---------------------------------------------------------------------------
// 0.8.7: the plainest form that keeps what worked

const REQUEST_SOURCE = [
  'namespace ns {',
  'template <typename T> struct Box {',
  '  Box() : v() { }',
  '  explicit Box(T value) : v(value) { }',
  '  ~Box() { }',
  '  T get() const { return v; }',
  '  static T make() { return T{}; }',
  '  T& at(int) { return v; }',
  '  const T& at(int) const { return v; }',
  '  operator T() const { return v; }',
  '  T outside(T a) const;',
  '  template <typename U> U conv() const { return U{}; }',
  '  friend T peek(const Box& b) { return b.v; }',
  '  struct In { T i() const { return T{}; } };',
  '  T v;',
  '};',
  'template <typename T> T Box<T>::outside(T a) const { return a; }',
  '}'
].join('\n');

test('instantiationLines: what compiles as a whole today is still exactly one `template struct` line', () => {
  const lines = scan.instantiationLines([{ kind: 'class', expr: 'ns::Box<S>', keyword: 'struct', member: 'ns::Box<S>::get' }], { text: REQUEST_SOURCE });
  assert.deepEqual(lines.map(l => l.text), ['template struct ns::Box<S>;']);
  assert.deepEqual(scan.appendInstantiations('x', [{ kind: 'address', expr: 'f<int>' }, { kind: 'class', expr: 'B<int>', keyword: 'struct' }]).text, 'x\nauto __asm_lens_inst_0 = &f<int>;\ntemplate struct B<int>;\n');
});

test('instantiationLines: when the class does not compile as a whole, a plain line per member', () => {
  const [whole] = scan.instantiationLines([{ kind: 'class', expr: 'ns::Box<S>', keyword: 'struct', member: 'ns::Box<S>::get' }], { text: REQUEST_SOURCE });
  assert.deepEqual(whole.members.map(m => m.text), [
    'namespace ns { void __asm_lens_inst_0_0(void* __asm_lens_at) { ::new (__asm_lens_at) ns::Box<S>(); } }',
    'namespace ns { void __asm_lens_inst_0_1(void* __asm_lens_at, S value) { ::new (__asm_lens_at) ns::Box<S>(value); } }',
    'namespace ns { void __asm_lens_inst_0_2(ns::Box<S>* __asm_lens_at) { __asm_lens_at->~Box(); } }',
    'auto __asm_lens_inst_0_3 = &ns::Box<S>::get;',
    'auto __asm_lens_inst_0_4 = &ns::Box<S>::make;',
    'namespace ns { auto __asm_lens_inst_0_5 = static_cast<S& (ns::Box<S>::*)(int)>(&ns::Box<S>::at); }',
    'namespace ns { auto __asm_lens_inst_0_6 = static_cast<const S& (ns::Box<S>::*)(int) const>(&ns::Box<S>::at); }',
    'auto __asm_lens_inst_0_7 = &ns::Box<S>::operator S;',
    'auto __asm_lens_inst_0_8 = &ns::Box<S>::In::i;',
    'auto __asm_lens_inst_0_9 = &ns::Box<S>::outside;'
  ], 'not conv (a template itself) and not peek (a friend)');
  assert.match(whole.members[3].ifPrivate, /^template <auto P> struct __asm_lens_rob_0_3 \{ static inline auto kept = P; \}; template struct __asm_lens_rob_0_3<&ns::Box<S>::get>;$/);
  // Known not to compile as a whole: no compile wasted on it by an automatic analysis.
  const again = scan.instantiationLines([{ kind: 'class', expr: 'ns::Box<S>', keyword: 'struct' }], { text: REQUEST_SOURCE, rejected: new Set(['ns::Box<S>', 'ns::Box<S>::get']) });
  assert.equal(again[0].text, '#include <new>');
  assert.ok(!again.some(l => /template struct|::get\b/.test(l.text)));
  assert.deepEqual(scan.instantiationLines([{ kind: 'class', expr: 'Other<int>' }], { text: REQUEST_SOURCE }).map(l => l.text), ['template class Other<int>;'], 'no members known: only the class');
});

test('instantiationLines: requests saved by older versions keep their meaning', () => {
  const lines = scan.instantiationLines([
    { kind: 'address', expr: 'f<int>' },
    { kind: 'address', expr: 'g<int>', cast: 'int (*)(int)' },
    { kind: 'class', expr: 'C<int>' },
    { kind: 'class', expr: 'D<int>', keyword: 'struct' },
    { kind: 'class', expr: 'E<int>', keyword: 'union', member: 'E<int>::m' },
    { kind: 'address', expr: 'Mixed<int>::get' }
  ], { text: '' });
  assert.deepEqual(lines.map(l => l.text), ['auto __asm_lens_inst_0 = &f<int>;', 'auto __asm_lens_inst_1 = &g<int>;', 'template class C<int>;', 'template struct D<int>;', 'template union E<int>;', 'auto __asm_lens_inst_5 = &Mixed<int>::get;']);
  assert.equal(lines[1].fallback, 'auto __asm_lens_inst_1 = static_cast<int (*)(int)>(&g<int>);');
});

test('templateTargetAt: what is saved for a request has not changed', () => {
  const src = 'template <class T> struct B { T p() const { return T{}; } };\ntemplate <class T> struct B<T*> { T* q() const { return nullptr; } };\ntemplate <class T> T f(T x) { return x; }\n';
  assert.deepEqual(scan.templateTargetAt(src, 0).make(['int']), { kind: 'class', expr: 'B<int>', keyword: 'struct', member: 'B<int>::p' });
  assert.deepEqual(scan.templateTargetAt(src, 1).make(['int']), { kind: 'class', expr: 'B<int*>', keyword: 'struct', member: 'B<int*>::q' });
  assert.deepEqual(scan.templateTargetAt(src, 2).make(['int']), { kind: 'address', expr: 'f<int>' });
});
