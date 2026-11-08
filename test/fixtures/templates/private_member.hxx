template <typename T> struct Priv {
    T get() const { return secret(); }
    T v;
private:
    T secret() const { return v + v; }
};
template <typename T> struct PrivBroken {
    T get() const { return v; }
    T broken() const { return (T)42; }
    T v;
private:
    T secret() const { return v; }
};
struct S { int a; S operator+(const S& o) const { return {a + o.a}; } };
