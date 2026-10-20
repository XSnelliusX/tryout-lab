package slices

import "fmt"

// Run demonstrates slice literals, sharing memory with the underlying array,
// len/cap, reslicing and append.
func Run() {
	prices := [4]float64{10.99, 9.99, 45.99, 20.0}

	fmt.Println("--- Slices ---")
	// A slice is a window into the array. Changing a slice element also changes the array.
	// prices[1:] starts at index 1 and runs to the end, so it holds 9.99, 45.99, 20.0.
	featuredPrices := prices[1:]
	featuredPrices[0] = 199.90
	fmt.Println("featuredPrices (prices[1:]) after featuredPrices[0] = 199.90 (the array was changed too):")
	fmt.Println(featuredPrices)
	fmt.Println("Original prices array, index 1 now holds 199.9:")
	fmt.Println(prices)

	// featuredPrices[:1] keeps only the first element of featuredPrices.
	highlightedPrices := featuredPrices[:1]
	fmt.Println("highlightedPrices (featuredPrices[:1]):")
	fmt.Println(highlightedPrices)

	// len is the number of elements in the slice. cap is how many elements it can reach
	// to the right, counting from its start in the underlying array.
	// Here len is 1 and cap is 3: the slice holds one value, but two more exist to its right.
	fmt.Println("Length and capacity of highlightedPrices (length, capacity):")
	fmt.Println(len(highlightedPrices), cap(highlightedPrices))

	// A slice can grow to the right up to its capacity, so [:3] works even though the slice has 1 element.
	// Going left is not possible, the first element of prices is no longer reachable.
	highlightedPrices = highlightedPrices[:3]
	fmt.Println("highlightedPrices after reslicing to [:3] (grows to the right):")
	fmt.Println(highlightedPrices)
	fmt.Println("Length and capacity after reslicing (length, capacity):")
	fmt.Println(len(highlightedPrices), cap(highlightedPrices))

	// Dynamic arrays through slices: a slice literal has no fixed size, and append adds elements.
	dynamicPrices := []float64{10.99, 8.99}
	fmt.Println("Dynamic prices slice, first element:")
	fmt.Println(dynamicPrices[0])
	dynamicPrices[1] = 9.99
	fmt.Println("Dynamic prices slice after dynamicPrices[1] = 9.99, first element:")
	fmt.Println(dynamicPrices[0])

	// append returns a new slice. dynamicPrices has no spare capacity, so append allocates a new array
	// and the original slice is not changed.
	updatedPrices := append(dynamicPrices, 0.99, 12.0)
	fmt.Println("updatedPrices and dynamicPrices after append (original slice is unchanged):")
	fmt.Println(updatedPrices, dynamicPrices)

	// Connecting two slices: append needs the ... operator to unpack the second slice into single elements.
	discountPrices := []float64{10.42, 39.12, 0.12, 3.92}
	allPrices := append(updatedPrices, discountPrices...)
	fmt.Println("All prices including discounted:")
	fmt.Println(allPrices)
}

// RunCapacity demonstrates pre-allocating slice capacity with make.
func RunCapacity() {
	fmt.Println("--- Slice capacity with make ---")
	// Reserve capacity for the two usernames we plan to append.
	// make([]string, 0, 5) creates a length-0 slice whose underlying array
	// has room for 5 elements, so these appends don't reallocate.
	userNames := make([]string, 0, 5)

	userNames = append(userNames, "Max")
	userNames = append(userNames, "Manuel")

	fmt.Println("userNames after two appends:")
	fmt.Println(userNames)
	fmt.Println("Length and capacity of userNames (length, capacity):")
	fmt.Println(len(userNames), cap(userNames))
}

// RunLoop demonstrates for-range loops over a slice.
func RunLoop() {
	fmt.Println("--- for range over a slice ---")

	// A slice made with make, containing two empty slots at the front
	// to show that range visits every slot, empty or not.
	userNames := make([]string, 2, 5)
	userNames[0] = "Julie"
	userNames = append(userNames, "Max", "Manuel")

	// range exposes two values per iteration: the index and the value at
	// that index. The names are up to you (i, val or anything else).
	// The syntax is the same whether the slice was created with make or not.
	for index, value := range userNames {
		fmt.Println("Index:", index, "Value:", value)
	}
}
