package recursion

import "fmt"

// Run demonstrates recursion: a function that calls itself. The factorial
// (5! = 5 * 4 * 3 * 2 * 1 = 120) is the classic example.
func Run() {
	fmt.Println("--- Recursion ---")

	// The loop-based solution, shown for comparison — needs nothing new.
	fmt.Println("factorialLoop(5):")
	fmt.Println(factorialLoop(5))

	// The recursive solution: factorial(5) multiplies 5 with factorial(4),
	// which multiplies 4 with factorial(3), ..., until number reaches 0.
	// Each call pauses until the inner call returns its value.
	fmt.Println("factorial(5):")
	fmt.Println(factorial(5))
	fmt.Println("factorial(3):")
	fmt.Println(factorial(3))
}

// factorialLoop computes the factorial with a regular for loop.
func factorialLoop(number int) int {
	result := 1

	for i := 1; i <= number; i++ {
		result = result * i
	}

	return result
}

// factorial computes the factorial recursively.
// The exit condition (number == 0 returns 1) is mandatory — without it the
// function would call itself forever and crash the application.
func factorial(number int) int {
	if number == 0 {
		return 1
	}

	return number * factorial(number-1)
}
