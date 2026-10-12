public func square(_ x: Int) -> Int {
    return x * x
}

public struct Acc {
    public var total = 0
    public mutating func push(_ v: Int) { total += v }
}
