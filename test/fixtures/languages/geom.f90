integer function square(x)
  integer, intent(in) :: x
  square = x * x
end function square

subroutine twice(x)
  integer, intent(inout) :: x
  x = x * 2
end subroutine twice
