#include "no_chain_cell.h"
template <typename T> struct Box {
  T get() const { return v; }
  T broken() const { return call_weak(c); }
  T v; Cell<S> c;
};
template <typename T> struct Fine { T ok() const { return T{}; } };
static inline int plain_one(int x) { return x + 1; }
