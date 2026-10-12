#include "mathx.hxx"

__attribute__((noinline)) int sq_int(int x) { return square(x); }

double sq_double(double x) { return square(x); }

long clamp_long(long v) { return clamp_to<long>(v, 0, 100); }

int cube_int(int x) { return mx::cube(x); }

int use_box(mx::Box<int> b) { return b.twice(); }
