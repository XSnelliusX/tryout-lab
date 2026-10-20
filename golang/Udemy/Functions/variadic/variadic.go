package variadic

import "fmt"

// Run demonstrates variadic functions: a "..." parameter accepts any number
// of standalone arguments and collects them into a slice.
func Run() {
	fmt.Println("--- Variadic functions ---")

	// No slice needed at the call site: the values are passed one by one,
	// and the three dots in the parameter list merge them into a slice.
	sum := sumUp(1, 2, 3, 4, 5)
	fmt.Println("sumUp(1, 2, 3, 4, 5):")
	fmt.Println(sum)

	// Variadic parameters can mix with regular ones: the first value goes
	// into startingValue, everything after it is collected into the slice.
	// You could add a fourth or fifth number — the count is dynamic.
	sumWithStart := sumUpWithStart(10, 1, 2, 3)
	fmt.Println("sumUpWithStart(10, 1, 2, 3) (10 is the starting value):")
	fmt.Println(sumWithStart)
}

// RunSpread demonstrates the opposite direction: spreading an existing slice
// into standalone arguments with "..." at the call site.
func RunSpread() {
	fmt.Println("--- Spreading a slice with ... ---")

	numbers := []int{1, 10, 15}

	// The three dots pull the elements out of the slice, so sumUp receives
	// them as three standalone int arguments (plus nothing for start).
	anotherSum := sumUp(numbers...)
	fmt.Println("sumUp(numbers...) with numbers = [1 10 15]:")
	fmt.Println(anotherSum)
}

// sumUp accepts any amount of int values. Inside the function, "numbers"
// is simply a slice of ints — the dots only affect the call site.
func sumUp(numbers ...int) int {
	sum := 0

	for _, val := range numbers {
		sum += val
	}

	return sum
}

// sumUpWithStart mixes a regular parameter with a variadic one: the first
// argument is the starting value, the rest are collected into the slice.
func sumUpWithStart(startingValue int, numbers ...int) int {
	sum := startingValue

	for _, val := range numbers {
		sum += val
	}

	return sum
}
