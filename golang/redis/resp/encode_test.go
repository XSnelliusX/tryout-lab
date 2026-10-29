package resp_test

import (
	"redis/commands"
	"redis/resp"
	"testing"
)

func TestEncodeErrorEscapesLineBreaks(t *testing.T) {
	result := commands.Result{Kind: commands.ReplyError, Value: "unknown command x\r\n+OK"}

	got, err := resp.Encode(result)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "-ERR unknown command x\\r\\n+OK\r\n" {
		t.Errorf("got %q, want one error reply with escaped line breaks", got)
	}
}

func TestEncodeSimpleStringRejectsLineBreaks(t *testing.T) {
	result := commands.Result{Kind: commands.ReplySimpleString, Value: "hello\r\n+OK"}

	got, err := resp.Encode(result)
	if err == nil {
		t.Errorf("got %q without an error, want invalid simple string rejected", got)
	}
}

func TestEncodeRejectsUnsupportedResultKind(t *testing.T) {
	result := commands.Result{Kind: commands.ResultKind(-1)}

	got, err := resp.Encode(result)
	if err == nil {
		t.Errorf("got %q without an error, want unsupported result rejected", got)
	}
}

func TestEncodeReplies(t *testing.T) {
	tests := []struct {
		name   string
		result commands.Result
		want   string
	}{
		{"simple string", commands.Result{Kind: commands.ReplySimpleString, Value: "READY"}, "+READY\r\n"},
		{"error", commands.Result{Kind: commands.ReplyError, Value: "unknown command"}, "-ERR unknown command\r\n"},
		{"empty bulk", commands.Result{Kind: commands.ReplyBulkString, Value: ""}, "$0\r\n\r\n"},
		{"null bulk", commands.Result{Kind: commands.ReplyNoneBulkString}, "$-1\r\n"},
		{"binary bulk", commands.Result{Kind: commands.ReplyBulkString, Value: "é\r\n\x00"}, "$5\r\né\r\n\x00\r\n"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resp.Encode(tt.result)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}
