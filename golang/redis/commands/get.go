package commands

func (h *Handler) get(command []string) Result {
	if len(command) != 2 {
		return Result{ReplyError, "wrong number of arguments for 'get' command"}
	}

	val, exists := h.valueStore.Get(command[1])
	if !exists {
		return Result{ReplyNoneBulkString, ""}
	}
	return Result{ReplyBulkString, val}
}
