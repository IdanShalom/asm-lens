# Changelog

## 0.8.6

### New
- **Every build of a file counts.** A file listed more than once in `compile_commands.json` (a 32-bit and a 64-bit build,
  in one database or several) is compiled with each entry, a `.cpp` too, and the results are combined, so code behind
  `#ifdef __x86_64__` and behind `#ifdef __i386__` both show. The CodeLens names the target.
- **A chosen type stays chosen until it really fails.** `std::vector<int>` brings its header along. A type from a header
  the `.cpp` includes after this one works: those includes and its `using namespace` lines come before the request.
  The type is removed only if it fails in every compilation, and the CodeLens then gives the compiler's message.
- A template that does not compile with the types tried says so, with the reason: *Box<int> does not compile: ...*
- A member template of a class whose types you chose uses those types.
- **`compile_commands.json` decides for headers too.** A header takes the compile command of each file in the database
  that includes it, also through other headers, until its functions have code: one behind `-DFEATURE_A` and one
  behind `-DFEATURE_B` can both show it. In remote mode the entry's defines, include folders, standard and target
  options are used as well.
- Functions that still have no code are called from added lines after the end of the compiled copy, which shows
  their code if they compile at all (`extern inline`, `gnu_inline`).
- A *Not compiled* CodeLens gives the compiler's message.
- **Headers show code without a click.** Opening a header after analyzing a `.cpp` that includes it compiles the
  header by itself, so every function shows code: `static inline` ones the `.cpp` inlined or never called too.
- **Templates show code at once**, with the types the code uses (`Box<long>` in the `.cpp`), else `int`. The
  CodeLens names them. **Instantiate…** still chooses others. Setting: `asmLens.autoInstantiateTemplates`.
- **A header that needs its `.cpp` works**: one that fails alone, or has functions switched off by `#ifdef`, is
  compiled with the preprocessor lines before its `#include` in that `.cpp` (through other headers too, and found in
  the workspace if nothing was analyzed yet).
- **The CodeLens says why there is no code**: *Not compiled · inside #ifdef X, which is off*, *consteval…*,
  *Template: no code yet*, instead of "not used, or a template never instantiated".
- A test suite that runs the extension in a real VS Code (`npm run test:e2e`, also in CI).
- **Asks before code leaves your machine.** The first time a file would be sent to a Compiler Explorer server,
  a dialog says so and offers **Send**, **Send, Don't Show Again** and **Use Local Compiler**. Nothing is sent
  before you agree, and analyses that start by themselves never send. "Don't show again" holds per server, so a
  project's `.asm-lens.json` cannot quietly point your code somewhere else. Setting: `asmLens.confirmRemoteUpload`.
- Requests to Compiler Explorer identify the extension with a `User-Agent` (`asm-lens/<version>`), so that the
  server's operators can tell its traffic apart.

### Fixes
- Choosing types while a compile was running saved them but compiled nothing. That compile now stops and a new one starts.
- An automatic analysis of half-typed text could remove a type you had chosen.
- **`static inline` functions showed no code when their type was in capitals** (`U32`, `BOOL`, `DWORD`): such a type
  was taken for a macro, and the function was not kept. Inline functions and methods too, with every compiler.
- **A macro after the parameters hid the function** (`int f(int x) NOEXCEPT {`, `__THROW`, `ATTR(1)`), and `EXPORT(int)
  f(int x)` was taken for a function named `EXPORT`.
- **One function that cannot be emitted cost all of them.** Some errors appear only when a function is emitted, which
  made Asm Lens compile the whole file without keeping anything. Now only that function says *Not compiled*, with
  the compiler's reason.
- A header that needs a define from a file it includes earlier (`#include "config.h"` before it) stayed off.
- With a language server still starting during the analysis, a function could lose its code when the server's symbol
  started on another line than the one used then.
- **Code the preprocessor splits hid everything after it.** `#ifdef` around half a block or a signature, `#if 0` with half
  a function, and a digit separator (`1'000`) made every later line count as inside that function, so later functions
  were not kept. A macro alone on a line without a semicolon (`DISALLOW_COPY(C)`) hid the function after it.
