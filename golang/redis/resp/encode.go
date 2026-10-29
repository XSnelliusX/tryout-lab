package resp

import (
	"fmt"
	"redis/commands"
)

func Encode(resultObject commands.Result) ([]byte, error) {
	switch resultObject.Kind {
	case commands.ReplyError:
		resultString := fmt.Sprintf("-ERR %s\r\n", resultObject.Value)
		return []byte(resultString), nil
	case commands.ReplyNoneBulkString:
		resultString := fmt.Sprintf("$-1\r\n")
		return []byte(resultString), nil
	case commands.ReplySimpleString:
		resultString := fmt.Sprintf("%s\r\n", resultObject.Value)
		return []byte(resultString), nil
	case commands.ReplyBulkString:
		resultString := fmt.Sprintf("$%d\r\n%s\r\n", len(resultObject.Value), resultObject.Value)
		return []byte(resultString), nil
	}
	return []byte{'$', '-', '1', '\r', '\n'}, nil
}
