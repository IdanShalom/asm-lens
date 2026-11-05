// No includes here: it relies on what the .cpp includes and defines first.
#pragma once
static inline int px(const Point& p) { return p.x + OFFSET; }
static inline int always(int x) { return x + 1; }
#ifdef FEATURE_ON
static inline int featured(int x) { return x * 3; }
#endif
#ifdef NEVER_ON
static inline int never(int x) { return x * 4; }
#endif
template <typename T>
struct Wrap {
  Point p;
  T v;
  T get() const { return v + p.x; }
  T scaled(int k) const { return v * k; }
};
