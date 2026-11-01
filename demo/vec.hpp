#pragma once
#include <cstddef>

template <typename T>
T dot(const T* a, const T* b, std::size_t n) {
  T s{};
  for (std::size_t i = 0; i < n; ++i) s += a[i] * b[i];
  return s;
}

static inline int clamp_byte(int x) { return x < 0 ? 0 : x > 255 ? 255 : x; }
