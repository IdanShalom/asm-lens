#pragma once
static inline int always(int x) { return x + 1; }
#ifdef FEATURE_A
static inline int only_a(int x) { return x + 2; }
#endif
#ifdef FEATURE_B
static inline int only_b(int x) { return x + 3; }
#endif
#ifdef NOWHERE
static inline int nowhere(int x) { return x + 4; }
#endif
#if defined(FROM_CONFIG)
static inline int from_config(int x) { return x + 5; }
#endif
