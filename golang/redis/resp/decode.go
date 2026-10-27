package resp

import "bufio"

func DecodeRespRequest(reader *bufio.Reader) (string, error) {
	// Need to read the first byte before the reader loop, else there is an infinit loop
	firstByte, err := reader.ReadByte()
	if err != nil {
		return "", err
	}

	requestString := string(firstByte)

	// Only drain bytes that are already buffered.
	for reader.Buffered() > 0 {
		b, err := reader.ReadByte()
		if err != nil {
			return "", err
		}
		requestString += string(b)
	}

	return requestString, nil
}
