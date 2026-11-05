#pragma once
template <typename U> struct Cell { U v; U weak() const { return (U)v.a; } };
struct S { int a; };
template <typename X> X call_weak(const Cell<X>& c) { return c.weak(); }
