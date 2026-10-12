package main

import (
	"fmt"
	"os"
)

/*
	Lesson 27:
		Goal: Calcualte earnings before tax (EBT), profit and ratio
		Input: revenue, expenses & tax rate

	Lesson 36:
		Goal: Split user input and financial calcultion logic into reusable functions

	Lesson 51:
		Goal 1: Validate user input => show error message & exit if invalid input is provided
		Goal 2: Store calculated results into file
*/

const profitsFileName = "profits.txt"

func main() {
	var revenue, expense, taxRate float64

	fmt.Println("Welcome to the Earnings calcualtor")
	fmt.Println("I calcualte earnings before tax (EBT), earnings after tax, profit and ratio")

	revenue = userInput("How much revenue do you have: ")
	if revenue <= 0 {
		fmt.Println("ERROR! Revenue can not be Zero or Negative")
		return
	}

	expense = userInput("How much expenses do you have: ")
	if expense <= 0 {
		fmt.Println("ERROR! Expense can not be Zero or Negative")
		return
	}

	taxRate = userInput("How high is your tax rate: ")
	if taxRate <= 0 {
		fmt.Println("ERROR! Tax rate input can not be Zero or Negative")
		return
	}

	ebt, profit, ratio := calculateOutputs(revenue, expense, taxRate)

	fmt.Println("\n--------------------------")
	fmt.Printf("EBT: %.2f\n", ebt)
	fmt.Printf("Profit: %.2f\n", profit)
	fmt.Printf("Ratio: %.2f\n", ratio)
	fmt.Println("--------------------------")
	err := writeResultsFile(ebt, profit, ratio)
	if err != nil {
		fmt.Println("ERROR: ", err)
	}
	fmt.Println("\nData written to", profitsFileName)
}

func userInput(infoText string) float64 {
	var userInput float64

	fmt.Print(infoText)
	fmt.Scan(&userInput)

	return userInput
}

func calculateOutputs(revenue, expense, taxRate float64) (float64, float64, float64) {
	ebt := revenue - expense
	profit := ebt * (1 - taxRate/100)
	ratio := profit / ebt * 100

	return ebt, profit, ratio
}

func writeResultsFile(ebt, profit, ratio float64) error {
	file, err := os.OpenFile(profitsFileName, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("opening profits file: %w", err)
	}

	_, err = fmt.Fprintf(file, "EBT: %.2f, Profit: %.2f, Ratio: %.2f\n", ebt, profit, ratio)
	file.Close()
	return err
}
