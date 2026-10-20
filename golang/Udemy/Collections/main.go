package main

import (
	"collections/arrays"
	"collections/slices"
	"fmt"
)

func main() {
	arrays.Run()
	fmt.Println("")
	slices.Run()
	fmt.Println("")
	slices.RunCapacity()
	fmt.Println("")
	slices.RunLoop()
}
