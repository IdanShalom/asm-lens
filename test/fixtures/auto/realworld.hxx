#pragma once
#include <cstdint>
#include <string>
#include <vector>
#define U32 std::uint32_t
#define BOOL int
#define INLINE inline
#define NOEXC noexcept
#define API_FN(x) x
typedef unsigned long long U64;
static inline U32 caps_ret(U32 x) { return x + 1; }
static INLINE U64 caps_two(U64 x) { return x + 2; }
INLINE BOOL caps_three(int x) { return x == 3; }
static inline int after_macro(int x) NOEXC { return x + 5; }
static inline int after_call(int x) API_FN(noexcept) { return x + 7; }
static inline API_FN(int) wrapped_ret(int x) { return x + 8; }
struct Holder {
  BOOL member_caps(int x) const { return x == 9; }
  static U64 static_caps(U64 x) { return x + 10; }
  int member_after(int x) const NOEXC { return x + 11; }
};
static inline struct Holder* get_holder(struct Holder* h) { return h; }
static inline const char* a_name(int x) { return x ? "a" : "b"; }
static inline std::string a_string(int x) { return x ? "yes" : "no"; }
static inline std::vector<int> a_vector(int x) { return {x, x + 1}; }
static inline int same_a(int x) { return x + 100; }
static inline int same_b(int x) { return x + 100; }
static inline int unused_param(int) { return 13; }
static inline void nothing() { }
