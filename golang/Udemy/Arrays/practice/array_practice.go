package main

import (
	"fmt"
)

// 7.1) Bonus: Create a "Product" struct with title, id, price
type Product struct {
	title string
	id    int
	price float64
}

func main() {
	// 1) Create a new array (!) that contains three hobbies you have
	// 	  Output (print) that array in the command line.
	hobbies := [3]string{"Chess", "Piano", "Coding"}
	fmt.Println("My Hobbies:", hobbies)

	// 2) Output more data about that array:
	//	  - The first element (standalone)
	//	  - The second and third element combined as a new list
	fmt.Println("First Hobby:", hobbies[0])
	fmt.Println("2nd & 3rd Hobby:", hobbies[1:])

	// 3) Create a slice based on the first element that contains the first and second elements.
	//	  Create that slice in two different ways (i.e. create two slices in the end)
	someHobbies := hobbies[:2]
	fmt.Println("Sliced 1st & 2nd Hobby (implicit start):", someHobbies)
	sameHobbies := hobbies[0:2]
	fmt.Println("Sliced 1st & 2nd Hobby (explicit start):", sameHobbies)

	// 4) Re-slice the slice from (3) and change it to contain the second
	//		and last element of the original array.
	someHobbies = hobbies[1:3]
	fmt.Println("Resliced 2nd & 3rd Hobby:", someHobbies)

	// 5) Create a "dynamic array" that contains your course goals (at least 2 goals)
	goals := []string{"Learn Go basics", "Understand Go syntax"}
	fmt.Println("My course goals:", goals)

	// 6) Set the second goal to a different one AND then add a third goal to that existing dynamic array
	goals[1] = "Get to know goroutines"
	goals = append(goals, "Understand Syntax")
	fmt.Println("My updated course goals:", goals)

	// 7.2) Create a dynamic list of products (at least 2 products), then add a third product to the existing list of products.
	products := []Product{
		{"Tea", 1, 1.99},
		{"Juice", 2, 2.35},
	}
	fmt.Println("My Products:", products)

	products = append(products, Product{"Water", 3, 0.99})
	fmt.Println("All my Products:", products)
}
