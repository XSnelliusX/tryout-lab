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
	// Only read/consume if its the expected type
	r.stream.ReadByte()
	return true, nil
}

func (s *respByteReader) parseIntFromByte() (int, error) {
	// ReadSlice limits the header to the buffered reader's capacity instead of
	// allowing a peer to send an unbounded line. It includes the final '\n'.
	line, err := s.stream.ReadSlice('\n')
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
// TODO: Return decoded command once array and bulk-string decoding are implemented.
func DecodeRespRequest(reader *bufio.Reader) (string, error) {
	requestStream := newRespByteReader(reader)

	// expectType waits for the first byte and consumes it only if it is '*'.
	// EOF means the connection closed before a new request started.
	correctType, err := requestStream.expectType(ARRAYS)
	if err != nil || !correctType {
		return "", err
	}

	request, err := requestStream.decodeArrayString()
	if errors.Is(err, io.EOF) {
		return "", io.ErrUnexpectedEOF
	}
	return request, err
}

func (s *respByteReader) decodeBulkString() (string, error) {
	// Return (string, error). Expect '$', then read its byte-length header
	// Reject null and other unsupported negative lengths.
	string_len, err := s.parseIntFromByte()
	if err != nil {
		return "", err
	}
	return "", fmt.Errorf("bulk string decoding not implemented (string len: %d)", string_len)
}

func (s *respByteReader) decodeArrayString() (string, error) {
	// The '*' marker has already been consumed by the caller therfore the next byte has to be the number or arrays
	num_arrays, err := s.parseIntFromByte()
	if err != nil {
		return "", err
	}
	// TODO: Use num_arrays to read the elements before returning a request.
	return "", fmt.Errorf("array decoding not implemented (element count: %d)", num_arrays)
}
