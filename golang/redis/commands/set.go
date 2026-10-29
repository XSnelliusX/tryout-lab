package commands

import "errors"

func (h *Handler) set(command []string) (Result, error) {
	if len(command) != 3 {
		return Result{ReplyError, "wrong number of arguments for 'set' command"}, errors.New("wrong number of arguments for 'set' command")
	}

	h.valueStore.Set(command[1], command[2])
	return Result{ReplySimpleString, "OK"}, nil
}
