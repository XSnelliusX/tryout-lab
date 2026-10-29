package commands

func (h *Handler) set(command []string) Result {
	if len(command) != 3 {
		return Result{ReplyError, "wrong number of arguments for 'set' command"}
	}

	h.valueStore.Set(command[1], command[2])
	return Result{ReplySimpleString, "OK"}
}
