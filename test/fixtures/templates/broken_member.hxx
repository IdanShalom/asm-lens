template <typename T> struct Box {
    Box() : v() { }
    explicit Box(T value) : v(value) { }
    ~Box() { }
    T get() const { return v; }
    T broken() const { return (T)42; }   // invalid when T is a struct
    T& at(int) { return v; }
    const T& at(int) const { return v; }
    T v;
};
struct S { int a; };
