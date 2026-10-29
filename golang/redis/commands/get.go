package commands

import "errors"

func (h *Handler) get(command []string) (Result, error) {
	if len(command) != 2 {
		return Result{ReplyError, "wrong number of arguments for 'get' command"},
			errors.New("wrong number of arguments for 'get' command")
	}

	val, exists := h.valueStore.Get(command[1])
	if !exists {
		return Result{ReplyNoneBulkString, ""}, nil
	}
	return Result{ReplyBulkString, val}, nil
}
