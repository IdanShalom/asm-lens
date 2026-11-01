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
  assert.deepEqual(t.make(['std::pair<int, int>']), { kind: 'class', expr: 'mx::Box<std::pair<int, int>>', keyword: 'struct' });
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
  assert.deepEqual(scan.templateTargetAt(src, 6).make(['int']), { kind: 'class', expr: 'ns::Box<int>::Inner', keyword: 'struct' });
  assert.deepEqual(scan.templateTargetAt(src, 8).make(['char']), { kind: 'class', expr: 'ns::Box<char>', keyword: 'class' });
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

test('keepHeaderFunctions: marks go after macros; functions behind unknown macros only are left alone', () => {
  const kept = scan.keepHeaderFunctions([
    'DOCTEST_NORETURN void a() { throw 1; }',
    'FMT_API inline int b() { return 2; }',
    'DOCTEST_APPROX_PREFIX operator==(const T& l, const A& r) { return true; }',
    'TPL_DECLARATION class basic { int m() const { return 3; } };',
    'BOOL WINAPI c() { return 0; }'
  ].join('\n')).split('\n');
  assert.equal(kept[0], 'DOCTEST_NORETURN __attribute__((used)) void a() { throw 1; }');
  assert.equal(kept[1], 'FMT_API __attribute__((used)) inline int b() { return 2; }');
  assert.equal(kept[2], 'DOCTEST_APPROX_PREFIX operator==(const T& l, const A& r) { return true; }');
  assert.equal(kept[3], 'TPL_DECLARATION class basic { int m() const { return 3; } };');
  assert.equal(kept[4], 'BOOL WINAPI c() { return 0; }');
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

test('keepByAddress / { all: false }: qualified names for members; constructors, destructors, main and templates are left out', () => {
  assert.deepEqual(scan.keepByAddress(CLASSES, { all: false }), [
    'auto __asm_lens_keep_0 = &Counter::add;',
    'auto __asm_lens_keep_1 = &Counter::helper;',
    'auto __asm_lens_keep_2 = &Counter::operator==;',
    'auto __asm_lens_keep_3 = &Counter::secret;',
    'auto __asm_lens_keep_4 = &file_local;',
    'auto __asm_lens_keep_5 = &inl;',
    'auto __asm_lens_keep_6 = &cx;',
    'auto __asm_lens_keep_7 = &anon;'
  ]);
  assert.ok(scan.keepByAddress('int main() { return 0; }\nint wmain() { return 0; }\n').length === 0);
  assert.ok(scan.keepByAddress(CLASSES).some(l => /&outOfLine|&Counter::outOfLine/.test(l)), 'a header keeps out-of-line members too');
});
