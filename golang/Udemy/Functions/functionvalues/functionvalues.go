package functionvalues

import "fmt"

// transformFn is a custom type for the function type "func(int) int".
// A nice place to use custom types: long function type definitions would
// otherwise have to be repeated everywhere they are needed.
type transformFn func(int) int

// Run demonstrates that functions are first class values: they can be
// passed into other functions as parameter values, just like numbers or slices.
func Run() {
	numbers := []int{1, 2, 3}

	fmt.Println("--- Functions as values ---")
	fmt.Println("Original numbers:")
	fmt.Println(numbers)

	// Note: doubleNumbers is NOT executed here (no parentheses). The function
	// itself is passed as a value. transformNumbers executes it per element.
	doubled := transformNumbers(&numbers, doubleNumbers)
	fmt.Println("transformNumbers(&numbers, doubleNumbers):")
	fmt.Println(doubled)

	// The same generic function, now with a different transformation function:
	// no code duplication, only a different function value is passed in.
	tripled := transformNumbers(&numbers, tripleNumbers)
	fmt.Println("transformNumbers(&numbers, tripleNumbers):")
	fmt.Println(tripled)
}

// RunReturn demonstrates that functions can not only take but also return
// other functions.
func RunReturn() {
	numbers := []int{1, 2, 3}
	moreNumbers := []int{5, 1, 2}

	fmt.Println("--- Functions returning functions ---")

	// getTransformerFunction returns a function (chosen by its logic),
	// not a result. The returned values are functions themselves.
	transformFn1 := getTransformerFunction(&numbers)
	transformFn2 := getTransformerFunction(&moreNumbers)

	fmt.Println("getTransformerFunction(&numbers) picked doubleNumbers (first element is 1):")
	fmt.Println(transformNumbers(&numbers, transformFn1))

	fmt.Println("getTransformerFunction(&moreNumbers) picked tripleNumbers (first element is 5):")
	fmt.Println(transformNumbers(&moreNumbers, transformFn2))
}

// transformNumbers applies the received transform function to every element
// and returns a new slice. The second parameter type is the custom type
// transformFn, which stands for "func(int) int".
func transformNumbers(numbers *[]int, transform transformFn) []int {
	dNumbers := []int{}

	for _, val := range *numbers {
		dNumbers = append(dNumbers, transform(val))
	}

	return dNumbers
}

// getTransformerFunction picks a transformer based on the data. Its return
// type is transformFn, i.e. it returns a function, not a value.
func getTransformerFunction(numbers *[]int) transformFn {
	if (*numbers)[0] == 1 {
		return doubleNumbers
	} else {
		return tripleNumbers
	}
}

func doubleNumbers(number int) int {
	return number * 2
}

func tripleNumbers(number int) int {
	return number * 3
}
