#pragma once
#include <vector>
#include <cstddef>

template <typename T>
struct Box {
  T value;
  Box() : value() {}
  explicit Box(T v) : value(v) {}
  T get() const { return value; }
  void set(const T& v) { value = v; }
  T add(T other) const { return value + other; }
  T& ref() { return value; }
  static T make() { return T{}; }
  static inline T make2() { return T{} + T{}; }
  T outside(T a) const;
  Box operator+(const Box& o) const { return Box(value + o.value); }
  bool operator==(const Box& o) const { return value == o.value; }
  friend Box operator-(const Box& a, const Box& b) { return Box(a.value - b.value); }
  template <typename U> U conv() const { return static_cast<U>(value); }
  struct Inner {
    T inner;
    T twice() const { return inner + inner; }
  };
};

template <typename T>
T Box<T>::outside(T a) const { return value * a; }

template <typename T, std::size_t N>
struct Arr {
  T data[N];
  T first() const { return data[0]; }
  std::size_t size() const { return N; }
  T total() const { T s{}; for (std::size_t i = 0; i < N; ++i) s += data[i]; return s; }
};

template <typename K, typename V = int>
struct Pair {
  K k;
  V v;
  K key() const { return k; }
  V val() const { return v; }
};

template <typename T>
struct Vec {
  std::vector<T> items;
  void push(const T& v) { items.push_back(v); }
  std::size_t size() const { return items.size(); }
  T sum() const { T s{}; for (const T& x : items) s += x; return s; }
};

template <typename T>
struct Base { T b; T base_get() const { return b; } };

template <typename T>
struct Derived : public Base<T> {
  T derived_get() const { return this->b + this->b; }
};

template <class T> requires (sizeof(T) >= 1)
struct Constrained {
  T c;
  T get_c() const { return c; }
};

template <typename T>
static inline T tfree(T x) { return x + x; }
