#pragma once
static inline int good_one(int a) { return a + 2; }
static inline int good_two(int a) { return a * 3; }
static inline int needs_other_header(ProjectType* p) { return p->value; }
static inline int uses_macro(int a) { return a + PROJECT_OFFSET; }
class Tools {
public:
    int good_member(int a) const { return a * 5; }
    static inline int good_static(int a) { return a * 7; }
    int bad_member() const { return missing_thing(); }
};
