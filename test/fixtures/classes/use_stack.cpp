#include "stack.h"
int run(int n) {
    Stack<int> s;
    s.push(n);
    int size = static_cast<int>(s.size());
    return size + s.pop() + (s.empty() ? 1 : 0);
}
