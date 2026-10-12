#pragma once
// Header-only code: templates, static inline, inline and in-class methods.

template <typename T>
T square(T x) { return x * x; }

template <typename T>
T clamp_to(T v, T lo, T hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

static inline int add_ints(int a, int b) { return a + b; }

inline int mul_ints(int a, int b) {
  return a * b;
}

namespace mx {
template <typename T> T cube(T x) { return x * x * x; }

struct Acc {
  int total = 0;
  void push(int x) { total += x; }
  int get() const { return total; }
};

template <typename T>
struct Box {
  T value;
  T twice() const { return value + value; }
};
}  // namespace mx
