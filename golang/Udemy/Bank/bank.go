package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"
)

const accountBalanceFile = "balance.txt"

func writeBalanceToFile(balance float64) {
	balanceString := fmt.Sprint(balance)

	os.WriteFile(accountBalanceFile, []byte(balanceString), 0644)
}

func getBalanceFromFile() (float64, error) {
	data, err := os.ReadFile(accountBalanceFile)

	if err != nil {
		return 1000, errors.New("Failed to read file!")
	}

	balanceText := string(data)
	balance, err := strconv.ParseFloat(balanceText, 64)

	if err != nil {
		return 1000, errors.New("Failed to parse balance file")
	}

	return balance, nil
}

func main() {
	var accountBalance, err = getBalanceFromFile()

	if err != nil {
		fmt.Print("-------------------")
		fmt.Print("ERROR")
		fmt.Print(err)
		fmt.Print("-------------------")
	}

	fmt.Println("Welcome to Go Bank!")

	for {
		fmt.Println("\nWhat do you wnat to do?")
		fmt.Println("1. Check Balance")
		fmt.Println("2. Deposit Money")
		fmt.Println("3. Withdraw Money")
		fmt.Println("4. Exit")

		var choice int
		fmt.Print("Your choice: ")
		fmt.Scan(&choice)

		switch choice {
		case 1:
			fmt.Println("Your balance is ", accountBalance)
		case 2:
			fmt.Print("How much do you want to doposit: ")
			var depositAmount float64
			fmt.Scan(&depositAmount)

			if depositAmount <= 0 {
				fmt.Println("Deposit amount can not be negative!")
				continue
			}

			accountBalance += depositAmount
			fmt.Println("Your new Balance is: ", accountBalance)
			writeBalanceToFile(accountBalance)
		case 3:
			fmt.Print("How much do you want to withdraw: ")
			var withdrawlAmount float64
			fmt.Scan(&withdrawlAmount)

			if withdrawlAmount <= 0 {
				fmt.Println("Withdrawl amount can not be negative!")
				continue
			} else if withdrawlAmount > accountBalance {
				fmt.Println("You cant withdraw more then your balance!")
				continue
			}

			accountBalance -= withdrawlAmount
			fmt.Println("Your new Balance is: ", accountBalance)
		default:
			fmt.Println("Goodbye!")
			fmt.Println("")
			return
		}
	}
}
