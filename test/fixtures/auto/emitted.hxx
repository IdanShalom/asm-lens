#pragma once
__attribute__((error("cannot be called"))) int forbidden(int);
static inline int first_ok(int x) { return x + 1; }
static inline int fails_when_emitted(int x)
{
  return forbidden(x);
}
static inline int second_ok(int x) { return x + 2; }
extern inline __attribute__((gnu_inline)) int gnu_extern(int x) { return x + 12; }
