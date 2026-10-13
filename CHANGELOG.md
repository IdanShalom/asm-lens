# Changelog

## 0.7.0

### New
- **compile_commands.json in local mode** (`"compileCommands"` in `.asm-lens.json`, or the
  `asmLens.compileCommands` setting): each file is compiled with its entry's compiler and flags, in the
  entry's directory, without `-c`, `-o`, `-M*`, `-Werror*` and the source path; headers use the entry of a
  file that includes them, else the nearest one. Reloaded when the database changes; **Reload Compile
  Commands** command. The output shows the final command and the entry used.
- The highlighted line and instructions stand out: the rest of the function fades (`asmLens.dimOtherLines`).

### Fixes
- **MSVC** on Compiler Explorer (x64, x86, ARM64, ARM32): its functions (`PROC`/`ENDP`) were not found, so
  nothing was shown; its error messages (written to stdout) were not read, so recovery from missing headers
  and failing functions did not work; headers analyzed on their own now emit their functions too.
- **`-masm=intel`** ("ignoring unknown option", or a failing compile on ARM and other targets): Asm Lens now
  chooses the syntax flag itself, per compiler and target; `-masm=att` still selects AT&T syntax.
- A flag a compiler rejects (`-O2` for cc65, Norcroft, ORCA/C, ...) is left out and the file compiled again.
- **Selecting a compiler** from Compiler Explorer now always takes effect: it was ignored when the project file
  said `"mode": "local"`, when the assembly view had the focus, and when a workspace setting overrode the
  user setting it was written to. A compiler picked for C++ is no longer used for C files.
- A function that inlines another function of the same file is no longer counted as that function's
  "instantiation" (`square` showed "2 instantiations").
- Compilers that prefix C names with `_` (SDCC, SH, Z80, 32-bit Windows), label comments with `@` (TI Arm
  Clang), write labels without a colon (Norcroft) or functions as blocks (cc65 `.proc`, ORCA/C `start`) are
  understood. One compiler of every compiler family on Compiler Explorer was checked (`test/tools/survey-ce.js`):
  47 of 49 C++ families and 51 of 56 C families work. The others cannot: EDG and c2rust produce no assembly,
  GCC for 6502 and z88dk need target flags, ORCA/C has no include paths, and TinyCC and cproc fail on the
  server itself.
- **Highlighting is faster**: the assembly view is built once and switching functions only sends the rows
  (no page reload, no fixed delays); the line lookups are indexed.
- The assembly view stays in the column you put it in; clicking an instruction opens the source in the column
  it is shown in, with the exact path casing (Windows).
- Compiler Explorer rate limits (HTTP 429) and replies that are not JSON get clear messages, and automatic
  re-analysis pauses for 30 seconds after a 429.
- A language server that lists only a function's declaration no longer hides its definition's CodeLens.
- Changing a display setting (highlighting, colors) no longer discards the results.
- Problems in `.asm-lens.json` are logged once instead of on every editor switch.

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
- Clang for Windows (MSVC target): names are matched without a demangler and demangled with
  `llvm-undname` when it is installed.
- Swift without `swift-demangle` on the PATH (Linux): functions are found and named.
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

### Faster, with progress
- A progress notification shows each step (finding headers, compiling, retrying around errors)
  with a Cancel button that stops the request or the compiler and everything it started. The
  status bar and the CodeLens spin while an analysis runs.
- Editing no longer throws the results away: counts below an edit move with the text, only the
  edited functions show *Updating…*, and the file is analyzed again in the background when typing
  pauses (`asmLens.reanalyzeOn`: `edit`, `save` or `never`; `asmLens.reanalyzeDelayMs`). A newer
  edit cancels the compile of older text; the open assembly view follows the new code.
- Compiler Explorer is asked to leave out directives and comment lines: replies are 5 to 15 times
  smaller with the same results. Identical requests are answered from an in-memory cache.
- The language server's symbols are fetched while the code compiles, not after.

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
