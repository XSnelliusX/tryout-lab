package anonymous

import "fmt"

// Run demonstrates anonymous functions: functions defined just in time,
// directly in the place where a function value is needed (no name, so they
// cannot be called from anywhere else).
func Run() {
	numbers := []int{1, 2, 3}

	fmt.Println("--- Anonymous functions ---")
	fmt.Println("Original numbers:")
	fmt.Println(numbers)

	// The function is written inline, in place of the previously passed
	// doubleNumbers/tripleNumbers function values. The func keyword starts
	// it, no name follows, then parameters, return type and body.
	// The type must still match what transformNumbers expects: func(int) int.
	doubled := transformNumbers(&numbers, func(number int) int {
		return number * 2
	})
	fmt.Println("transformNumbers(&numbers, anonymous double function):")
	fmt.Println(doubled)

	// A second, different transformation — again defined just in time.
	// Great for one-off logic; for reused logic a named function is better.
	tripled := transformNumbers(&numbers, func(number int) int {
		return number * 3
	})
	fmt.Println("transformNumbers(&numbers, anonymous triple function):")
	fmt.Println(tripled)
}

// transformNumbers takes another function as a second parameter value,
// here written in the long form (no custom type) — which is also fine.
func transformNumbers(numbers *[]int, transform func(int) int) []int {
	dNumbers := []int{}

	for _, val := range *numbers {
		dNumbers = append(dNumbers, transform(val))
	}

	return dNumbers
}
