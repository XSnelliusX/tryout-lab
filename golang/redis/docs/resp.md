# RESP (Redis serialization protocol): Wire Format and Parsing

RESP describes how values are encoded as bytes between a client and a server.

> RESP is a binary protocol that uses control sequences encoded in standard ASCII. The A character, for example, is encoded with the binary byte of value 65. Similarly, the characters CR (`\r`), LF (`\n`) and SP (space) have binary byte values of 13, 10 and 32, respectively.

> The `\r\n` (CRLF) is the protocol's terminator, which always separates its parts.

Source: [official Redis Serialization Protocol specification](https://redis.io/docs/latest/develop/reference/protocol-spec/).

The server supports a **subset of RESP2**:

- Decode commands as arrays of bulk strings: the command name followed by its arguments.
- Encode simple-string success replies, bulk-string values, null bulk strings, and simple errors.
- Do not implement a general decoder for every RESP type yet.

TCP provides an ordered byte stream, not message boundaries. A single read can contain part of a command, a complete command, or several commands.

The [traffic capture](redis-traffic.md) shows how these types appear in actual `GET` and `SET` exchanges.
The [decoder](decode.md) and [encoder](encode.md) notes describe how the Go code handles requests and replies.

Examples below show `\r\n` as visible escape sequences. On the wire, each pair means the actual two bytes CR and LF, not four printable characters.

## Simple strings

[Specification: simple strings](https://redis.io/docs/latest/develop/reference/protocol-spec/#simple-strings)

Start with `+`, followed by text and CRLF. Used for short replies such as the acknowledgment from `SET`.

```text
+OK\r\n
```

The text must not contain CR or LF.

## Simple errors

[Specification: simple errors](https://redis.io/docs/latest/develop/reference/protocol-spec/#simple-errors)

Start with `-`, followed by an error message and CRLF. The message must not contain CR or LF.

```text
-ERR unknown command\r\n
```

## Bulk strings

[Specification: bulk strings](https://redis.io/docs/latest/develop/reference/protocol-spec/#bulk-strings)

Format: `$<byte-length>\r\n<data>\r\n`.

```text
$5\r\nhello\r\n
```

- Lengths count **bytes**, not Unicode characters. In Go, `len(s)` counts the bytes of a string.
- Payloads may contain spaces, CRLF, or arbitrary binary bytes. Their length determines where they end, not their contents.
- An empty string is `$0\r\n\r\n`.

## Null bulk strings

[Specification: null bulk strings](https://redis.io/docs/latest/develop/reference/protocol-spec/#null-bulk-strings)

A bulk-string length of `-1` represents a missing value in RESP2, such as a `GET` for a key that does not exist.

```text
$-1\r\n
```

There is no payload or additional CRLF after this header. It is different from an existing empty string.

## Arrays

[Specification: arrays](https://redis.io/docs/latest/develop/reference/protocol-spec/#arrays)

Format: `*<element-count>\r\n<elements>`. Each element has its own RESP encoding.

Redis command requests are arrays of bulk strings: command name first, then arguments. For `GET greeting`:

```text
*2\r\n$3\r\nGET\r\n$8\r\ngreeting\r\n
```

The count includes the command name. The [captured SET request](redis-traffic.md#observed-requests-and-replies) has three elements: `SET`, `greeting`, and `hello`.
