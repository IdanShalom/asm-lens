#include "forms.hxx"
#include "tmpl.hxx"

int use_some(int x) {
  Box<int> b(x);
  Vec<int> v;
  v.push(x);
  return plain_a(x) + b.add(x) + static_cast<int>(v.sum()) + Holder::member_si(x);
}
