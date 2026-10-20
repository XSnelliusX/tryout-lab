package main

import (
	"collections/arrays"
	"collections/maps"
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
	fmt.Println("")
	maps.Run()
	fmt.Println("")
	maps.RunCapacity()
	fmt.Println("")
	maps.RunAlias()
	fmt.Println("")
	maps.RunLoop()
}