- **`-Werror` in the flags stopped analyses**: GCC's "`#pragma once` in main file" for a header, and warnings that appear
  only when an unused function is emitted. It is left out here, since warnings do not change the code.
- A forced include or precompiled header that already includes the header being compiled hid all of it. It is left out then.
- A SIMD helper without the flag for it (`-mavx2`) is compiled for that feature, and the CodeLens says so.
- `-flto` in `compile_commands.json` gave no assembly at all: with it, `-S` writes LTO data or LLVM IR. Left out now, with
  `-gsplit-dwarf`, coverage and other instrumentation, and flags that leave reports in the build folder.
- **Overloaded functions had no code with MSVC** ("not used, or a template never instantiated"): they are kept by
  taking their address, and `&name` does not compile for an overloaded name. They are now selected by their type.
  Overloaded function templates too, with every compiler.
- **Struct templates with a `requires` clause were not seen as templates**, so their methods had no code and no way
  to choose types; a trailing `requires` hid the method altogether. `struct ABC final` was taken for a struct named
  `final`.
- **Friend functions defined in a class template never had code**, since instantiating the class does not
  instantiate them. They are now called, after the end of the compiled copy.
- Constructors and destructors had no code with MSVC, which cannot take their address.
- One server error (HTTP 502, a lost connection) while compiling turned off the marks that keep unused functions
  until VS Code restarted, so `static inline` functions showed no code from then on.
- A header whose functions were all inlined was not tied to the `.cpp` in local mode, so it kept offering to be
  analyzed, and saving it did not update the `.cpp`.
- clangd: an in-class declaration got a CodeLens as if it had a body.
- Instantiating a class and a class nested in it was an error; the nested one now comes with the outer one.
- Automatic analyses no longer show a message each time they finish. `-Iasm_lens…` is no longer listed among your flags.
- **`static inline` functions in headers showed "No code emitted"**, with every compiler, as soon as one
  function in the header could not compile on its own, because all of the header's functions lost the marks that
  keep them. Now only the functions that fail say *Not compiled*. With MSVC this also happened for anything it
  cannot parse, such as `__attribute__`.
- **Members of class templates said "template not instantiated"** when a `.cpp` used them and they were simply
  inlined. They now say *No separate code in user.cpp (inlined or not used)*, and clicking the CodeLens asks for
  the types.
- Instantiating a method of a partial specialization (`Stack<T*>`) compiled the primary template instead, so the
  method never got code.
- A class that does not compile as a whole for the chosen types was dropped with an error; now the member you
  clicked is compiled on its own.
- GCC cold paths and split parts in the newer `f(int) (.cold)` form counted as a second function, showing
  "2 instantiations" or "2 versions" for functions that are not templates.
- Standard library functions without line information were counted as yours when the names matched:
  `std::vector::empty` showed up as a second instantiation of `Stack::empty` with MSVC.
- The log named `__attribute__` as the function it skipped.

## 0.8.2

### Fixes
- **Headers kept losing their results.** A header showed only the newest analysis, so analyzing a `.cpp` that
  includes it turned everything the `.cpp` did not use into "No code emitted", including functions the header's
  own analysis had found and templates you had instantiated. Now the newest analysis with code for a function
  decides, older ones made with the same compiler fill the gaps, and requested instantiations always show the
  code you asked for. The assembly view, hovers and the cursor follow the same rule.
- A header seen only through a `.cpp` no longer says "template not instantiated" right under its saved
  instantiations, or "No code emitted" for a function that `.cpp` simply does not use. The CodeLens says what
  happened (*Instantiations not compiled yet*, *Not used by user.cpp*), and clicking it analyzes the header.
- Typing at the very start of a line without a line break did not mark that function as changed, so it could
  keep showing old numbers.

## 0.8.1

