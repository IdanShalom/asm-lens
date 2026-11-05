#pragma once
#include <vector>
#include <cstddef>

#define FORCE_INLINE inline __attribute__((always_inline))
#define STATIC_INLINE static inline

static inline int plain_a(int x) { return x + 1; }
inline static int plain_b(int x) { return x + 2; }
static __inline int plain_c(int x) { return x * 3; }
static inline int
  plain_d(int x)
{
  return x * 4;
}
static FORCE_INLINE int forced(int x) { return x * 5; }
STATIC_INLINE int via_macro(int x) { return x * 6; }
__attribute__((always_inline)) static inline int attr_first(int x) { return x * 7; }
static inline __attribute__((unused)) int attr_mid(int x) { return x * 8; }
static inline constexpr int ce_static(int x) { return x * 9; }
static inline int noexcept_fn(int x) noexcept { return x * 10; }
static inline auto trailing(int x) -> int { return x * 11; }
static inline int over(int x) { return x + 12; }
static inline float over(float x) { return x + 12.0f; }
static inline int sum_vec(const std::vector<int>& v) { int s = 0; for (int x : v) s += x; return s; }
namespace util {
static inline int in_ns(int x) { return x * 13; }
inline int just_inline(int x) { return x * 14; }
}
struct Holder {
  static inline int member_si(int x) { return x * 15; }
  static int member_s(int x) { return x * 16; }
  int member(int x) const { return x * 17; }
};
extern "C" {
static inline int in_extern_c(int x) { return x * 18; }
}
#ifdef NOT_DEFINED_HERE
static inline int gated_off(int x) { return x * 19; }
#endif
