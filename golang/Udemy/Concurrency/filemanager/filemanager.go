package filemanager

import (
	"bufio"
	"fmt"
	"os"
	"time"
)

// ReadLines returns every line of the file at path.
func ReadLines(path string) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var lines []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	return lines, scanner.Err()
}

// WriteResult writes the lines to the file at path. The sleep simulates a slow disk.
func WriteResult(path string, lines []string) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()

	time.Sleep(3 * time.Second) // simulate a slow file write

	for _, line := range lines {
		if _, err := fmt.Fprintln(file, line); err != nil {
			return err
		}
	}
	return nil
}
