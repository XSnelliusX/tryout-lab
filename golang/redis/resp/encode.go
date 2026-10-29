package resp

import (
	"fmt"
	"redis/commands"
	"strings"
)

func Encode(resultObject commands.Result) ([]byte, error) {
	switch resultObject.Kind {
	case commands.ReplyError:
		message := strings.NewReplacer("\r", `\r`, "\n", `\n`).Replace(resultObject.Value)
		resultString := fmt.Sprintf("-ERR %s\r\n", message)
		return []byte(resultString), nil
	case commands.ReplyNoneBulkString:
		resultString := fmt.Sprintf("$-1\r\n")
		return []byte(resultString), nil
	case commands.ReplySimpleString:
		if strings.ContainsAny(resultObject.Value, "\r\n") {
			return nil, fmt.Errorf("simple string contains CR or LF")
		}
		resultString := fmt.Sprintf("+%s\r\n", resultObject.Value)
		return []byte(resultString), nil
	case commands.ReplyBulkString:
		resultString := fmt.Sprintf("$%d\r\n%s\r\n", len(resultObject.Value), resultObject.Value)
		return []byte(resultString), nil
	}
	return nil, fmt.Errorf("unsupported reply type: %d", resultObject.Kind)
}
