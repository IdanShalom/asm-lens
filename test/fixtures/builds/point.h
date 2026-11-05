#pragma once
struct Point { int x; Point operator+(const Point& o) const { return {x + o.x}; } };
