package resp

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strconv"
)

type respTypeError struct {
	expectedType string
	receivedType byte
}

func (e respTypeError) Error() string {
	return fmt.Sprintf("Expected type %s but got %s", e.expectedType, string(e.receivedType))
}

type respByteReader struct {
	// Read from a TCP connection as data arrives. Reuse the same buffered reader for every request on a connection
	stream *bufio.Reader
}

func newRespByteReader(reader *bufio.Reader) *respByteReader {
	return &respByteReader{reader}
}

func (r *respByteReader) expectType(expectedType string) (bool, error) {
	// First peak so the byte gets not consumed if its not the expected type
	actualType, err := r.stream.Peek(1)
	if err != nil {
		return false, err
	}

	if string(actualType) != expectedType {
		return false, respTypeError{expectedType, actualType[0]}
	}
	// Only read/consume if actualType == expectedType
	_, err = r.stream.ReadByte()
	if err != nil {
		return false, err
	}
	return true, nil
}

func (r *respByteReader) expectCRLF() error {
	actualBytes, err := r.stream.Peek(2)
	if err != nil {
		return err
	}
	if string(actualBytes) != "\r\n" {
		return errors.New("expected CRLF")
	}
	_, err = r.stream.ReadBytes('\n')
	if err != nil {
		return err
	}
	return nil
}

func (r *respByteReader) parseIntFromByte() (int, error) {
	// ReadSlice limits the header to the buffered reader's capacity instead of
	// allowing a peer to send an unbounded line. It includes the final '\n'.
	line, err := r.stream.ReadSlice('\n')
	if err != nil {
		if errors.Is(err, io.EOF) {
			return 0, io.ErrUnexpectedEOF
		}
		return 0, fmt.Errorf("reading number header: %w", err)
	}
	if len(line) < 3 || line[len(line)-2] != '\r' {
		return 0, fmt.Errorf("invalid number header: expected digits followed by CRLF")
	}

	digits := line[:len(line)-2]
	for _, digit := range digits {
		if digit < '0' || digit > '9' {
			return 0, fmt.Errorf("invalid non-negative number %q", digits)
		}
	}

	num, err := strconv.Atoi(string(digits))
	if err != nil {
		return 0, fmt.Errorf("invalid number %q: %w", digits, err)
	}

	return num, nil
}

// DecodeRespRequest starts decoding one request from a persistent reader.
// Return decoded command once array and bulk-string decoding are implemented.
func DecodeRespRequest(reader *bufio.Reader) ([]string, error) {
	requestStream := newRespByteReader(reader)

	// expectType waits for the first byte and consumes it only if it is '*'.
	// EOF means the connection closed before a new request started.
	correctType, err := requestStream.expectType(ARRAYS)
	if err != nil || !correctType {
		return []string{}, err
	}

	request, err := requestStream.decodeArrayString()
	if errors.Is(err, io.EOF) {
		return []string{}, io.ErrUnexpectedEOF
	}
	return request, err
}

func (r *respByteReader) decodeBulkString() (string, error) {
	// Expect '$'
	correctType, err := r.expectType(BULK_STRING)
	if err != nil || !correctType {
		return "", err
	}

	// Read byte-length header
	stringLen, err := r.parseIntFromByte()
	if err != nil {
		return "", err
	} else if stringLen <= 0 {
		// Reject null and other unsupported negative lengths.
		return "", errors.New("invalid string length")
	}
	stringBytes := make([]byte, stringLen)

	// Go through the string and catch unexpected CRLF
	for i := range stringLen {
		readByte, err := r.stream.ReadByte()
		if err != nil {
			return "", err
		}
		// Catch unexpected CRLF
		if readByte == '\r' {
			peakByte, err := r.stream.Peek(1)
			if err != nil {
				return "", err
			} else if string(peakByte) != "\n" {
				_, err := r.stream.ReadByte()
				if err != nil {
					return "", err
				}
				return "", io.ErrUnexpectedEOF
			}
		}
		stringBytes[i] = readByte
	}
	return string(stringBytes), nil
}

func (r *respByteReader) decodeArrayString() ([]string, error) {
	// The '*' marker has already been consumed by the caller therefore the next byte has to be the number or arrays
	numArrays, err := r.parseIntFromByte()
	command := make([]string, numArrays)

	if err != nil {
		return command, err
	}

	for range numArrays {
		commandString, err := r.decodeBulkString()
		if err != nil {
			return command, err
		}
		err = r.expectCRLF()
		if err != nil {
			return command, err
		}
		command = append(command, commandString)
	}
	return command, nil
}
