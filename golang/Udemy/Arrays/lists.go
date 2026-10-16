package main

import (
	"fmt"
)

func main() {
	// An array has a fixed size of 4. Missing elements get the zero value ("").
	var productNames [4]string = [4]string{"A book"}
	prices := [4]float64{10.99, 9.99, 45.99, 20.0}
	fmt.Println("Original prices array:")
	fmt.Println(prices)

	// Assigning by index changes one element. The empty strings print as double spaces.
	productNames[2] = "carpet"
	fmt.Println("\nProduct names array (empty elements show as blanks):")
	fmt.Println(productNames)

	fmt.Println("\nSingle element prices[2]:")
	fmt.Println(prices[2])

	// A slice is a window into the array. Changing a slice element also changes the array.
	// prices[1:] starts at index 1 and runs to the end, so it holds 9.99, 45.99, 20.0.
	featuredPrices := prices[1:]
	featuredPrices[0] = 199.90
	fmt.Println("\nfeaturedPrices after featuredPrices[0] = 199.90 (the array was changed too):")
	// featuredPrices[:1] keeps only the first element of featuredPrices.
	highlightedPrices := featuredPrices[:1]
	fmt.Println(highlightedPrices)
	fmt.Println("\nOriginal prices array, index 1 now holds 199.9:")
	fmt.Println(prices)

	// len is the number of elements in the slice. cap is how many elements it can reach
	// to the right, counting from its start in the underlying array.
	// Here len is 1 and cap is 3: the slice holds one value, but two more exist to its right.
	fmt.Println("\nLength and capacity of highlightedPrices (length, capacity):")
	fmt.Println(len(highlightedPrices), cap(highlightedPrices))

	// A slice can grow to the right up to its capacity, so [:3] works even though the slice has 1 element.
	// Going left is not possible, the first element of prices is no longer reachable.
	highlightedPrices = highlightedPrices[:3]
	fmt.Println("\nhighlightedPrices after reslicing to [:3] (grows to the right):")
	fmt.Println(highlightedPrices)
	fmt.Println("\nLength and capacity after reslicing (length, capacity):")
	fmt.Println(len(highlightedPrices), cap(highlightedPrices))

	// Dynamic arrays through slices: a slice literal has no fixed size, and append adds elements.
	dynamicPrices := []float64{10.99, 8.99}
	fmt.Println("\nDynamic prices slice, first element:")
	fmt.Println(dynamicPrices[0])
	dynamicPrices[1] = 9.99
	fmt.Println("Dynamic prices slice after dynamicPrices[1] = 9.99, first element:")
	fmt.Println(dynamicPrices[0])

	// append returns a new slice. dynamicPrices has no spare capacity, so append allocates a new array
	// and the original slice is not changed.
	updatedPrices := append(dynamicPrices, 0.99, 12.0)
	fmt.Println("\nupdatedPrices and dynamicPrices after append:")
	fmt.Println(updatedPrices, dynamicPrices)

	// Connecting two slices: append needs the ... operator to unpack the second slice into single elements.
	discountPrices := []float64{10.42, 39.12, 0.12, 3.92}
	allPrices := append(updatedPrices, discountPrices...)
	fmt.Println("All prices including discounted:")
	fmt.Println(allPrices)
}
