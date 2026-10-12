package main

import (
	"fmt"
	"math"
)

func main() {
	const inflationRate = 2.5
	var investmentAmount float64
	var years float64
	expectedReturnRate := 5.5

	fmt.Print("Enter the investment Amount: ")
	fmt.Scan(&investmentAmount)

	fmt.Print("Enter years: ")
	fmt.Scan(&years)

	fmt.Print("Enter expected return rate: ")
	fmt.Scan(&expectedReturnRate)

	futureValue := investmentAmount * math.Pow(1+(expectedReturnRate/100), years)
	futureRealValue := futureValue / math.Pow(1+inflationRate/100, years)

	fmt.Println(futureValue)
	fmt.Println(futureRealValue)
}
