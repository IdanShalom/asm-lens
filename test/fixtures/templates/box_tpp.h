#pragma once
template <typename T> struct Box {
    T get() const { return v; }
    T in_tpp() const;
    virtual T vcall() const { return v + v; }
    virtual ~Box() { }
    T v;
};
#include "box.tpp"
