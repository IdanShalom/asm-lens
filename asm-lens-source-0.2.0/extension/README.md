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

## Local includes

Asm Lens follows `#include "..."`, `#include <...>` and `#import` directives recursively and uploads the local headers it finds, laid out on the remote side exactly as they are on disk. Relative paths such as `#include "../include/x.h"` therefore work, and nested relative includes keep working.

Headers are looked up like a compiler would: for quoted includes the including file's directory first, then the analyzed file's directory, `asmLens.includePaths`, and the workspace folders. Unsaved edits in open headers are used. Editing a header invalidates results that used it. Instructions that come from system or other non-uploaded headers are not mapped onto your file.

```json
"asmLens.includePaths": [
  "include",
  "src/generated"
]
```

Quoted includes that cannot be found are listed in the *Asm Lens* output channel. Discovery is bounded by `asmLens.maxIncludeFiles` (default 80), 1 MiB per file and 32 levels of nesting. Only files reached through `#include` directives are uploaded. Standard/system headers are left to the remote compiler.

Some projects still cannot be compiled remotely, for example when they depend on generated headers not present on disk, platform-specific SDK headers, build-system definitions, or project-specific compiler/linker flags. The extension sends the configured compiler flags plus `-I` flags for the uploaded layout; it does not reproduce a full local build. The `-I` flags are GCC/Clang style.

## Settings

- `asmLens.baseUrl`: Compiler Explorer URL (default `https://godbolt.org`).
- `asmLens.compilerId`: Compiler Explorer compiler ID (default `g152`).
- `asmLens.flags`: Compiler flags (default `-O2 -masm=intel`).
- `asmLens.language`: `c` or `c++`.
- `asmLens.includePaths`: extra local include directories to upload headers from.
- `asmLens.maxIncludeFiles`: cap on uploaded headers per analysis.
- `asmLens.highlightOnHover`: enable two-way highlighting.
- `asmLens.requestTimeoutMs`: request timeout.
- `asmLens.showCounts`: show CodeLens counts.

**Privacy:** source files and discovered local headers are sent to the configured Compiler Explorer server for compilation.
