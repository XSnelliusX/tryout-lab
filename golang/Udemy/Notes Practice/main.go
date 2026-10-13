package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"notes.practice/note"
	"notes.practice/todo"
)

type saver interface {
	Save() error
}

type outputable interface {
	saver
	Display()
}

func main() {
	title, content := getNoteData()
	todoText := getUserInput("Todo Text: ")

	todo, err := todo.New(todoText)
	err = outputData(todo)

	if err != nil {
		return
	}

	userNote, err := note.New(title, content)

	if err != nil {
		fmt.Println(err)
		return
	}

	err = outputData(userNote)

	if err != nil {
		return
	}
}

func outputData(data outputable) error {
	data.Display()
	return saveData(data)
}

func saveData(data saver) error {
	err := data.Save()
	if err != nil {
		fmt.Println("Saving the note failed!")
		return err
	}
	fmt.Println("Your note is saved!")
	return nil
}

func getNoteData() (string, string) {
	title := getUserInput("Note title: ")
	content := getUserInput("Note content: ")

	return title, content
}

func getUserInput(prompt string) string {
	fmt.Print(prompt)

	// Since Scan only works for single word input `fmt.Scanln()` can not be used here
	reader := bufio.NewReader(os.Stdin)
	text, err := reader.ReadString('\n')

	if err != nil {
		text = ""
	}

	text = strings.TrimSuffix(text, "\n")
	text = strings.TrimSuffix(text, "\r")

	return text
}
