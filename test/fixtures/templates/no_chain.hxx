template <typename U> struct Cell { U v; U weak() const { return (U)v.a; } };
struct S { int a; };
template <typename T> struct Box {
  T get() const { return v; }
  T broken() const { return c.weak(); }
  T v; Cell<S> c;
};
static inline int plain_one(int x) { return x + 1; }
static inline int plain_two(int x) { return x + 2; }
