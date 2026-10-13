package main

import (
	"fmt"
)

func main() {
	resultInt := addDynamic(1, 2)
	resultFloat := addDynamic(5.5, 3.2)
	resultString := addDynamic("Hello", "World")

	fmt.Println("Dynamic Types addition:")
	fmt.Printf("Int Result: %v\nFloat Result: %v\nString Result: %v\n\n", resultInt, resultFloat, resultString)

	resultInt = addGeneric(1, 2)
	resultFloat = addGeneric(5.5, 3.2)
	resultString = addGeneric("Hello", "World")
	fmt.Println("Generic Types addition:")
	fmt.Printf("Int Result: %v\nFloat Result: %v\nString Result: %v\n\n", resultInt, resultFloat, resultString)
}

func addGeneric[T int | float64 | string](a, b T) T {
	return a + b
}

// `interface{}` is the same as `any`
func addDynamic(a, b interface{}) any {
	aInt, aIsInt := a.(int)
	bInt, bIsInt := b.(int)

	if aIsInt && bIsInt {
		return aInt + bInt
	}

	aFloat, aIsFloat := a.(float64)
	bFloat, bIsFloat := b.(float64)

	if aIsFloat && bIsFloat {
		return aFloat + bFloat
	}

	aString, aIsString := a.(string)
	bString, bIsString := b.(string)

	if aIsString && bIsString {
		return aString + bString
	}

	return nil
}
