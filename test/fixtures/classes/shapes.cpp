#include <iostream>
#include <stdexcept>
#include <string>
#include <map>

struct Shape { virtual ~Shape() = default; virtual double area() const = 0; };
struct Sq : Shape { double s; explicit Sq(double s) : s(s) {} double area() const override { return s * s; } };

template <typename T> T twice(T v) { return v + v; }

int main(int argc, char**) {
  std::map<std::string, int> m{{"a", 1}};
  try {
    if (argc > 5) throw std::runtime_error("too many");
    Sq q(2);
    const Shape& s = q;
    std::cout << s.area() << twice(argc) << m["a"] << '\n';
  } catch (const std::exception& e) {
    std::cerr << e.what() << '\n';
    return 1;
  }
  auto f = [&](int k) { return k + argc; };
  return f(3);
}
