#define OFFSET 5
#define FEATURE_ON
#include "sub/types.h"
#include "needs.hxx"
int use(Point p) { Wrap<long> w{p, 3}; Wrap<Point*> q{}; return px(p) + (int)w.get() + (q.v ? 1 : 0); }
