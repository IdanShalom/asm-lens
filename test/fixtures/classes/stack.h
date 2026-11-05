#pragma once
#include <vector>
#include <cstddef>

template <typename T>
class Stack {
public:
    void push(const T& v) { items_.push_back(v); }
    T pop() { T v = items_.back(); items_.pop_back(); return v; }
    bool empty() const { return items_.empty(); }
    std::size_t size() const;
private:
    std::vector<T> items_;
};

template <typename T>
std::size_t Stack<T>::size() const { return items_.size(); }

template <typename T>
class Stack<T*> {
public:
    T deref(T* p) const { return *p; }
};

template <typename T>
struct Mixed {
    T value;
    T get() const { return value; }
    auto length() const { return value.size(); }
};
