# Asm Lens

Asm Lens shows compiler-generated instruction counts for C/C++ functions using Compiler Explorer.

## Features

- CodeLens instruction counts for emitted function bodies, in the analyzed file **and in the headers it includes** (functions defined in a header show their count once an including file has been analyzed).
- Click a count to open a cleaned assembly view. Click an instruction to jump to its source line, even when it lives in a header.
- Hover highlighting, as in Compiler Explorer:
  - Hover (or put the cursor on) a source line: its instructions are highlighted in the assembly view, and the hover shows just those instructions.
  - Hover an instruction: its source line is highlighted in the editor (plus the exact token when Compiler Explorer reports a column), and every other instruction from the same line lights up in the panel.
  - Hover a function's signature line to preview the whole function's assembly.
- Local includes are uploaded recursively (see below).

## Project config file: `.asm-lens.json`

Put a `.asm-lens.json` in your project root (run **Asm Lens: Open or Create Project Config** to create one with a template). It overrides the VS Code settings for that project:

```json
{
  "compilers": [
    { "id": "g152",  "name": "GCC 15.2",  "flags": "-O2 -masm=intel" },
    { "id": "g132",  "name": "GCC 13.2",  "flags": "-O3 -masm=intel" },
    { "id": "clang_trunk", "name": "Clang", "language": "c++" }
  ],
  "includePaths": [
    "include",
    "src/generated",
    { "path": "third_party", "recursive": true },
    "/opt/vendor/include"
  ],
  "buildFolders": ["build", "out"]
}
```

- **compilers**: the first is the default, the second, third, ... are alternatives. Switch with the status-bar item (bottom right, shows the active compiler) or **Asm Lens: Select Compiler**; the choice is remembered per workspace. A compiler can have its own `flags`, and `"language": "c"` / `"c++"` offers it only for those files. Use **Select Compiler → Browse all Compiler Explorer compilers** to look up ids (the exact ids depend on the Compiler Explorer instance).
- **includePaths**: search folders in priority order: first entry first, then the second, third, and so on. Relative paths are relative to the config file; `{ "path": ..., "recursive": true }` also searches all subfolders of that folder at that priority. The analyzed file's own folder is always searched first, and the workspace folders and `build` folders last.
- **buildFolders**: folder names searched last for headers found nowhere else (generated headers).
- Also accepted: `flags`, `language`, `baseUrl`, `maxIncludeFiles`. Comments and trailing commas are allowed. The file is found by walking up from the analyzed file, also as `.vscode/asm-lens.json`. Editing it takes effect immediately. Problems in the file are reported in the *Asm Lens* output channel.

## Local includes

Asm Lens follows `#include "..."`, `#include <...>` and `#import` directives recursively and uploads the local headers it finds, laid out on the remote side exactly as they are on disk. Relative paths such as `#include "../include/x.h"` therefore work, and nested relative includes keep working.

Headers are looked up like a compiler would: for quoted includes the including file's directory first, then the analyzed file's directory, `asmLens.includePaths`, and the workspace folders. Unsaved edits in open headers are used. Editing a header invalidates results that used it. Instructions that come from system or other non-uploaded headers are not mapped onto your file.

```json
"asmLens.includePaths": [
  "include",
  "src/generated"
]
```

## Missing headers and failing functions

A function that does not need a missing header still gets analyzed. If the compiler reports a missing include, Asm Lens retries with that header replaced by an empty file. If some functions then fail to compile (because they used something from it), those functions are blanked out -- line numbers stay the same -- and the rest is compiled again. Blanked functions show **Not compiled** in their CodeLens, and everything that was skipped is listed in the *Asm Lens* output channel. Each retry is one extra request, up to `asmLens.maxRecoveryAttempts`. Turn the function skipping off with `asmLens.skipFailingFunctions`. Only the copy sent to Compiler Explorer is modified, never your files.

If a header is not found on any include path, the workspace is searched for it (case-insensitively), first in your normal folders and then in build output folders (`build`, `out`, `cmake-build-*`, `generated`, ...), where generated headers usually live. The folder it is found in becomes an include directory.

Quoted includes that cannot be found are listed in the *Asm Lens* output channel. Discovery is bounded by `asmLens.maxIncludeFiles` (default 80), 1 MiB per file and 32 levels of nesting. Only files reached through `#include` directives are uploaded. Standard/system headers are left to the remote compiler.

Some projects still cannot be compiled remotely, for example when they depend on generated headers not present on disk, platform-specific SDK headers, build-system definitions, or project-specific compiler/linker flags. The extension sends the configured compiler flags plus `-I` flags for the uploaded layout; it does not reproduce a full local build. The `-I` flags are GCC/Clang style.

## Settings

- `asmLens.baseUrl`: Compiler Explorer URL (default `https://godbolt.org`).
- `asmLens.compilerId`: Compiler Explorer compiler ID (default `g152`).
- `asmLens.flags`: Compiler flags (default `-O2 -masm=intel`).
- `asmLens.language`: `c` or `c++`.
- `asmLens.includePaths`: extra local include directories to upload headers from.
- `asmLens.maxIncludeFiles`: cap on uploaded headers per analysis.
- `asmLens.skipFailingFunctions` / `asmLens.maxRecoveryAttempts`: tolerate missing headers and failing functions.
- `asmLens.highlightOnHover`: enable two-way highlighting.
- `asmLens.requestTimeoutMs`: request timeout.
- `asmLens.showCounts`: show CodeLens counts.

**Privacy:** source files and discovered local headers are sent to the configured Compiler Explorer server for compilation.