### Fixes
- **"Compiler Explorer request timed out"**: Compiler Explorer sometimes takes much longer to answer than
  to compile (seconds in its queue before the compiler runs). A request without an answer in time is now
  sent once more, the progress shows how many seconds it has waited, and the default
  `asmLens.requestTimeoutMs` is 60 s (was 30 s). When both attempts get no answer, the message says so
  and what to do.
- The compiler list (Select Compiler → Browse) and the lookup of a language's default compiler no longer
  wait forever when the server does not answer.

## 0.8.0

### New
- **Functions inside classes, with every compiler**: methods defined in a class body, and `static`,
  `inline` and `constexpr` functions, get their own counts in a `.cpp` file even when nothing calls them
  or every call was inlined. The compiled copy marks them `__attribute__((used))` (MSVC: takes their
  address after the last line); line numbers and your file stay the same, and if the marked copy does
  not compile the file is compiled as written (and the marks are not tried again for that file and
  compiler). New setting `asmLens.emitUnusedFunctions` (on by default).
- **MSVC flags**: the usual GCC/Clang flags are translated for MSVC and clang-cl (`-O3` → `/O2`,
  `-std=c++20` → `/std:c++20`, `-Wall` → `/W4`, `-fno-exceptions` → `/EHs-c-`, …); flags without an
  equivalent (`-march`, `-g`) are left out instead of producing "D9002 ignoring unknown option", and C++
  gets `/EHsc` like Visual Studio projects. MSVC flags given to GCC/Clang are translated the other way.
  Each translation is listed in the output. Before, `-O3` silently compiled MSVC code unoptimized.
- Local mode: a compiler whose default is C++98 (Apple clang 14) gets `-std=gnu++17` when the code needs
  C++11 or later and no `-std` was given.

### Fixes
- **`main` (or a constructor) shown as several "instantiations"**: lambdas inside `main`, library
  templates that inlined them (`std::sort` with a lambda), RTTI and vtables (`typeinfo for Sq`, which
  looked like the constructor `Sq`) were counted as copies of the function. Now only functions of the
  same name are, data is never a function, copies with identical code (a constructor's complete- and
  base-object versions) are shown once, and copies of a non-template function are called "versions".
- The cursor in `main` selects `main` in the assembly view, not a lambda or library code on that line.
- **Hover highlighting no longer darkens the rest**: the assembly view always faded the other instructions,
  even with `asmLens.dimOtherLines` off. Now nothing fades by default; the setting turns fading on for
  both the editor and the assembly view.

## 0.7.1

### Fixes
- **Select Compiler without a project file**: a compiler picked with Browse earlier (while a
  `.asm-lens.json` existed, or in 0.6) was stored for the workspace and kept overriding the
  `asmLens.compilerId` setting, so choosing MSVC still compiled with Clang. Picks made in a project
  now belong to its `.asm-lens.json`; without one, the settings decide and old picks are cleared.
- After choosing a compiler the file is analyzed again (the settings change used to discard the results
  first, so it was not), and editing `asmLens.compilerId` or other compile settings by hand re-analyzes
  the visible files.
- The status bar no longer keeps the spinner after an analysis, or shows the compiler name while one runs.
- MSVC exception funclets (`main$dtor$0`) and GCC cold paths (`f [clone .cold]`) belong to their function:
  `main` no longer shows "2 instantiations".
- `asmLens.compilerName` is empty by default (was "GCC (selected ID)"), so the label shows the compiler id
  you set.
- C/C++ scanning of real-world headers (checked on nlohmann/json, doctest, fmt, stb_image with
  `test/tools/stress-headers.js`): namespaces and classes opened after statement macros
  (`NLOHMANN_JSON_NAMESPACE_BEGIN namespace detail {`) were skipped whole; braces in expressions
  (`decltype(f(tag<3>{}))`) were taken for function bodies; a long run of macro names could make the scan
  take minutes.
- A header analyzed on its own: `__attribute__((used))` goes after macros such as `DOCTEST_NORETURN`, is
  not added where a macro may hide `template<...>`, and when the marked text fails to compile the header is
  compiled as written instead of skipping functions.

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
