package closures

import "fmt"

// Run demonstrates closures: anonymous functions that "lock in" variables
// from the scope in which they were created — here via a factory function.
func Run() {
	numbers := []int{1, 2, 3}

	fmt.Println("--- Closures (factory functions) ---")
	fmt.Println("Original numbers:")
	fmt.Println(numbers)

	// createTransformer is a factory function: it produces functions with
	// different configurations. double and triple are entirely different
	// functions, each with its own locked-in factor.
	double := createTransformer(2)
	triple := createTransformer(3)

	doubled := transformNumbers(&numbers, double)
	fmt.Println("double := createTransformer(2), then transformNumbers(&numbers, double):")
	fmt.Println(doubled)

	tripled := transformNumbers(&numbers, triple)
	fmt.Println("triple := createTransformer(3), then transformNumbers(&numbers, triple):")
	fmt.Println(tripled)

	// Later calls to createTransformer(3) do NOT change double: the anonymous
	// function closed over factor = 2, and that value stays locked in for
	// every future execution of double.
}

// createTransformer returns an anonymous function. The returned function uses
// "factor", which is NOT its own parameter but a parameter of the outer
// createTransformer function. Because of scoping, inner scopes can use
// variables of outer scopes — and the value is locked in (closure).
func createTransformer(factor int) func(int) int {
	return func(number int) int {
		return number * factor
	}
}

func transformNumbers(numbers *[]int, transform func(int) int) []int {
	dNumbers := []int{}

	for _, val := range *numbers {
		dNumbers = append(dNumbers, transform(val))
	}

	return dNumbers
}
