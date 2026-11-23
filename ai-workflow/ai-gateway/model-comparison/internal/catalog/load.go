package catalog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// GlobalName is the browser global the JS snapshot assigns. The dashboard reads
// it so it works when opened from file:// (no fetch of a JSON file).
const GlobalName = "__MODEL_COMPARISON__"

// LoadEnrichedFile reads and validates a parse_aa.mjs output file.
func LoadEnrichedFile(path string) (EnrichedFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return EnrichedFile{}, fmt.Errorf("read enriched AA file %s: %w", path, err)
	}
	var file EnrichedFile
	if err := json.Unmarshal(data, &file); err != nil {
		return EnrichedFile{}, fmt.Errorf("decode enriched AA file %s: %w", path, err)
	}
	if len(file.Rows) == 0 {
		return EnrichedFile{}, fmt.Errorf("enriched AA file %s has no rows", path)
	}
	return file, nil
}

// Encode renders the snapshot as plain JSON ("json") or as a classic script
// that assigns it to window.__MODEL_COMPARISON__ ("js").
func Encode(snap Snapshot, format string) ([]byte, error) {
	data, err := json.MarshalIndent(snap, "", " ")
	if err != nil {
		return nil, fmt.Errorf("encode snapshot: %w", err)
	}
	switch format {
	case "json":
		return append(data, '\n'), nil
	case "js":
		out := []byte("window." + GlobalName + " = ")
		out = append(out, data...)
		return append(out, ";\n"...), nil
	}
	return nil, fmt.Errorf("unknown format %q (want js or json)", format)
}

// WriteFile atomically replaces path with data.
func WriteFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".aasync-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary file: %w", err)
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write snapshot: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
