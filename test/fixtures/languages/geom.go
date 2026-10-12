package geom

type P struct{ X, Y int }

func Square(x int) int {
	return x * x
}

func (p *P) Sum() int { return p.X + p.Y }

func Apply(f func(int) int, v int) int { return f(v) }
