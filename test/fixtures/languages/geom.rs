pub fn square(x: i32) -> i32 {
    x * x
}

pub fn longest<'a>(a: &'a str, b: &'a str) -> &'a str {
    if a.len() > b.len() { a } else { b }
}

pub struct Acc { pub total: i64 }

impl Acc {
    pub fn push(&mut self, v: i64) { self.total += v; }
}
