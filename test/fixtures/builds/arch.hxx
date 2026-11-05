#pragma once
static inline int both(int x) { return x + 1; }
#ifdef BUILD_A
static inline long only_a(long x) { return x + 2; }
#endif
#ifdef BUILD_B
static inline long long only_b(long long x) { return x + 3; }
#endif
#ifdef NEVER_DEFINED
static inline int never(int x) { return x; }
#endif
template <typename T>
T pick(const T& a) { return a + a; }
