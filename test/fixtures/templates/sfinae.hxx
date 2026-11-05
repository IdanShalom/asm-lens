#include <type_traits>

template <typename T> struct Box {
#define ONLY_IF_4(U, RET) std::enable_if_t<sizeof(U) == 4, RET>
#define ONLY_IF_8(U, RET) std::enable_if_t<sizeof(U) == 8, RET>
    template <typename U = T> ONLY_IF_4(U, U) get() const noexcept { return v; }
    template <typename U = T> ONLY_IF_8(U, U) get() const noexcept { return v + 1; }
    T v;
#undef ONLY_IF_4
#undef ONLY_IF_8
};
