#include "vec.hpp"
#include <algorithm>
#include <vector>

struct Circle {
  double r;
  double area() const { return 3.14159265358979 * r * r; }
  double scaled(double k) const { return area() * k; }
};

int sum(const std::vector<int>& v) {
  int s = 0;
  for (int x : v) s += x;
  return s;
}

int main() {
  std::vector<int> v{5, 3, 8, 1};
  std::sort(v.begin(), v.end(), [](int a, int b) { return a > b; });
  Circle c{2.0};
  return clamp_byte(sum(v) + static_cast<int>(c.scaled(2)) + dot(v.data(), v.data(), v.size()));
}
