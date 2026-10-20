package arrays

import "fmt"

// Run demonstrates fixed-size arrays: indexing, zero values and iteration.
func Run() {
	// An array has a fixed size of 4. Missing elements get the zero value ("").
	var productNames [4]string = [4]string{"A book"}
	prices := [4]float64{10.99, 9.99, 45.99, 20.0}

	fmt.Println("--- Arrays ---")
	fmt.Println("Original prices array:")
	fmt.Println(prices)

	// Assigning by index changes one element. The empty strings print as double spaces.
	productNames[2] = "carpet"
	fmt.Println("Product names array after assigning productNames[2] (empty elements show as blanks):")
	fmt.Println(productNames)

	fmt.Println("Single element prices[2]:")
	fmt.Println(prices[2])

	// The size is part of the type: [4]float64 and [5]float64 are different types.
	fmt.Println("Length of prices:")
	fmt.Println(len(prices))
}
