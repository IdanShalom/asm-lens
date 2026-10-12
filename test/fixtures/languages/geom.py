def square(x):
    return x * x


class Acc:
    def push(self, v):
        total = 0
        for i in range(v):
            total += i
        return total


def uses_lambda(xs):
    return sorted(xs, key=lambda x: -x)
