# Changelog

## 0.6.0

### Headers and templates
- Analyzing a header on its own now emits every non-template function in it, in remote and local
  mode: free functions, `static inline` and `inline` functions, and member functions defined in
  classes (before, only lines starting with `static`/`inline` were handled, and only in local mode).
- New **Instantiate…** CodeLens above templates (and the *Instantiate Template at Cursor* command):
  type template arguments and see the code for them. Requests are remembered per file, shown at the
  top of the file, and dropped with the compiler's message when they do not compile.
- Headers now show the results of a `.cpp` that includes them correctly:
  - template instantiations such as `int square<int>(int)` (demangled with a return type) were not
    matched with `square`;
  - a header function was matched with an unrelated `.cpp` function that had a longer name
    (`cube` with `cube_int`);
  - same-named functions in a header are told apart by the lines their code comes from;
  - a header shows the newest analysis that involved it, so analyzing a `.cpp` after the header
    is reflected there.
- Functions are found without a language server in more cases: one-line bodies, multi-line
  signatures, in-class methods, templates, operators, constructors with initializer lists.

### Fixes
- Clang on Compiler Explorer: LLVM comment lines (`# %bb.0:`) were counted as functions, splitting
  every function in two.
- Local mode with Clang: `.cpp` lines were not mapped when Clang names the input `<dir>/<stdin>`;
  missing headers in Clang's format (`'x.h' file not found`) were not recovered.
- Local mode on macOS: debug sections and assembler-local labels were counted as functions; C
  symbols kept their leading underscore; folders behind symlinks (`/var` → `/private/var`) did not match.
- Local mode on Windows: escaped paths in `.file` directives, `.text$` sections (MinGW templates)
  and CodeView line information (Clang) are understood.
- Missing-header recovery also understands MSVC messages on Compiler Explorer.
- `.asm-lens.json`: compilers listed for one language are no longer used for others; the schema now
  lists every option (`mode`, `compiler`, `defines`, `excludePaths`, … were reported as unknown).

### New
- Languages: Rust, Go, Python (bytecode), Zig, Swift, D and Fortran, on Compiler Explorer and (except D)
  with a local compiler.
- `"mode"` per compiler, the `asmLens.mode` and `asmLens.localCompiler` settings (local mode without a
  project file), and the `asmLens.followCursor` and `asmLens.stubFailingHeaders` settings are now declared.
- The status bar shows whether compiling is local or remote.
- Marketplace-ready packaging, README, icon, tests on Windows, Linux and macOS, and a GitHub release on
  every `v*` tag.

## 0.5.0 and earlier

Instruction counts as CodeLens, the assembly view with two-way highlighting, recursive upload of local
headers, recovery from missing headers and failing functions, `.asm-lens.json`, and local mode for C/C++.
