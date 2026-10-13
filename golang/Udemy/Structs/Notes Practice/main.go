package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"notes.practice/note"
)

func main() {
	title, content := getNoteData()

	userNote, err := note.New(title, content)

	if err != nil {
		fmt.Println(err)
		return
	}

	userNote.DisplayNote()
	err = userNote.Save()
	if err != nil {
		fmt.Println("Saving the note failed!")
		return
	}
	fmt.Println("Your note is saved!")
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
