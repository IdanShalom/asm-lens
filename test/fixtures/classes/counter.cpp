#include <algorithm>
#include <vector>

class Counter {
public:
  void add(int x) { total += x; }
  int get() const { return total; }
  int unused_twice() const { return total * 2; }
  static int helper(int v) { return v + 1; }
  int outOfLine(int k) const;
private:
  int total = 0;
};

int Counter::outOfLine(int k) const { return total * k; }

struct Point { int x, y; int dot(const Point& o) const { return x * o.x + y * o.y; } };

int main() {
  std::vector<int> v{3, 1, 2};
  std::sort(v.begin(), v.end(), [](int a, int b) { return a > b; });
  auto sq = [](int a) { return a * a; };
  Counter c;
  c.add(sq(v[0]));
  Point p{1, 2};
  return c.get() + c.outOfLine(2) + p.dot(p) + Counter::helper(1);
}
